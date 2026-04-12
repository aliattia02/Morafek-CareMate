"""
backend/scripts/migrate_add_de_profiles.py
─────────────────────────────────────────────────────────────────────────────
One-time migration: stamp meta.profile on existing FHIR documents in MongoDB.

Run once after deploying fhir_de.py. New documents get profiles automatically
at write time; this script back-fills older records.

Usage:
  PYTHONPATH=.. python migrate_add_de_profiles.py [--dry-run]

Flags:
  --dry-run   : Print what would change without writing to DB.

The script is safe to run multiple times — it is idempotent.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from config import mongo  # noqa: E402 — needs sys.path set first
from utils.fhir_de import PROFILE  # noqa: E402

DRY_RUN = "--dry-run" in sys.argv

# ── Collections and the profiles that go on their documents ──────────────────
MIGRATIONS = [
    {
        "collection": "ehr_vitals",
        "resource_type": "Observation",
        "profiles": [
            PROFILE.OBSERVATION_DE,
            PROFILE.ISIK_OBSERVATION_VITALS,
        ],
    },
    {
        "collection": "ehr_visits",
        "resource_type": "Encounter",
        "profiles": [
            PROFILE.ENCOUNTER_DE,
            PROFILE.ISIK_ENCOUNTER,
        ],
    },
    {
        "collection": "ehr_conditions",
        "resource_type": "Condition",
        "profiles": [
            PROFILE.CONDITION_DE,
            PROFILE.ISIK_CONDITION,
        ],
    },
    {
        "collection": "ehr_documents",
        "resource_type": "DocumentReference",
        "profiles": [
            PROFILE.ISIK_DOCUMENT_REFERENCE,
        ],
    },
]


def stamp_profiles(doc: dict, profiles: list[str]) -> list[str]:
    """Return list of profile URLs that need to be added to this document."""
    existing = doc.get("meta", {}).get("profile", [])
    return [p for p in profiles if p not in existing]


def run():
    total_updated = 0

    for spec in MIGRATIONS:
        collection_name = spec["collection"]
        profiles        = spec["profiles"]
        coll            = getattr(mongo.db, collection_name)

        docs = list(coll.find({}))
        updated = 0

        for doc in docs:
            to_add = stamp_profiles(doc, profiles)
            if not to_add:
                continue

            existing = doc.get("meta", {}).get("profile", [])
            new_profile_list = existing + to_add

            if DRY_RUN:
                print(f"[DRY RUN] {collection_name}/{doc['_id']}: "
                      f"would add {to_add}")
            else:
                coll.update_one(
                    {"_id": doc["_id"]},
                    {"$set": {"meta.profile": new_profile_list}},
                )
            updated += 1

        print(f"{'[DRY RUN] ' if DRY_RUN else ''}"
              f"{collection_name}: {updated}/{len(docs)} documents updated")
        total_updated += updated

    print(f"\n{'[DRY RUN] ' if DRY_RUN else ''}"
          f"Total: {total_updated} documents updated across {len(MIGRATIONS)} collections.")
    if DRY_RUN:
        print("Run without --dry-run to apply changes.")


if __name__ == "__main__":
    run()
