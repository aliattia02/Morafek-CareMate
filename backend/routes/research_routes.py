"""
backend/routes/research_routes.py
─────────────────────────────────────────────────────────────────────────────
Research data access and consent-status sync.

Phase 2 implementation (data-store-separation-reference.md §4 & §7.3):
  • Researcher-triggered on-demand sync job to refresh research_eligible flag
    from live gICS consent status (replaces the original "hourly" proposal)
  • Scoped researcher authorization to isolate this endpoint
  • Sync job updates patient_identifiers for all patients in one pass

Phase 2.5 addition (data-store-separation-reference.md §1.1 & §4):
  • The same sync pass now also mirrors vitals into `research_vitals` for
    every patient who is currently research_eligible, keyed by
    research_pseudonym instead of patient_id. See utils/research_mirror.py
    for the de-identification + interval-matching logic — this file only
    wires it into the per-patient loop below.

Fixed 2026-08-11 — UNKNOWN-status mapping (data-store-separation-reference.md
§2.1's open question):
  • gics_service.get_consent_status() collapsed four distinct situations
    into a single "UNKNOWN" string: gICS unreachable, a non-"not found"
    SOAP fault, an unparseable response, AND a genuine "no consent record
    for this patient" answer. Because it never raises, the try/except
    around the per-patient loop below could not tell a real gICS failure
    apart from a legitimate "patient hasn't consented" — every failure
    was silently written as research_eligible=False and counted as a
    normal state change, never as an error, contradicting the "gICS
    FAILURES" policy already documented (inaccurately) below.
  • Fix: gics_service now exposes get_consent_status_detailed(), which
    returns {"status", "ok", "error"} and keeps that distinction. This
    file now uses it — a failed query (ok=False) is recorded in
    error_count/errors[] and leaves that patient's research_eligible
    untouched; only a genuine no-record UNKNOWN (ok=True) is mapped to
    research_eligible=False, same as REJECTED. get_consent_status() itself
    is unchanged and still collapses everything to a plain string, since
    every other caller (accept_consent()'s idempotency check, GET
    /api/consent/status, diagnose_consent_stack()) is written to treat
    "gICS down" and "no consent on record" the same way on purpose.

Added 2026-08-11 — persistent sync-issue tracking (admin-routes-plan.md §1-2):
  • Two standing problems used to be visible only as a log line or a
    per-run stat that vanishes once the next sync overwrites it: (a) a
    research_eligible patient with no patient_consents.pseudonym yet, so
    mirroring is silently skipped for them every run; (b) a patient whose
    gICS query keeps failing (ok=False) across multiple syncs, which
    error_count/errors[] shows for one run but doesn't distinguish from a
    one-off blip.
  • Fix: utils/consent_history.py now has flag_sync_issue()/
    resolve_sync_issue(), writing to a new `sync_issues` collection —
    one open document per (patient_id, issue_type), self-healing (cleared
    the moment a later sync no longer sees the condition), with an
    occurrence_count that increments on every re-flag so a *repeated*
    failure is visible as a number, not just inferred from timestamps.
    This file calls both for "missing_pseudonym" and "gics_query_failure".
  • Also added `no_pseudonym_count` to the sync response/stats, next to
    error_count, closing the specific gap data-store-separation-reference.md
    §2.4 flagged. See admin-routes-plan.md for the full design and the new
    GET /api/admin/sync-issues endpoint that reads this collection.

Routes
──────
POST   /api/research/sync                    researcher  — sync consent status
GET    /api/research/sync/status              researcher  — last sync timestamp

MongoDB collections touched
────────────────────────────
patient_identifiers:  ← research_eligible, gics_consent_status, research_pseudonym
patient_consents:     ← read-only, sourced for research_pseudonym (canonical field)
consent_history:      ← read-only, consulted for interval logic (via research_mirror)
research_vitals:      ← written by research_mirror.mirror_patient_vitals()

Design decisions
────────────────
SYNC TRIGGER      : Researcher-triggered on-demand via POST /api/research/sync,
                   NOT a scheduled background job. The sync response includes
                   overall success/failure + per-patient status breakdown.

gICS FAILURES      : Hard errors (502) if gICS is completely unreachable
                   before the per-patient loop starts (Step 2 availability
                   check). If reachable but an individual patient's query
                   fails — transport error, a SOAP fault that isn't "not
                   found", or an unparseable response —
                   get_consent_status_detailed() reports ok=False and that
                   patient's research_eligible / gics_consent_status are
                   left unchanged, not cleared; the failure goes into
                   error_count / errors[] instead of being treated as a
                   state change. (This is a deliberate choice — see §5.2
                   "Partial failure". Actually enforced as of 2026-08-11 —
                   previously get_consent_status() swallowed the
                   distinction and this fell through to "unchanged"
                   silently writing False. See the fix note above.)

RESEARCH_ELIGIBLE  : Derived from gICS status, once the query itself has
                   succeeded (see gICS FAILURES above — a failed query
                   never reaches this mapping):
                     • ACCEPTED → research_eligible = true
                     • REJECTED / REVOKED → research_eligible = false
                     • UNKNOWN (gICS confirms no consent record exists
                       for this patient yet — not a failed call) →
                       research_eligible = false, same as REJECTED —
                       there's nothing to be eligible for until the
                       patient actually consents.
                   Normalisation of REVOKED → REJECTED happens in gICS layer.

gPAS NOT TOUCHED   : Sync only refreshes the research_eligible flag and
                   gics_consent_status snapshot. It does NOT call gPAS or
                   delete pseudonyms. research_pseudonym is read from
                   patient_consents.pseudonym (already created by the
                   consent-accept flow), never freshly minted here.

VITALS MIRRORING   : Only patients currently research_eligible have anything
                   to mirror — an ineligible patient's consent_history has
                   no open interval, so mirror_patient_vitals() would be a
                   guaranteed no-op for them. The lookup is skipped entirely
                   for ineligible patients to avoid the wasted query. A
                   mirroring failure for one patient is caught by the same
                   per-patient except Exception as the eligibility check, so
                   it can't fail the whole sync.

IDEMPOTENCY        : Calling sync twice in a row (e.g. accidental double-click)
                   is safe — second call will see the same gICS status and
                   update-one will succeed idempotently. Response will show
                   "unchanged" for patients who didn't change state, and
                   research_vitals mirroring is itself idempotent (upsert on
                   research_pseudonym + source_collection + source_observation_id).

Author: Morafek CareMate Team
─────────────────────────────────────────────────────────────────────────────
"""

