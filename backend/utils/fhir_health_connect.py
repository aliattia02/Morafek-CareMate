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
  • build_hc_status_response() — fast aggregation query over ehr_vitals for
                                  GET /api/healthconnect/status
  • enrich_for_storage()      — add server-side fields (patient_id, recorded_by,
                                 source bookkeeping) before upsert into ehr_vitals

Design notes
────────────
  • Adding a new Health Connect data type requires only:
      1. Adding the LOINC code to ALLOWED_HC_LOINC_CODES
      2. Adding its label to _LOINC_LABELS (for status breakdown)
    No pipeline logic changes are needed.

  • All validation errors return a dict {"field": ..., "reason": ...} so the
    route can build a structured 422 response rather than a raw string.

Author: Morafek CareMate Team
==============================================================================
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

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
    upserted into ehr_vitals. Mutates and returns the same dict.

    Added fields (following the existing ehr_vitals document shape):
        patient_id      — redundant top-level copy for fast index queries
        recorded_by     — "health_connect" (not a doctor user_id)
        source          — "health_connect" (already set by client, enforced here)
        device_type     — "android_watch"
        synced_at       — server UTC timestamp of the sync request
        loinc_code      — top-level index copy for the status aggregation query

    Does NOT add a Mongo _id — PyMongo generates that on insert.
    """
    now_iso = datetime.now(timezone.utc).isoformat()

    obs["patient_id"]   = patient_id
    obs["recorded_by"]  = "health_connect"
    obs["source"]       = "health_connect"   # already present, reinforce
    obs["device_type"]  = "android_watch"
    obs["synced_at"]    = now_iso
    obs["loinc_code"]   = loinc_code         # top-level copy for fast queries

    return obs


# ─── Status aggregation ───────────────────────────────────────────────────────


def build_hc_status_response(
    patient_id: str,
    mongo_db: Any,          # pymongo Database object, passed in to avoid circular import
) -> dict[str, Any]:
    """
    Build the response dict for GET /api/healthconnect/status.

    Queries ehr_vitals for documents where:
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

    Uses two targeted queries:
      1. find + sort(-synced_at, 1) limit 1  → last_sync
      2. aggregation pipeline              → per-LOINC counts

    Both are fast when the collection is indexed on (patient_id, source).
    Recommended index (add to main.py startup):
        mongo.db.ehr_vitals.create_index(
            [("patient_id", 1), ("source", 1), ("synced_at", -1)]
        )
    """
    base_filter = {"patient_id": patient_id, "source": "health_connect"}

    # ── 1. Last sync timestamp ────────────────────────────────────────────────
    most_recent = mongo_db.ehr_vitals.find_one(
        base_filter,
        {"synced_at": 1},
        sort=[("synced_at", -1)],
    )
    last_sync: str | None = most_recent.get("synced_at") if most_recent else None

    # ── 2. Per-LOINC observation counts ──────────────────────────────────────
    pipeline = [
        {"$match": base_filter},
        {"$group": {"_id": "$loinc_code", "count": {"$sum": 1}}},
    ]
    agg_result = list(mongo_db.ehr_vitals.aggregate(pipeline))

    # Map loinc_code → label → count, defaulting unknown codes to their raw code
    counts: dict[str, int] = {}
    for row in agg_result:
        loinc = row["_id"] or ""
        label = _LOINC_LABELS.get(loinc, loinc)   # fallback to raw code
        counts[label] = row["count"]

    # Ensure the two current types are always present in the response
    counts.setdefault("heart_rate", 0)
    counts.setdefault("steps", 0)

    has_data = bool(most_recent)

    logger.debug(
        "[hc_status] patient=%s has_data=%s last_sync=%s counts=%s",
        patient_id, has_data, last_sync, counts,
    )

    return {
        "has_data":  has_data,
        "last_sync": last_sync,
        "counts":    counts,
    }
