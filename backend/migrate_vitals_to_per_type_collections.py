"""
backend/migrate_vitals_to_per_type_collections.py
===============================================================================
One-time migration: fan the legacy shared `ehr_vitals` collection out into
the new per-type vitals_* collections (see utils/vitals_storage.py).

This script does NOT delete or modify the original ehr_vitals documents —
they are left in place until the migration has been verified (per-type reads
via collect_readings()/GET vitals endpoints, and a FHIR export diff).

Usage
─────
    python backend/migrate_vitals_to_per_type_collections.py [--dry-run]

    --dry-run   Log exactly what would be written, without touching the DB.
                Run this first.

Idempotency
───────────
Safe to re-run. Each per-type document written here reuses reading_id ==
the source ehr_vitals doc's own FHIR `id` field (not a freshly generated
UUID), so a doc that has already been migrated is detected by checking
whether any per-type collection already has a document with that
reading_id, and skipped.

Known gaps — NOT handled by fan_out_reading() ─────────────────────────────
fan_out_reading() (utils/vitals_storage.py) only writes systolic, diastolic,
pulse, and weight_kg. Two vital types it does not support at all:

  • Blood glucose (LOINC 15074-8) → vitals_blood_sugar has "no writer yet"
    per the vitals_storage.py module docstring. If a legacy doc contains a
    glucose component, this script inserts it directly using the same
    document shape fan_out_reading() uses for its other per-type docs, so
    the reading isn't silently dropped. Flagged loudly via logger.warning
    so it gets human review — this is new ground, not an existing,
    exercised code path.

  • Steps (LOINC 41950-7) → only ever written by Health Connect's
    enrich_for_storage() (utils/fhir_health_connect.py), never by
    fan_out_reading(). Pre-migration flat Health-Connect docs (source ==
    "health_connect", no component[] array — just a top-level code/
    valueQuantity) are inserted directly in the enrich_for_storage() shape
    (device_type, synced_at, loinc_code, reading_id).

Two legacy document shapes are handled
───────────────────────────────────────
  1. Panel-style docs (manual / patient_home entries): a component[] array
     bundling systolic + diastolic + heart rate (+ weight/glucose if
     present), source tucked into extension[] on older docs.
  2. Flat docs (pre-migration Health Connect syncs): source ==
     "health_connect", single top-level code/valueQuantity, no component[].

Author: Morafek CareMate Team
===============================================================================
"""

from __future__ import annotations

import argparse
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from bson.objectid import ObjectId

# mongo.db is only populated once flask_pymongo's PyMongo instance is
# init_app()'d against a real Flask app (see config.create_app_config()).
# That only happens inside main.create_app(), so — unlike the route modules,
# which are imported *after* the app already exists — this standalone script
# has to build the app and push an app context itself before mongo.db works.
from main import create_app

_app = create_app()
_app.app_context().push()