from flask import Blueprint, jsonify, current_app
from datetime import datetime, timezone
from typing import Any, Optional
import logging

from utils.auth import token_required
from utils.error_handler import api_error_handler
from config import mongo

logger = logging.getLogger(__name__)
research_routes = Blueprint('research_routes', __name__)


# ─── Helpers ───────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    """Return current UTC time as ISO 8601 string."""
    return datetime.now(timezone.utc).isoformat()


def _normalize_gics_status(raw_status: str) -> str:
    """
    Normalise gICS status to canonical form.

    gICS returns: "ACCEPTED", "REJECTED", or "REVOKED"
    Researchers only care about yes/no, so we normalise REVOKED → "REJECTED"
    (both mean "no consent").
    """
    if not raw_status:
        return "UNKNOWN"
    norm = raw_status.strip().upper()
    if norm == "REVOKED":
        return "REJECTED"
    return norm


def _is_researcher(current_user: dict) -> bool:
    """Check if the current user is a researcher."""
    return current_user.get('user_type') == 'researcher'


def _check_researcher_auth(current_user: dict) -> tuple[bool, Any, int]:
    """
    Check researcher authorization.
    Returns (is_authorized, error_response, status_code).
    """
    if not _is_researcher(current_user):
        return False, {'message': 'Researcher access only'}, 403
    return True, None, None


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/research/sync  — researcher-triggered consent status sync job
# ─────────────────────────────────────────────────────────────────────────────

