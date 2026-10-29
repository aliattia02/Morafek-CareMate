"""
backend/utils/consent_history.py
─────────────────────────────────────────────────────────────────────────────
Helpers for three collections layered on top of the existing consent
pipeline (see docs/consent-gics-gpas-reference.md,
docs/data-store-separation-reference.md, and docs/admin-routes-plan.md):

  consent_history      — append-only grant/revoke intervals, keyed by gPAS
                          pseudonym. Lets a future sync job decide whether a
                          given reading's recorded_at fell inside an active
                          consent window, instead of only knowing "is consent
                          active right now."
  patient_identifiers   — one doc per patient, holding data this app needs
                          that doesn't belong in `users` or `patient_consents`.
                          THIS PASS only populates `doctor_sharing`.
                          `gics_consent_status` / `research_pseudonym` /
                          `research_eligible` are reserved for the deferred
                          sync-job phase — see NOT YET POPULATED below.
  sync_issues           — added 2026-08-11 (admin-routes-plan.md §1). One
                          open document per (patient_id, issue_type),
                          upserted rather than appended, tracking standing
                          sync-job problems (a patient stuck research_eligible
                          with no patient_consents.pseudonym yet; a patient
                          whose gICS query keeps failing across multiple
                          syncs) that a per-run log line or stat can't
                          surface on its own. Self-healing — resolved the
                          moment a later sync no longer sees the condition.
                          Read by GET /api/admin/sync-issues
                          (backend/routes/admin_routes.py).

Design note — patient_id, not "uuid"
─────────────────────────────────────
The original data-store-separation spec described `patient_identifiers.uuid`
as a locally-generated app identity that "never touches gPAS." In the real
codebase there's no separate local UUID — every other collection
(`users`, `patient_consents`, `patient_fhir_identifiers`, all `vitals_*`
collections) already keys identified data on `str(users._id)` as
`patient_id`. Introducing a second identity field here would just create a
new thing to keep in sync for no benefit, so `patient_identifiers` keys on
`patient_id` like everything else. Nothing about the pseudonym/consent
separation this collection exists for depends on which identity field name
is used — only on `research_pseudonym`/`consent_history.pseudonym` never
appearing next to vitals content.

NOT YET POPULATED (deferred — sync phase)
───────────────────────────────────────────────
`gics_consent_status`, `research_pseudonym`, and `research_eligible` are
part of the target schema but nothing in this pass writes them. They will be
populated by the researcher-triggered sync described in
data-store-separation-reference.md §4/§7.3 (on-demand, not scheduled) when
that's built. Until then, don't read them for anything — they simply won't
exist on documents this pass creates.

Author: Morafek CareMate Team
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─── consent_history ───────────────────────────────────────────────────────
#
# One row per grant/revoke interval, keyed by pseudonym (not patient_id) —
# see data-store-separation-reference.md §2.2 / §3. A patient can have many
# rows under the SAME pseudonym (grant → revoke → re-grant, since gPAS's
# get_or_create_pseudonym is idempotent), or — only via admin/facility
# reactivation — rows under a genuinely different pseudonym.
#
# Wired into exactly the three strict routes in consent_routes.py that the
# reference doc identifies as the write sites: accept_consent(),
# revoke_consent_strict(), admin_reactivate_consent(). Legacy
# /api/patient/consent grant/revoke are intentionally NOT wired — they're
# kept only for backward compatibility with the inline export card, and
# wiring them too would mean tracking intervals against a pseudonym that
# route doesn't reliably create the same way (soft gpas.get_or_create(),
# not the strict idempotent gpas.get_or_create_pseudonym()). If the legacy
# routes turn out to still be in active use, revisit this.

def open_consent_interval(db: Any, pseudonym: Optional[str]) -> None:
    """
    Open a new active interval for `pseudonym`, unless one is already open.

    No-op if `pseudonym` is falsy (e.g. GPAS_ENABLED=false — there's no
    pseudonym to track an interval against).

    Idempotent by design: accept_consent()'s own idempotency guard
    (gics.get_consent_status() already ACCEPTED → skip add_consent) can
    still reach this call on a retry; without the "already open" check that
    would append a duplicate interval every time a patient re-opens the
    consent screen while already accepted.
    """
    if not pseudonym:
        return

    already_open = db.consent_history.find_one(
        {"pseudonym": pseudonym, "revoked_at": None}
    )
    if already_open:
        return

    db.consent_history.insert_one({
        "pseudonym":   pseudonym,
        "granted_at":  _now_iso(),
        "revoked_at":  None,
    })


def close_consent_interval(db: Any, pseudonym: Optional[str]) -> None:
    """
    Close whichever interval is currently open for `pseudonym`.

    No-op if `pseudonym` is falsy, or if there is no open interval — mirrors
    gics.revoke_consent()'s own tolerance of "nothing to revoke" being a
    success case, rather than raising.
    """
    if not pseudonym:
        return

    db.consent_history.update_one(
        {"pseudonym": pseudonym, "revoked_at": None},
        {"$set": {"revoked_at": _now_iso()}},
    )


def get_consent_intervals(db: Any, pseudonym: Optional[str]) -> list[dict]:
    """
    Return all grant/revoke intervals for `pseudonym`, oldest first.

    Each item: {"granted_at": iso str, "revoked_at": iso str | None}.
    Empty list if `pseudonym` is falsy or has no history — callers (e.g.
    research_mirror.mirror_patient_vitals) treat that as "nothing to mirror."
    """
    if not pseudonym:
        return []

    cursor = db.consent_history.find(
        {"pseudonym": pseudonym},
        {"_id": 0, "granted_at": 1, "revoked_at": 1},
    ).sort("granted_at", 1)
    return list(cursor)


# ─── patient_identifiers.doctor_sharing ────────────────────────────────────
#
# Patient-controlled, independent of gICS/gPAS research consent entirely
# (see patient_journeys.svg §3: "No gICS involved — plain MongoDB flag,
# independent of research consent"). Lives in the new patient_identifiers
# collection per the chosen schema location.
#
# DEFAULT BEHAVIOUR — read this before shipping:
# get_doctor_sharing() defaults to True when no patient_identifiers doc
# exists yet (i.e. every existing patient today, and every new patient until
# they first touch the toggle). This was chosen so that shipping this
# feature does NOT silently cut off doctor access for the entire existing
# patient base the moment check_doctor_patient_access() starts consulting
# it — doctor access today has no such gate at all, so a default of False
# would be a breaking change disguised as an additive one.
# If the intent is actually opt-in (share nothing until the patient
# explicitly turns it on), flip DEFAULT_DOCTOR_SHARING to False — that's a
# one-line change here, but confirm it's intentional first since it will
# immediately affect every doctor's patient list.

DEFAULT_DOCTOR_SHARING = True


def get_doctor_sharing(db: Any, patient_id: str) -> bool:
    """Return the patient's current doctor-sharing preference.

    Returns DEFAULT_DOCTOR_SHARING if the patient has no patient_identifiers
    doc yet, or has one but has never set the field explicitly.
    """
    doc = db.patient_identifiers.find_one(
        {"patient_id": patient_id}, {"doctor_sharing": 1}
    )
    if doc is None or "doctor_sharing" not in doc:
        return DEFAULT_DOCTOR_SHARING
    return bool(doc["doctor_sharing"])


def set_doctor_sharing(db: Any, patient_id: str, enabled: bool) -> None:
    """Upsert the patient's doctor-sharing preference."""
    db.patient_identifiers.update_one(
        {"patient_id": patient_id},
        {"$set": {"patient_id": patient_id, "doctor_sharing": bool(enabled)}},
        upsert=True,
    )