from config import mongo
from utils.vitals_storage import (
    ALL_VITALS_COLLECTIONS,
    COLLECTION_BLOOD_SUGAR,
    COLLECTION_STEPS,
    fan_out_reading,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("migrate_vitals")

# ─── Constants matching the shapes used by vitals_storage.py / fhir_health_connect.py ──

URGENT_FLAG_URL = "https://morafek.app/fhir/StructureDefinition/urgent-flag"
SOURCE_EXT_URL  = "https://morafek.app/fhir/StructureDefinition/source"

LOINC_SYSTOLIC   = "8480-6"
LOINC_DIASTOLIC  = "8462-4"
LOINC_HEART_RATE = "8867-4"
LOINC_WEIGHT     = "29463-7"
LOINC_GLUCOSE    = "15074-8"   # Glucose [Moles/volume] in Blood -> mmol/L, NOT mg/dL
LOINC_STEPS      = "41950-7"


def _now_iso_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─── Field extraction helpers for legacy docs ──────────────────────────────────

def _performer_ref_for_recorder(recorded_by: str | None, patient_id: str | None) -> str:
    """Mirrors ehr_routes.py's _performer_ref_for_recorder() so exported/derived
    Observations get a consistent performer reference regardless of which
    code path built them."""
    if recorded_by and ObjectId.is_valid(recorded_by):
        user_doc = mongo.db.users.find_one(
            {"_id": ObjectId(recorded_by)}, {"user_type": 1}
        ) or {}
        utype = user_doc.get("user_type", "patient")
        return f"{'Practitioner' if utype == 'doctor' else 'Patient'}/{recorded_by}"
    elif recorded_by:
        # Sentinel values like "health_connect" — not a real user _id.
        return f"Device/{recorded_by}"
    return f"Patient/{patient_id}"


def _extract_source(doc: dict[str, Any]) -> str:
    """Legacy docs may carry `source` as a top-level field, or buried in
    extension[] on older manual/patient-home entries (see vitals_storage.py:
    'source — promoted to a top-level field for ALL docs (previously
    buried in extension[])')."""
    if doc.get("source"):
        return doc["source"]
    for ext in doc.get("extension", []):
        if ext.get("url") == SOURCE_EXT_URL:
            return ext.get("valueString", "manual")
    return "manual"


def _extract_urgent(doc: dict[str, Any]) -> bool:
    for ext in doc.get("extension", []):
        if ext.get("url") == URGENT_FLAG_URL:
            return bool(ext.get("valueBoolean", False))
    return False


def _extract_notes(doc: dict[str, Any]) -> str:
    notes = doc.get("note") or []
    return notes[0].get("text", "") if notes else ""


def _component_value(components: list[dict], loinc: str) -> float | None:
    for comp in components:
        code_val = (comp.get("code", {}).get("coding") or [{}])[0].get("code")
        if code_val == loinc:
            return comp.get("valueQuantity", {}).get("value")
    return None


def _already_migrated(reading_id: str) -> bool:
    """Idempotency check. fan_out_reading() writes every sibling doc of a
    reading in one call, so if any per-type collection already has this
    reading_id, the whole source doc has already been migrated."""
    for coll_name in ALL_VITALS_COLLECTIONS:
        if mongo.db[coll_name].find_one({"reading_id": reading_id}, {"_id": 1}):
            return True
    return False


# ─── Writers for the two vital types fan_out_reading() does not support ───────

def _insert_blood_sugar(
    patient_id: str, recorded_by: str, source: str, performer_ref: str,
    effective_dt: str | None, glucose_value: float, notes: str,
    reading_id: str, source_doc_id: str, dry_run: bool,
) -> None:
    """
    No writer exists for vitals_blood_sugar in fan_out_reading() yet (see
    module docstring in vitals_storage.py: 'reserved — no writer yet'), so
    build the document by hand in the same shape fan_out_reading() uses for
    its other per-type docs.
    """
    logger.warning(
        "[migrate] doc=%s has a blood-glucose component (LOINC %s) but "
        "fan_out_reading() has no writer for vitals_blood_sugar — inserting "
        "directly. This is unexercised code — please spot-check the result.",
        source_doc_id, LOINC_GLUCOSE,
    )
    if dry_run:
        logger.info("[dry-run] would insert vitals_blood_sugar doc reading_id=%s value=%s",
                     reading_id, glucose_value)
        return

    bs_doc: dict[str, Any] = {
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
        "resourceType": "Observation",
        "id": str(uuid4()),
        "code": {"coding": [{
            "system": "http://loinc.org", "code": LOINC_GLUCOSE,
            "display": "Glucose [Moles/volume] in Blood",
        }]},
        # 15074-8 is the moles/volume panel -> mmol/L, not mg/dL (that's a
        # different LOINC code, 2339-0). Verify against your source data's
        # actual recorded unit before trusting this blindly.
        "valueQuantity": {"value": glucose_value, "unit": "mmol/L",
                          "system": "http://unitsofmeasure.org", "code": "mmol/L"},
    }
    if notes:
        bs_doc["note"] = [{"text": notes}]

    mongo.db[COLLECTION_BLOOD_SUGAR].insert_one(bs_doc)


def _insert_steps(
    patient_id: str, recorded_by: str, source: str,
    effective_dt: str | None, steps_value: float, reading_id: str,
    original_synced_at: str | None, dry_run: bool,
) -> None:
    """
    fan_out_reading() has no `steps` parameter — steps are written only by
    Health Connect's enrich_for_storage() (utils/fhir_health_connect.py).
    Reproduce that document shape here for pre-migration flat HC docs.
    """
    if dry_run:
        logger.info("[dry-run] would insert vitals_steps doc reading_id=%s value=%s",
                     reading_id, steps_value)
        return

    steps_doc: dict[str, Any] = {
        "resourceType": "Observation",
        "id": reading_id,
        "status": "final",
        "code": {"coding": [{"system": "http://loinc.org", "code": LOINC_STEPS,
                             "display": "Number of steps in unspecified time Pedometer"}]},
        "subject": {"reference": f"Patient/{patient_id}"},
        "effectiveDateTime": effective_dt,
        "valueQuantity": {"value": steps_value, "unit": "steps",
                          "system": "http://unitsofmeasure.org", "code": "{steps}"},
        "patient_id":  patient_id,
        "recorded_by": recorded_by,
        "source":      source,
        "device_type": "android_watch",
        "synced_at":   original_synced_at or _now_iso_utc(),
        "loinc_code":  LOINC_STEPS,
        "reading_id":  reading_id,
    }
    mongo.db[COLLECTION_STEPS].insert_one(steps_doc)


# ─── Main migration loop ───────────────────────────────────────────────────────

def migrate(dry_run: bool = False) -> dict[str, int]:
    stats = {
        "docs_seen": 0,
        "docs_migrated": 0,
        "docs_skipped_already_migrated": 0,
        "docs_skipped_no_recognized_vitals": 0,
        "blood_sugar_inserted": 0,
        "steps_inserted": 0,
    }

    for doc in mongo.db.ehr_vitals.find({}):
        stats["docs_seen"] += 1

        source_doc_id = doc.get("id") or str(doc["_id"])
        patient_id    = doc.get("patient_id")
        recorded_by   = doc.get("recorded_by", "")
        source        = _extract_source(doc)
        effective_dt  = doc.get("effectiveDateTime")
        urgent        = _extract_urgent(doc)
        notes         = _extract_notes(doc)
        performer_ref = _performer_ref_for_recorder(recorded_by, patient_id)

        # Reuse the source doc's own FHIR id as reading_id, both for
        # traceability back to ehr_vitals and so re-running this script is
        # a no-op for docs already migrated.
        reading_id = source_doc_id

        if _already_migrated(reading_id):
            stats["docs_skipped_already_migrated"] += 1
            logger.info("[migrate] doc=%s already migrated — skipping", source_doc_id)
            continue

        components = doc.get("component")

        if components:
            # ── Panel-style legacy doc: manual / patient_home entry ─────────
            systolic  = _component_value(components, LOINC_SYSTOLIC)
            diastolic = _component_value(components, LOINC_DIASTOLIC)
            pulse     = _component_value(components, LOINC_HEART_RATE)
            weight    = _component_value(components, LOINC_WEIGHT)
            glucose   = _component_value(components, LOINC_GLUCOSE)

            if all(v is None for v in (systolic, diastolic, pulse, weight, glucose)):
                stats["docs_skipped_no_recognized_vitals"] += 1
                logger.warning(
                    "[migrate] doc=%s has a component[] array but none of its "
                    "codes match a known vital-sign LOINC — skipping", source_doc_id,
                )
                continue

            if systolic is not None or diastolic is not None or pulse is not None or weight is not None:
                if dry_run:
                    logger.info(
                        "[dry-run] would fan_out_reading(reading_id=%s, systolic=%s, "
                        "diastolic=%s, pulse=%s, weight_kg=%s, urgent=%s, source=%s)",
                        reading_id, systolic, diastolic, pulse, weight, urgent, source,
                    )
                else:
                    fan_out_reading(
                        mongo.db,
                        patient_id=patient_id,
                        recorded_by=recorded_by,
                        source=source,
                        performer_ref=performer_ref,
                        effective_dt=effective_dt,
                        systolic=systolic,
                        diastolic=diastolic,
                        pulse=pulse,
                        weight_kg=weight,
                        notes=notes,
                        urgent=urgent,
                        reading_id=reading_id,
                    )

            if glucose is not None:
                _insert_blood_sugar(
                    patient_id, recorded_by, source, performer_ref, effective_dt,
                    glucose, notes, reading_id, source_doc_id, dry_run,
                )
                stats["blood_sugar_inserted"] += 1

            stats["docs_migrated"] += 1

        else:
            # ── Flat legacy doc: pre-migration Health Connect single-value sync ──
            code_val = (doc.get("code", {}).get("coding") or [{}])[0].get("code")
            value = doc.get("valueQuantity", {}).get("value")

            if value is None or code_val is None:
                stats["docs_skipped_no_recognized_vitals"] += 1
                logger.warning(
                    "[migrate] doc=%s is a flat doc missing code/valueQuantity — skipping",
                    source_doc_id,
                )
                continue

            effective_recorded_by = recorded_by or "health_connect"
            effective_source = source or "health_connect"

            if code_val == LOINC_HEART_RATE:
                if dry_run:
                    logger.info(
                        "[dry-run] would fan_out_reading(reading_id=%s, pulse=%s) for flat HC doc",
                        reading_id, value,
                    )
                else:
                    fan_out_reading(
                        mongo.db,
                        patient_id=patient_id,
                        recorded_by=effective_recorded_by,
                        source=effective_source,
                        performer_ref=performer_ref,
                        effective_dt=effective_dt,
                        pulse=value,
                        reading_id=reading_id,
                    )
                stats["docs_migrated"] += 1

            elif code_val == LOINC_STEPS:
                _insert_steps(
                    patient_id, effective_recorded_by, effective_source,
                    effective_dt, value, reading_id, doc.get("synced_at"), dry_run,
                )
                stats["steps_inserted"] += 1
                stats["docs_migrated"] += 1

            else:
                stats["docs_skipped_no_recognized_vitals"] += 1
                logger.warning(
                    "[migrate] doc=%s is a flat doc with unrecognized LOINC code '%s' — skipping",
                    source_doc_id, code_val,
                )

    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Log exactly what would be written without touching the database. Run this first.",
    )
    args = parser.parse_args()

    logger.info("Starting ehr_vitals -> per-type-collections migration (dry_run=%s)", args.dry_run)
    stats = migrate(dry_run=args.dry_run)
    logger.info("Migration complete: %s", stats)
    logger.info(
        "Original ehr_vitals documents were NOT deleted or modified. "
        "Verify via collect_readings()/GET vitals endpoints and a FHIR export "
        "diff before considering the migration final."
    )


if __name__ == "__main__":
    main()