@research_routes.route('/api/research/sync', methods=['POST'])
@token_required
@api_error_handler
def sync_research_consent_status(current_user):
    """
    POST /api/research/sync — refresh research_eligible flag for all patients
    from live gICS consent status, and mirror vitals for eligible patients
    into research_vitals (Phase 2.5).

    This is the researcher-triggered on-demand sync job described in
    data-store-separation-reference.md §7.3. Called before the researcher
    imports a dataset or starts a work session to ensure fresh eligibility
    status and up-to-date mirrored vitals.

    Response
    ────────
    {
      "synced_at":         ISO datetime,
      "synced_by":         researcher_id,
      "total_patients":    int (all patients in DB),
      "processing_count":  int (patients where gICS was queried),
      "error_count":       int (patients where gICS call failed),
      "newly_eligible":    int (status changed from false → true),
      "newly_ineligible":  int (status changed from true → false),
      "unchanged":         int (status already matched gICS),
      "vitals_mirrored":   int (readings newly copied into research_vitals),
      "vitals_considered": int (readings evaluated across all eligible patients),
      "no_pseudonym_count": int (eligible patients with no patient_consents.pseudonym yet — mirroring skipped for them this run; see sync_issues via GET /api/admin/sync-issues for the persistent view),
      "errors":            [{ patient_id, gics_error }, …],
      "duration_seconds":  float
    }

    Failure modes
    ─────────────
    • 403 if not a researcher
    • 502 if gICS is completely unreachable (gics service hard failure)
    • 200 with partial errors if gICS is reachable but individual
      patient queries (or vitals mirroring) fail (see error_count and
      errors[] in response)
    """
    # ─── Auth ─────────────────────────────────────────────────────────────────
    authorized, error_response, status = _check_researcher_auth(current_user)
    if not authorized:
        return jsonify(error_response), status

    researcher_id = str(current_user['_id'])
    db = current_app.mongo.db
    start_time = datetime.now(timezone.utc)
    start_timestamp = _now_iso()

    logger.info("research sync initiated by researcher %s", researcher_id)

    # ─── Step 1: Fetch all patients ────────────────────────────────────────────
    all_patients = list(db.users.find(
        {"user_type": "patient"},
        {"_id": 1}
    ))
    total_patients = len(all_patients)
    patient_ids = [str(p['_id']) for p in all_patients]

    logger.info(f"sync: found {total_patients} patients to process")

    # ─── Step 2: Verify gICS is reachable before proceeding ───────────────────
    from services.gics_service import gics
    from utils.research_mirror import mirror_patient_vitals
    from utils.consent_history import flag_sync_issue, resolve_sync_issue
    template_id = current_app.config.get('CONSENT_TEMPLATE_ID', 'morafek-data-sharing')

    try:
        is_reachable = gics.is_available()
        if not is_reachable:
            logger.error("research sync: gICS is unreachable")
            return jsonify({
                'error': 'gICS service unreachable',
                'reason': 'Cannot proceed with sync — gICS is the source of truth for research consent'
            }), 502
    except Exception as exc:
        logger.error(f"research sync: gICS availability check failed: {exc}")
        return jsonify({
            'error': 'gICS service check failed',
            'gics_error': str(exc)
        }), 502

    # ─── Step 3: Query each patient's gICS consent status ──────────────────────
    stats = {
        "processing_count": 0,
        "error_count": 0,
        "newly_eligible": 0,
        "newly_ineligible": 0,
        "unchanged": 0,
        "vitals_mirrored": 0,     # new — readings newly copied into research_vitals
        "vitals_considered": 0,   # new — readings evaluated across all eligible patients
        "no_pseudonym_count": 0,  # new — eligible patients with no patient_consents.pseudonym yet
        "errors": [],
    }

    for patient_id in patient_ids:
        try:
            # Get current gICS status via the detailed variant so a real
            # gICS failure (unreachable, a non-"not found" SOAP fault, or
            # an unparseable response) can be told apart from a genuine
            # "no consent record yet" UNKNOWN. See gics_service.py::
            # get_consent_status_detailed() and the "RESEARCH_ELIGIBLE" /
            # "gICS FAILURES" notes at the top of this file.
            gics_result = gics.get_consent_status_detailed(patient_id, template_id)

            if not gics_result["ok"]:
                # A real gICS failure for this one patient. Per this
                # file's own documented "gICS FAILURES" policy, leave
                # research_eligible / gics_consent_status untouched
                # rather than silently writing False — record it as an
                # error instead of a state change, and move on.
                error_msg = gics_result["error"]
                logger.error(
                    f"sync: gICS query failed for patient {patient_id}: {error_msg}"
                )
                stats["error_count"] += 1
                stats["errors"].append({
                    "patient_id": patient_id,
                    "gics_error": error_msg,
                })
                # Persist this beyond the current run — a one-off blip
                # self-heals next sync (see resolve_sync_issue() below),
                # but a patient whose gICS query keeps failing across
                # multiple syncs should be visible to an admin without
                # having to diff consecutive sync responses by hand.
                flag_sync_issue(db, patient_id, "gics_query_failure", {
                    "error": error_msg,
                })
                continue

            # Query succeeded this run — clear any standing
            # "gics_query_failure" issue from a previous sync. No-op if
            # there wasn't one.
            resolve_sync_issue(db, patient_id, "gics_query_failure")

            raw_status = gics_result["status"]
            status_norm = _normalize_gics_status(raw_status)

            # Determine eligibility: true if ACCEPTED, false otherwise.
            # A genuine UNKNOWN reaching this line means gICS itself
            # confirmed there's no consent record for this patient (a
            # failed query never gets here — handled above) — so mapping
            # it to ineligible, same as REJECTED, is a deliberate decision,
            # not an accidental fallthrough: there's nothing to be
            # eligible for until the patient actually consents.
            new_eligible = (status_norm == "ACCEPTED")

            # Fetch current state from patient_identifiers (or init if missing)
            current_doc = db.patient_identifiers.find_one(
                {"patient_id": patient_id},
                {"research_eligible": 1}
            )
            old_eligible = current_doc.get("research_eligible") if current_doc else None

            # Track state changes
            if old_eligible is None:
                # First time this patient has been synced
                stats["processing_count"] += 1
            elif old_eligible != new_eligible:
                # State changed
                if new_eligible:
                    stats["newly_eligible"] += 1
                else:
                    stats["newly_ineligible"] += 1
                stats["processing_count"] += 1
            else:
                # No change
                stats["unchanged"] += 1

            # Upsert into patient_identifiers
            db.patient_identifiers.update_one(
                {"patient_id": patient_id},
                {
                    "$set": {
                        "patient_id": patient_id,
                        "research_eligible": new_eligible,
                        "gics_consent_status": status_norm,
                        "last_synced_at": start_timestamp,
                    }
                },
                upsert=True
            )

            # ── Phase 2.5: mirror vitals for eligible patients ──────────────
            # Only patients currently eligible have anything to mirror — an
            # ineligible patient's consent_history has no open interval, so
            # mirror_patient_vitals() would be a guaranteed no-op for them;
            # skipping the lookup entirely avoids the wasted query.
            if new_eligible:
                consent_doc = db.patient_consents.find_one(
                    {"patient_id": patient_id}, {"pseudonym": 1}
                )
                research_pseudonym = (consent_doc or {}).get("pseudonym")

                if research_pseudonym:
                    db.patient_identifiers.update_one(
                        {"patient_id": patient_id},
                        {"$set": {"research_pseudonym": research_pseudonym}},
                    )
                    mirror_stats = mirror_patient_vitals(db, patient_id, research_pseudonym)
                    stats["vitals_mirrored"] += mirror_stats["mirrored"]
                    stats["vitals_considered"] += mirror_stats["considered"]
                    # Pseudonym exists and mirroring ran — clear any
                    # standing "missing_pseudonym" issue from a previous
                    # sync. No-op if there wasn't one.
                    resolve_sync_issue(db, patient_id, "missing_pseudonym")
                else:
                    logger.warning(
                        f"sync: patient {patient_id} is research_eligible but has "
                        f"no patient_consents.pseudonym — cannot mirror vitals yet"
                    )
                    stats["no_pseudonym_count"] += 1
                    # Persist this beyond the current run's log line — an
                    # admin should be able to see, across all patients,
                    # who's stuck eligible-but-unmirrored without having
                    # to grep server logs.
                    flag_sync_issue(db, patient_id, "missing_pseudonym", {
                        "research_eligible_since": start_timestamp,
                    })

            logger.debug(
                f"sync: patient {patient_id} — gICS status: {status_norm}, "
                f"eligible: {new_eligible} (was {old_eligible})"
            )

        except Exception as exc:
            # Unexpected error elsewhere in this patient's processing —
            # e.g. the patient_identifiers upsert or vitals mirroring.
            # gICS query failures are handled above via gics_result["ok"]
            # and never reach this block. Log and continue — one patient's
            # failure shouldn't fail the whole sync.
            error_msg = str(exc)
            logger.error(
                f"sync: processing failed for patient {patient_id}: {error_msg}"
            )
            stats["error_count"] += 1
            stats["errors"].append({
                "patient_id": patient_id,
                "gics_error": error_msg,
            })

    # ─── Step 4: Record sync metadata ──────────────────────────────────────────
    end_time = datetime.now(timezone.utc)
    duration_seconds = (end_time - start_time).total_seconds()

    sync_log = {
        "researcher_id": researcher_id,
        "synced_at": start_timestamp,
        "total_patients": total_patients,
        "processing_count": stats["processing_count"],
        "error_count": stats["error_count"],
        "newly_eligible": stats["newly_eligible"],
        "newly_ineligible": stats["newly_ineligible"],
        "unchanged": stats["unchanged"],
        "vitals_mirrored": stats["vitals_mirrored"],
        "vitals_considered": stats["vitals_considered"],
        "no_pseudonym_count": stats["no_pseudonym_count"],
        "duration_seconds": duration_seconds,
    }

    db.research_sync_log.insert_one(sync_log)
    logger.info(
        f"research sync completed: {stats['processing_count']} processed, "
        f"{stats['error_count']} errors, "
        f"{stats['newly_eligible']} newly eligible, "
        f"{stats['newly_ineligible']} newly ineligible, "
        f"{stats['vitals_mirrored']} vitals mirrored "
        f"(of {stats['vitals_considered']} considered), "
        f"{stats['no_pseudonym_count']} skipped for missing pseudonym, "
        f"{duration_seconds:.2f}s"
    )

    # ─── Response ──────────────────────────────────────────────────────────────
    response = {
        "synced_at": start_timestamp,
        "synced_by": researcher_id,
        "total_patients": total_patients,
        **stats,
        "duration_seconds": duration_seconds,
    }

    return jsonify(response), 200


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/research/sync/status  — last sync timestamp + stats
# ─────────────────────────────────────────────────────────────────────────────

