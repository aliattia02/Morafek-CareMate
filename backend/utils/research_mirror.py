"""
backend/utils/research_mirror.py
─────────────────────────────────────────────────────────────────────────────
Phase 2.5 — mirrors vitals readings into the pseudonymized `research_vitals`
collection for patients with an active research-consent interval.

Design (data-store-separation-reference.md §1, §1.1, §4):
  • gICS decides WHEN an interval is open (consent_history, via
    utils/consent_history.py).
  • gPAS decides WHO — which pseudonym a reading gets mirrored under
    (patient_consents.pseudonym is the canonical current-pseudonym field —
    see consent-gics-gpas-reference.md §13's resolved answer).
  • This module is the third piece: WHAT gets copied, and how it's
    de-identified before landing in research_vitals.

research_vitals documents carry NO field that can identify the source
patient — no patient_id, no subject reference, no performer/recorded_by,
no free-text notes. Only `research_pseudonym` (gPAS-issued) identifies
whose data this is, and gPAS is the only service in this design able to
resolve that back to a person (consent-gics-gpas-reference.md §1.1
principle, extended here to vitals — data-store-separation-reference.md §1).

Idempotency
───────────
Each research_vitals doc is upserted on (research_pseudonym,
source_collection, source_observation_id) so re-running the sync after
readings have already been mirrored is a no-op for those readings — only
genuinely new readings, or readings that newly fall inside a
freshly-opened interval, get inserted.

Fail-closed on timestamps
──────────────────────────
A reading with a missing or unparseable effectiveDateTime is never
mirrored — we don't guess whether it falls inside a consent window.

Author: Morafek CareMate Team
─────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from utils.consent_history import get_consent_intervals
from utils.vitals_storage import ALL_VITALS_COLLECTIONS

RESEARCH_VITALS_COLLECTION = "research_vitals"

# Fields that must NEVER be copied into research_vitals — anything that
# links a reading back to a real patient or account.
_IDENTIFYING_FIELDS = ("patient_id", "subject", "performer", "recorded_by", "note")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _reading_in_any_interval(effective_dt: Optional[str], intervals: list[dict]) -> bool:
    """
    True if `effective_dt` falls within at least one [granted_at, revoked_at)
    interval. An interval with revoked_at=None is still open — everything
    from granted_at up to now counts.
    """
    reading_dt = _parse_dt(effective_dt)
    if reading_dt is None:
        return False  # fail closed — never mirror a reading we can't place in time

    for interval in intervals:
        granted_dt = _parse_dt(interval.get("granted_at"))
        if granted_dt is None:
            continue
        revoked_dt = _parse_dt(interval.get("revoked_at"))

        if reading_dt < granted_dt:
            continue
        if revoked_dt is not None and reading_dt >= revoked_dt:
            continue
        return True
    return False


def _deidentify(doc: dict, source_collection: str, research_pseudonym: str) -> dict:
    """Strip identifying fields and stamp the research pseudonym + provenance."""
    clean = {
        k: v for k, v in doc.items()
        if k not in _IDENTIFYING_FIELDS and k != "_id"
    }
    clean["research_pseudonym"]    = research_pseudonym
    clean["source_collection"]     = source_collection
    clean["source_observation_id"] = doc.get("id") or str(doc["_id"])
    clean["mirrored_at"]           = _now_iso()
    return clean


def mirror_patient_vitals(
    db: Any,
    patient_id: str,
    research_pseudonym: Optional[str],
) -> dict:
    """
    Mirror `patient_id`'s vitals readings that fall inside an active
    consent_history interval into research_vitals, under
    `research_pseudonym`.

    No-op (zero counts) if there's no pseudonym or no consent history for
    it yet — mirrors the same "nothing to do" tolerance as
    open_consent_interval()/close_consent_interval().

    Returns: {"considered": int, "mirrored": int, "skipped_existing": int}
    """
    stats = {"considered": 0, "mirrored": 0, "skipped_existing": 0}

    if not research_pseudonym:
        return stats

    intervals = get_consent_intervals(db, research_pseudonym)
    if not intervals:
        return stats

    for coll_name in ALL_VITALS_COLLECTIONS:
        for doc in db[coll_name].find({"patient_id": patient_id}):
            stats["considered"] += 1
            if not _reading_in_any_interval(doc.get("effectiveDateTime"), intervals):
                continue

            research_doc = _deidentify(doc, coll_name, research_pseudonym)
            result = db[RESEARCH_VITALS_COLLECTION].update_one(
                {
                    "research_pseudonym":    research_pseudonym,
                    "source_collection":     coll_name,
                    "source_observation_id": research_doc["source_observation_id"],
                },
                {"$setOnInsert": research_doc},
                upsert=True,
            )
            if result.upserted_id is not None:
                stats["mirrored"] += 1
            else:
                stats["skipped_existing"] += 1

    return stats