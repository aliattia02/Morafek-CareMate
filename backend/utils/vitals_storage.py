"""
backend/utils/vitals_storage.py
─────────────────────────────────────────────────────────────────────────────
Per-type vitals storage helpers — the replacement for the single shared
`ehr_vitals` collection.

Background
──────────
Historically every vitals reading (manual, patient-home, or Health-Connect-
synced) was stored as one document in `ehr_vitals`, sometimes bundling
several vital signs together in a `component[]` array (e.g. one doc holding
systolic + diastolic + heart rate). This module splits storage into
dedicated per-type collections while preserving the "recorded together"
relationship via a shared `reading_id`, and preserving the existing API
response shapes so `mobile/services/api/*` needs no changes.

Collections
───────────
  vitals_blood_pressure  — systolic + diastolic together (LOINC 55284-4 panel)
  vitals_heart_rate      — LOINC 8867-4
  vitals_weight          — LOINC 29463-7
  vitals_steps           — LOINC 41950-7 (Health Connect only, today)
  vitals_blood_sugar     — LOINC 15074-8 (reserved — no writer yet)

Every document additionally carries:
  reading_id   — groups documents written together in a single POST/sync
                 event, so GET endpoints can recombine them into the same
                 response shape the mobile app already expects.
  source       — promoted to a top-level field for ALL docs (previously
                 buried in extension[] for manual/patient-home entries).

Author: Morafek CareMate Team
──────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4


# ─── Collection names ─────────────────────────────────────────────────────────

COLLECTION_BLOOD_PRESSURE = "vitals_blood_pressure"
COLLECTION_HEART_RATE     = "vitals_heart_rate"
COLLECTION_WEIGHT         = "vitals_weight"
COLLECTION_STEPS          = "vitals_steps"
COLLECTION_BLOOD_SUGAR    = "vitals_blood_sugar"

# LOINC → collection routing table. Keep in sync with fhir_de.py's
# LOINC_* constants and fhir_health_connect.py's ALLOWED_HC_LOINC_CODES.
LOINC_TO_COLLECTION: dict[str, str] = {
    "55284-4": COLLECTION_BLOOD_PRESSURE,   # BP panel (sys+dia together)
    "8867-4":  COLLECTION_HEART_RATE,
    "29463-7": COLLECTION_WEIGHT,
    "41950-7": COLLECTION_STEPS,
    "15074-8": COLLECTION_BLOOD_SUGAR,
}

ALL_VITALS_COLLECTIONS: tuple[str, ...] = (
    COLLECTION_BLOOD_PRESSURE,
    COLLECTION_HEART_RATE,
    COLLECTION_WEIGHT,
    COLLECTION_STEPS,
    COLLECTION_BLOOD_SUGAR,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ─── Write path ────────────────────────────────────────────────────────────────

def fan_out_reading(
    mongo_db: Any,
    *,
    patient_id: str,
    recorded_by: str,
    source: str,
    performer_ref: str,
    effective_dt: str | None = None,
    systolic: float | None = None,
    diastolic: float | None = None,
    pulse: float | None = None,
    weight_kg: float | None = None,
    notes: str = "",
    urgent: bool = False,
    reading_id: str | None = None,
) -> str:
    """
    Split one logical vitals reading into its per-type documents and insert
    them into the appropriate collections, linked by a shared `reading_id`.

    Pass only the values that were actually recorded — omitted values (None)
    are simply not written to any collection. E.g. a Health Connect single
    heart-rate sync would pass only `pulse`.

    Returns the reading_id (generated if not supplied), so callers that need
    it for a response or for chaining additional writes can reuse it.
    """
    reading_id = reading_id or str(uuid4())
    effective_dt = effective_dt or _now_iso()

    base_fields: dict[str, Any] = {
        "reading_id":  reading_id,
        "patient_id":  patient_id,
        "recorded_by": recorded_by,
        "source":      source,
        "status":      "final",
        "category": [{
            "coding": [{
                "system":  "http://terminology.hl7.org/CodeSystem/observation-category",
                "code":    "vital-signs",
                "display": "Vital Signs",
            }]
        }],
        "subject":           {"reference": f"Patient/{patient_id}"},
        "effectiveDateTime": effective_dt,
        "performer":         [{"reference": performer_ref}],
    }
    if notes:
        base_fields["note"] = [{"text": notes}]

    if systolic is not None or diastolic is not None:
        bp_doc: dict[str, Any] = {
            **base_fields,
            "resourceType": "Observation",
            "id": str(uuid4()),
            "code": {"coding": [{
                "system": "http://loinc.org", "code": "55284-4",
                "display": "Blood pressure systolic and diastolic",
            }]},
            "component": [],
            "extension": [{
                "url": "https://morafek.app/fhir/StructureDefinition/urgent-flag",
                "valueBoolean": urgent,
            }],
        }
        if systolic is not None:
            bp_doc["component"].append({
                "code": {"coding": [{"system": "http://loinc.org",
                                     "code": "8480-6", "display": "Systolic BP"}]},
                "valueQuantity": {"value": systolic, "unit": "mmHg",
                                  "system": "http://unitsofmeasure.org", "code": "mm[Hg]"},
            })
        if diastolic is not None:
            bp_doc["component"].append({
                "code": {"coding": [{"system": "http://loinc.org",
                                     "code": "8462-4", "display": "Diastolic BP"}]},
                "valueQuantity": {"value": diastolic, "unit": "mmHg",
                                  "system": "http://unitsofmeasure.org", "code": "mm[Hg]"},
            })
        mongo_db[COLLECTION_BLOOD_PRESSURE].insert_one(bp_doc)

    if pulse is not None:
        hr_doc: dict[str, Any] = {
            **base_fields,
            "resourceType": "Observation",
            "id": str(uuid4()),
            "code": {"coding": [{"system": "http://loinc.org",
                                 "code": "8867-4", "display": "Heart rate"}]},
            "valueQuantity": {"value": pulse, "unit": "/min",
                              "system": "http://unitsofmeasure.org", "code": "/min"},
        }
        mongo_db[COLLECTION_HEART_RATE].insert_one(hr_doc)

    if weight_kg is not None:
        wt_doc: dict[str, Any] = {
            **base_fields,
            "resourceType": "Observation",
            "id": str(uuid4()),
            "code": {"coding": [{"system": "http://loinc.org",
                                 "code": "29463-7", "display": "Body weight"}]},
            "valueQuantity": {"value": weight_kg, "unit": "kg",
                              "system": "http://unitsofmeasure.org", "code": "kg"},
        }
        mongo_db[COLLECTION_WEIGHT].insert_one(wt_doc)

    return reading_id


# ─── Read path ─────────────────────────────────────────────────────────────────

def collect_readings(mongo_db: Any, patient_id: str) -> list[dict]:
    """
    Query all per-type vitals collections for `patient_id`, regroup documents
    by `reading_id`, and return the same flat shape the mobile app already
    expects from GET /api/.../vitals:

        [{ "id", "systolic", "diastolic", "pulse", "weight_kg",
           "urgent", "timestamp" }, ...]

    Docs sharing a reading_id (e.g. BP + HR written from one manual entry)
    are merged into a single row. Docs with no sibling (e.g. a lone HC
    steps/heart-rate sync) still produce their own row, with the fields that
    weren't recorded left as None.

    NOTE: `weight_kg` is a new field in the response — it was previously
    stored but never surfaced by get_vitals()/get_own_vitals(). Adding it is
    additive and should not break existing mobile clients that ignore
    unknown fields; flag if strict schema validation is in place client-side.
    """
    grouped: dict[str, dict[str, Any]] = {}

    for coll_name in (COLLECTION_BLOOD_PRESSURE, COLLECTION_HEART_RATE, COLLECTION_WEIGHT):
        for doc in mongo_db[coll_name].find({"patient_id": patient_id}):
            rid = doc.get("reading_id") or str(doc["_id"])
            row = grouped.setdefault(rid, {
                "id": str(doc["_id"]),
                "systolic": None, "diastolic": None, "pulse": None,
                "weight_kg": None, "urgent": False,
                "timestamp": doc.get("effectiveDateTime"),
            })
            # Prefer the earliest available timestamp for the merged row
            if not row.get("timestamp"):
                row["timestamp"] = doc.get("effectiveDateTime")

            if coll_name == COLLECTION_BLOOD_PRESSURE:
                for comp in doc.get("component", []):
                    code_val = (comp.get("code", {}).get("coding") or [{}])[0].get("code")
                    qty = comp.get("valueQuantity", {}).get("value")
                    if code_val == "8480-6":
                        row["systolic"] = qty
                    elif code_val == "8462-4":
                        row["diastolic"] = qty
                for ext in doc.get("extension", []):
                    if ext.get("url") == "https://morafek.app/fhir/StructureDefinition/urgent-flag":
                        row["urgent"] = ext.get("valueBoolean", False)
            elif coll_name == COLLECTION_HEART_RATE:
                row["pulse"] = doc.get("valueQuantity", {}).get("value")
            elif coll_name == COLLECTION_WEIGHT:
                row["weight_kg"] = doc.get("valueQuantity", {}).get("value")

    rows = list(grouped.values())
    rows.sort(key=lambda r: r.get("timestamp") or "", reverse=True)
    return rows