@research_routes.route('/api/research/sync/status', methods=['GET'])
@token_required
@api_error_handler
def get_last_sync_status(current_user):
    """
    GET /api/research/sync/status — retrieve timestamp and stats of the most
    recent sync job, helping the researcher know if data (and mirrored
    vitals) are fresh.

    Accessible to researchers only. Returns null if no sync has ever run.

    Response
    ────────
    {
      "last_synced_at":     ISO datetime | null,
      "synced_by":          researcher_id | null,
      "total_patients":     int | null,
      "newly_eligible":     int | null,
      "newly_ineligible":   int | null,
      "error_count":        int | null,
      "vitals_mirrored":    int | null,
      "vitals_considered":  int | null,
      "no_pseudonym_count": int | null,
      "stale_minutes":      float | null (time elapsed since sync)
    }

    Note: vitals-mirroring freshness is not tracked separately from
    eligibility freshness — they run in the same sync pass and share
    last_synced_at / stale_minutes. If these are ever split into separate
    triggers, this response shape will need its own staleness field for
    vitals.
    """
    # ─── Auth ─────────────────────────────────────────────────────────────────
    authorized, error_response, status = _check_researcher_auth(current_user)
    if not authorized:
        return jsonify(error_response), status

    db = current_app.mongo.db

    # Fetch most recent sync log (sorted by synced_at descending)
    last_sync = db.research_sync_log.find_one(
        {},
        sort=[("synced_at", -1)]
    )

    if not last_sync:
        return jsonify({
            "last_synced_at": None,
            "synced_by": None,
            "total_patients": None,
            "newly_eligible": None,
            "newly_ineligible": None,
            "error_count": None,
            "vitals_mirrored": None,
            "vitals_considered": None,
            "no_pseudonym_count": None,
            "stale_minutes": None,
        }), 200

    # Calculate staleness
    synced_at = last_sync.get("synced_at")
    stale_minutes = None
    if synced_at:
        try:
            # If synced_at is an ISO string, parse it; if it's already a datetime, use it
            if isinstance(synced_at, str):
                synced_dt = datetime.fromisoformat(synced_at.replace('Z', '+00:00'))
            else:
                synced_dt = synced_at
            now = datetime.now(timezone.utc)
            stale_minutes = (now - synced_dt).total_seconds() / 60.0
        except Exception as exc:
            logger.warning(f"Could not calculate staleness: {exc}")

    return jsonify({
        "last_synced_at": last_sync.get("synced_at"),
        "synced_by": last_sync.get("researcher_id"),
        "total_patients": last_sync.get("total_patients"),
        "newly_eligible": last_sync.get("newly_eligible"),
        "newly_ineligible": last_sync.get("newly_ineligible"),
        "error_count": last_sync.get("error_count"),
        "vitals_mirrored": last_sync.get("vitals_mirrored"),
        "vitals_considered": last_sync.get("vitals_considered"),
        "no_pseudonym_count": last_sync.get("no_pseudonym_count"),
        "stale_minutes": stale_minutes,
    }), 200


# ─────────────────────────────────────────────────────────────────────────────
# Future work: research_vitals export, patient-initiated erasure requests
# ─────────────────────────────────────────────────────────────────────────────

# Placeholder for future endpoints:
#   GET  /api/research/data/patients           — list eligible patients + pseudonyms
#   POST /api/research/data/export             — export research_vitals bundle
#   POST /api/patient/erasure-request          — patient-initiated erasure (held for later —
#                                                 see admin-routes-plan.md §3; the admin
#                                                 approval side below is already built)
#
# Built 2026-08-11 in backend/routes/admin_routes.py, not here (admin-only,
# see admin-routes-plan.md):
#   GET  /api/admin/sync-issues                — persistent missing_pseudonym /
#                                                 gics_query_failure tracking (§1-2)
#   GET  /api/admin/erasure-requests            — admin approval queue (§4.2)
#   POST /api/admin/erasure-requests/<req_id>   — approve/deny erasure, body
#                                                 {"action": "approve"|"deny"} (§4.2)
#   These will show an empty erasure_requests queue until the
#   patient-facing creation endpoint above is built.