# ─── sync_issues ────────────────────────────────────────────────────────────
#
# Added 2026-08-11 (admin-routes-plan.md §1-2). Persistent, self-healing
# record of standing sync-job problems — distinct from research_sync_log
# (research_routes.py), which is a per-run snapshot: it captures errors[]
# for one sync and is never read back by later syncs. sync_issues tracks
# conditions that persist ACROSS runs until something external changes them
# (a patient's pseudonym gets created, gICS becomes reachable again for a
# specific patient), so an admin can see standing problems — via
# GET /api/admin/sync-issues (backend/routes/admin_routes.py) — without
# diffing consecutive sync responses by hand.
#
# One open document per (patient_id, issue_type) — upserted, not appended,
# since this tracks *current state*, not a history of events (contrast
# consent_history above, which is append-only by design because every row
# there is a real, individually-meaningful event). `occurrence_count`
# increments on every re-flag of an already-open issue, so a *repeated*
# failure — e.g. a patient whose gICS query keeps failing sync after
# sync — is visible as a number, not something the reader has to infer by
# comparing detected_at against last_seen_at.
#
# Concurrency note: flag_sync_issue() does a read-then-write, not an atomic
# single update. Fine given how this is called — from the researcher-
# triggered, one-at-a-time sync job (§7.3), not a concurrent hot path — but
# worth knowing if this collection is ever written from somewhere else too.

def flag_sync_issue(
    db: Any,
    patient_id: str,
    issue_type: str,
    context: Optional[dict] = None,
) -> None:
    """
    Flag (or re-flag) an open issue for `patient_id`/`issue_type`.

    If an open issue already exists, bumps `last_seen_at`, replaces
    `context` with the latest detail, and increments `occurrence_count` —
    this is what makes a *repeated* problem visible as a growing number
    instead of just a re-logged warning. If the issue was previously
    resolved (or has never existed), opens a fresh one with
    `occurrence_count = 1` and a new `detected_at`.
    """
    now = _now_iso()
    existing = db.sync_issues.find_one(
        {"patient_id": patient_id, "issue_type": issue_type}
    )

    if existing and existing.get("resolved_at") is None:
        db.sync_issues.update_one(
            {"_id": existing["_id"]},
            {
                "$set": {"last_seen_at": now, "context": context or {}},
                "$inc": {"occurrence_count": 1},
            },
        )
        return

    db.sync_issues.update_one(
        {"patient_id": patient_id, "issue_type": issue_type},
        {
            "$set": {
                "patient_id": patient_id,
                "issue_type": issue_type,
                "detected_at": now,
                "last_seen_at": now,
                "resolved_at": None,
                "context": context or {},
                "occurrence_count": 1,
            },
        },
        upsert=True,
    )


def resolve_sync_issue(db: Any, patient_id: str, issue_type: str) -> None:
    """
    Close whichever open issue exists for `patient_id`/`issue_type`.

    No-op if there is none — mirrors close_consent_interval()'s tolerance
    of "nothing to resolve" being a success case, not an error. Leaves
    `occurrence_count` and `detected_at` on the closed document as a
    historical record of how long/how often it was open; a later
    flag_sync_issue() call for the same pair starts a fresh episode
    (`occurrence_count` reset to 1) rather than continuing the old count.
    """
    db.sync_issues.update_one(
        {"patient_id": patient_id, "issue_type": issue_type, "resolved_at": None},
        {"$set": {"resolved_at": _now_iso()}},
    )