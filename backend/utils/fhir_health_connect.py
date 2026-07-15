"""
fhir_health_connect.py — Health Connect FHIR Validation & Query Helpers
==============================================================================
Validation and query utilities for the Health Connect integration.
Consumed exclusively by health_connect_routes.py.

Responsibilities
────────────────
  • ALLOWED_HC_LOINC_CODES   — gating set; only these LOINC codes are accepted
  • validate_hc_observation() — structural + semantic validation of each FHIR
                                Observation arriving in POST /api/healthconnect/sync
  • build_hc_status_response() — fast per-collection queries over the
                                  vitals_* collections (see vitals_storage.py)
                                  for GET /api/healthconnect/status
  • enrich_for_storage()      — add server-side fields (patient_id, recorded_by,
                                 source bookkeeping, reading_id) before upsert
                                 into the per-type vitals_* collection

Design notes
────────────
  • As of the ehr_vitals → per-type-collections migration (see
    utils/vitals_storage.py), each validated observation is upserted into
    the collection given by LOINC_TO_COLLECTION[loinc_code] rather than a
    shared ehr_vitals collection. ALLOWED_HC_LOINC_CODES is reconciled
    against LOINC_TO_COLLECTION at import time (see the assertion below) so
    an allowed code always has a routing target.

  • Adding a new Health Connect data type requires:
      1. Adding the LOINC code to ALLOWED_HC_LOINC_CODES
      2. Adding its label to _LOINC_LABELS (for status breakdown)
      3. Making sure the code has an entry in vitals_storage.LOINC_TO_COLLECTION
         (add a writer/collection there if one doesn't exist yet)
    No other pipeline logic changes are needed.

  • All validation errors return a dict {"field": ..., "reason": ...} so the
    route can build a structured 422 response rather than a raw string.

Author: Morafek CareMate Team
==============================================================================
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from utils.vitals_storage import (
    COLLECTION_HEART_RATE,
    COLLECTION_STEPS,
    LOINC_TO_COLLECTION,
)

logger = logging.getLogger(__name__)

# ─── Allowed LOINC codes ──────────────────────────────────────────────────────
#
# Only observations whose code.coding[].code matches one of these are accepted.
# This prevents clients from injecting arbitrary clinical codes via the HC sync
# endpoint. Extend this set as new HC_DATA_TYPES registry entries are added.

ALLOWED_HC_LOINC_CODES: frozenset[str] = frozenset({
    "8867-4",   # Heart rate
    "41950-7",  # Steps (Number of steps in unspecified time Pedometer)
    # ── Reserve slots (uncomment when mapper support is added): ──────────────
    # "59408-5",  # Oxygen saturation in Arterial blood Pulse oximetry
    # "29463-7",  # Body weight
    # "15074-8",  # Glucose [Moles/volume] in Blood
    # "93832-4",  # Sleep duration
})

# Every allowed HC LOINC code must have a routing target in
# vitals_storage.LOINC_TO_COLLECTION, or a validated observation would have
# nowhere to be upserted. Fail fast at import time rather than at sync time.
_unrouted = ALLOWED_HC_LOINC_CODES - LOINC_TO_COLLECTION.keys()
if _unrouted:
    raise RuntimeError(
        "ALLOWED_HC_LOINC_CODES contains code(s) with no entry in "
        f"vitals_storage.LOINC_TO_COLLECTION: {sorted(_unrouted)}. "
        "Add a collection mapping there before enabling this code."
    )

# Human-readable labels for status breakdown (keyed by LOINC code)
_LOINC_LABELS: dict[str, str] = {
    "8867-4":  "heart_rate",
    "41950-7": "steps",
    "59408-5": "spo2",
    "29463-7": "weight",
    "15074-8": "blood_glucose",
    "93832-4": "sleep",
}

# ─── Structural validation ────────────────────────────────────────────────────


class HCValidationError(Exception):
    """Raised when a Health Connect observation fails validation."""

    def __init__(self, field: str, reason: str) -> None:
        self.field  = field
        self.reason = reason
        super().__init__(f"{field}: {reason}")

    def to_dict(self) -> dict[str, str]:
        return {"field": self.field, "reason": self.reason}


def _extract_loinc_code(obs: dict[str, Any]) -> str:
    """
    Walk obs.code.coding[] and return the first LOINC code found.
    Raises HCValidationError if none is present.
    """
    code_block = obs.get("code", {})
    codings    = code_block.get("coding", [])

    for coding in codings:
        if coding.get("system") == "http://loinc.org":
            code = coding.get("code", "").strip()
            if code:
                return code

    raise HCValidationError("code.coding", "No LOINC code found (system=http://loinc.org)")


def _extract_patient_id(obs: dict[str, Any]) -> str:
    """
    Parse subject.reference → 'Patient/<id>' and return <id>.
    Raises HCValidationError on missing or malformed reference.
    """
    ref = obs.get("subject", {}).get("reference", "")
    if not ref.startswith("Patient/"):
        raise HCValidationError(
            "subject.reference",
            f"Must be 'Patient/<id>', got: '{ref}'",
        )
    patient_id = ref[len("Patient/"):].strip()
    if not patient_id:
        raise HCValidationError("subject.reference", "Patient ID part is empty")
    return patient_id


def validate_hc_observation(
    obs: dict[str, Any],
    expected_patient_id: str,
) -> str:
    """
    Validate a single FHIR R4 Observation received from the mobile Health
    Connect sync. Returns the LOINC code on success; raises HCValidationError
    on the first detected problem.

    Checks performed (in order):
      1. resourceType == 'Observation'
      2. status == 'final'
      3. subject.reference parses as 'Patient/<expected_patient_id>'
         (prevents cross-patient data injection)
      4. id field present and non-empty (client-generated UUID)
      5. effectiveDateTime present and parseable as ISO-8601
      6. code.coding contains a LOINC code in ALLOWED_HC_LOINC_CODES
      7. valueQuantity.value is a non-negative number
      8. source == 'health_connect'

    Args:
        obs                  — raw dict from request JSON
        expected_patient_id  — patient _id from the verified JWT

    Returns:
        The validated LOINC code string (used by route for response summary)
    """
    # 1. resourceType
    if obs.get("resourceType") != "Observation":
        raise HCValidationError(
            "resourceType",
            f"Expected 'Observation', got '{obs.get('resourceType')}'",
        )

    # 2. status
    if obs.get("status") != "final":
        raise HCValidationError(
            "status",
            f"Expected 'final', got '{obs.get('status')}'",
        )

    # 3. Patient ID — must match the authenticated user
    obs_patient_id = _extract_patient_id(obs)
    if obs_patient_id != expected_patient_id:
        raise HCValidationError(
            "subject.reference",
            "Patient ID in observation does not match the authenticated user",
        )

    # 4. id (client-generated UUID)
    obs_id = obs.get("id", "").strip()
    if not obs_id:
        raise HCValidationError("id", "Observation id is required (UUID v4)")

    # 5. effectiveDateTime
    effective = obs.get("effectiveDateTime", "")
    if not effective:
        raise HCValidationError("effectiveDateTime", "Field is required")
    try:
        datetime.fromisoformat(effective.replace("Z", "+00:00"))
    except ValueError:
        raise HCValidationError(
            "effectiveDateTime",
            f"Not a valid ISO-8601 datetime: '{effective}'",
        )

    # 6. LOINC code in allowed set
    loinc_code = _extract_loinc_code(obs)
    if loinc_code not in ALLOWED_HC_LOINC_CODES:
        raise HCValidationError(
            "code.coding[].code",
            f"LOINC code '{loinc_code}' is not in the allowed Health Connect codes. "
            f"Allowed: {sorted(ALLOWED_HC_LOINC_CODES)}",
        )

    # 7. valueQuantity.value
    vq = obs.get("valueQuantity", {})
    raw_value = vq.get("value")
    if raw_value is None:
        raise HCValidationError("valueQuantity.value", "Field is required")
    try:
        float_value = float(raw_value)
    except (TypeError, ValueError):
        raise HCValidationError(
            "valueQuantity.value",
            f"Must be a number, got: '{raw_value}'",
        )
    if float_value < 0:
        raise HCValidationError(
            "valueQuantity.value",
            f"Value must be non-negative, got: {float_value}",
        )

    # 8. source marker — ensures only HC-tagged observations come through this route
    if obs.get("source") != "health_connect":
        raise HCValidationError(
            "source",
            "Field must be 'health_connect'",
        )

    return loinc_code


# ─── Storage enrichment ───────────────────────────────────────────────────────


def enrich_for_storage(
    obs: dict[str, Any],
    patient_id: str,
    loinc_code: str,
) -> dict[str, Any]:
    """
    Add server-side fields to a validated FHIR Observation before it is
    upserted into its per-type vitals_* collection (see
    vitals_storage.LOINC_TO_COLLECTION). Mutates and returns the same dict.

    Added fields (matching the shape fan_out_reading() produces so that both
    write paths — manual/patient-home entry and Health Connect sync — land
    documents with a consistent shape in the per-type collections):
        patient_id      — redundant top-level copy for fast index queries
        recorded_by     — "health_connect" (not a doctor user_id)
        source          — "health_connect" (already set by client, enforced here)
        device_type     — "android_watch"
        synced_at       — server UTC timestamp of the sync request
        loinc_code      — top-level index copy for the status aggregation query
        reading_id       — groups documents written together in one logical
                            reading (see vitals_storage.py docstring). Health
                            Connect syncs are unbatched — one Observation is
                            one reading — so reading_id is just the
                            observation's own client-generated id.

    Does NOT add a Mongo _id — PyMongo generates that on insert.
    """
    now_iso = datetime.now(timezone.utc).isoformat()

    obs["patient_id"]   = patient_id
    obs["recorded_by"]  = "health_connect"
    obs["source"]       = "health_connect"   # already present, reinforce
    obs["device_type"]  = "android_watch"
    obs["synced_at"]    = now_iso
    obs["loinc_code"]   = loinc_code         # top-level copy for fast queries
    obs["reading_id"]   = obs.get("id") or str(uuid4())

    return obs


# ─── Status aggregation ───────────────────────────────────────────────────────


def build_hc_status_response(
    patient_id: str,
    mongo_db: Any,          # pymongo Database object, passed in to avoid circular import
) -> dict[str, Any]:
    """
    Build the response dict for GET /api/healthconnect/status.

    Queries the per-type vitals_* collections that Health Connect currently
    writes to (vitals_heart_rate, vitals_steps — see
    vitals_storage.LOINC_TO_COLLECTION) for documents where:
        patient_id == patient_id  AND  source == 'health_connect'

    Returns:
        {
          "has_data":  bool,
          "last_sync": str | null,     # ISO-8601 of most recent synced_at
          "counts": {
              "heart_rate": int,
              "steps": int,
              ...                      # extensible via _LOINC_LABELS
          }
        }

    Runs one find + one count per HC-writeable collection. This scales with
    the (small, fixed) number of Health Connect data types rather than with
    document volume, and stays fast as long as each collection is indexed
    on (patient_id, source).

    Recommended indexes (add to main.py startup):
        mongo.db.vitals_heart_rate.create_index(
            [("patient_id", 1), ("source", 1), ("synced_at", -1)]
        )
        mongo.db.vitals_steps.create_index(
            [("patient_id", 1), ("source", 1), ("synced_at", -1)]
        )
    """
    base_filter = {"patient_id": patient_id, "source": "health_connect"}

    # LOINC code → collection, restricted to the collections Health Connect
    # actually writes to today. Extending ALLOWED_HC_LOINC_CODES with a new
    # code automatically picks up its collection here.
    hc_collections: dict[str, str] = {
        loinc: LOINC_TO_COLLECTION[loinc] for loinc in ALLOWED_HC_LOINC_CODES
    }

    counts: dict[str, int] = {}
    last_sync: str | None = None

    for loinc, coll_name in hc_collections.items():
        label = _LOINC_LABELS.get(loinc, loinc)
        collection = mongo_db[coll_name]

        counts[label] = collection.count_documents(base_filter)

        most_recent = collection.find_one(
            base_filter,
            {"synced_at": 1},
            sort=[("synced_at", -1)],
        )
        if most_recent and most_recent.get("synced_at"):
            candidate = most_recent["synced_at"]
            if last_sync is None or candidate > last_sync:
                last_sync = candidate

    # Ensure the two current types are always present in the response
    counts.setdefault("heart_rate", 0)
    counts.setdefault("steps", 0)

    has_data = any(count > 0 for count in counts.values())

    logger.debug(
        "[hc_status] patient=%s has_data=%s last_sync=%s counts=%s",
        patient_id, has_data, last_sync, counts,
    )

    return {
        "has_data":  has_data,
        "last_sync": last_sync,
        "counts":    counts,
    }
