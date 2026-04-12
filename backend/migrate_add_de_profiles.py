"""
backend/migrate_add_de_profiles.py
─────────────────────────────────────────────────────────────────────────────
One-time migration: stamp meta.profile on existing FHIR documents in MongoDB.

Run once after deploying fhir_de.py. New documents get profiles automatically
at write time; this script back-fills older records.

Usage (from the backend/ directory):
  python migrate_add_de_profiles.py [--dry-run]

Flags:
  --dry-run : Print what would change without writing to DB.

The script is idempotent — safe to run multiple times.
"""

import sys
import os

# ── Bootstrap Flask app so Flask-PyMongo initialises mongo.db ────────────────
# This MUST happen before any import that touches `mongo` or `config`.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from main import app  # noqa: E402 — creates the Flask app + connects MongoDB

DRY_RUN = "--dry-run" in sys.argv


def run():
    # All DB access must happen inside an app context
    with app.app_context():
        from config import mongo                # noqa: E402
        from utils.fhir_de import PROFILE       # noqa: E402

        migrations = [
            {
                "collection": "ehr_vitals",
                "profiles": [
                    PROFILE.OBSERVATION_DE,
                    PROFILE.ISIK_OBSERVATION_VITALS,
                ],
            },
            {
                "collection": "ehr_visits",
                "profiles": [
                    PROFILE.ENCOUNTER_DE,
                    PROFILE.ISIK_ENCOUNTER,
                ],
            },
            {
                "collection": "ehr_conditions",
                "profiles": [
                    PROFILE.CONDITION_DE,
                    PROFILE.ISIK_CONDITION,
                ],
            },
            {
                "collection": "ehr_documents",
                "profiles": [
                    PROFILE.ISIK_DOCUMENT_REFERENCE,
                ],
            },
        ]

        total_updated = 0

        for spec in migrations:
            collection_name = spec["collection"]
            profiles        = spec["profiles"]
            coll            = mongo.db[collection_name]   # dict-style — never None

            docs    = list(coll.find({}))
            updated = 0

            for doc in docs:
                existing  = doc.get("meta", {}).get("profile", [])
                to_add    = [p for p in profiles if p not in existing]
                if not to_add:
                    continue

                if DRY_RUN:
                    print(f"[DRY RUN] {collection_name}/{doc['_id']}: would add {to_add}")
                else:
                    coll.update_one(
                        {"_id": doc["_id"]},
                        {"$set": {"meta.profile": existing + to_add}},
                    )
                updated += 1

            prefix = "[DRY RUN] " if DRY_RUN else ""
            print(f"{prefix}{collection_name}: {updated}/{len(docs)} documents updated")
            total_updated += updated

        print(f"\n{'[DRY RUN] ' if DRY_RUN else ''}"
              f"Total: {total_updated} documents updated across {len(migrations)} collections.")
        if DRY_RUN:
            print("Run without --dry-run to apply changes.")


if __name__ == "__main__":
    run()