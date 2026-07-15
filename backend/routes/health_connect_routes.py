"""
health_connect_routes.py — Google Health Connect Integration Endpoints
==============================================================================
Flask Blueprint that receives FHIR R4 Observations from the mobile Health
Connect integration and stores them in the per-type vitals_* collections
(see utils/vitals_storage.py — this route no longer writes to the legacy
shared ehr_vitals collection).

Unlike the Google Fit integration in watch_sync_routes.py, there is NO OAuth
flow, NO server-side token storage, and NO background scheduler. Health
Connect is on-device; the mobile app reads data locally and pushes FHIR
Observations to this endpoint. The backend simply validates and persists them.

Endpoints
─────────
  POST   /api/healthconnect/sync    — receive FHIR Observations, validate,
                                      upsert into the vitals_* collection
                                      given by LOINC_TO_COLLECTION
  GET    /api/healthconnect/status  — last sync time + per-type record counts
  DELETE /api/healthconnect/data    — GDPR/DSGVO: erase all HC-sourced records
                                      for this patient from every vitals_*
                                      collection

Register in main.py:
    from routes.health_connect_routes import health_connect_bp
    app.register_blueprint(health_connect_bp)

Index recommendation (add once in main.py or a migration script, one per
collection Health Connect writes to — see ALLOWED_HC_LOINC_CODES):
    mongo.db.vitals_heart_rate.create_index(
        [("patient_id", 1), ("source", 1), ("synced_at", -1)],
        name="hc_patient_source_synced",
        background=True,
    )
    mongo.db.vitals_steps.create_index(
        [("patient_id", 1), ("source", 1), ("synced_at", -1)],
        name="hc_patient_source_synced",
        background=True,
    )

Author: Morafek CareMate Team
==============================================================================
"""

import logging
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request
from pymongo import UpdateOne

from config import mongo
from utils.auth import token_required
from utils.error_handler import api_error_handler
from utils.fhir_health_connect import (
    HCValidationError,
    build_hc_status_response,
    enrich_for_storage,
    validate_hc_observation,
)
from utils.vitals_storage import ALL_VITALS_COLLECTIONS, LOINC_TO_COLLECTION

logger = logging.getLogger(__name__)

health_connect_bp = Blueprint("health_connect", __name__)

# ── Safety cap: reject batches larger than this ───────────────────────────────
_MAX_OBSERVATIONS_PER_REQUEST: int = 2_000


# ─────────────────────────────────────────────────────────────────────────────
# 1. POST /api/healthconnect/sync
# ─────────────────────────────────────────────────────────────────────────────


@health_connect_bp.route("/api/healthconnect/sync", methods=["POST"])
@token_required
@api_error_handler
def sync_health_connect(current_user):
    """
    Accept an array of FHIR R4 Observations produced by the mobile
    Health Connect mapper and upsert each one into the per-type vitals_*
    collection given by LOINC_TO_COLLECTION[loinc_code] (e.g. heart-rate
    observations go to vitals_heart_rate, steps to vitals_steps).

    Each observation is validated individually. Invalid observations are
    counted as skipped (not inserted) and their errors are logged, but they
    do NOT abort the rest of the batch — partial success is acceptable so
    that a single bad record doesn't block a 200-record sync.

    Duplicate detection: upsert is keyed on `id` (the client-generated UUID).
    If the same observation is sent twice (e.g. user taps Sync twice before
    the UI refreshes), the second upsert is a no-op (matched but not modified).

    Request body (JSON):
        {
          "observations": [ <FHIR R4 Observation>, ... ]
        }

    Response 200:
        {
          "message":  "Sync complete — X observation(s) inserted",
          "received": int,    — total observations in the request
          "inserted": int,    — newly stored
          "skipped":  int,    — duplicates + validation failures
          "errors":   [       — per-observation validation failure details
            { "index": int, "id": str|null, "field": str, "reason": str }
          ]
        }

    Response 400: body missing or not JSON
    Response 422: every single observation in the batch failed validation
    """
    body = request.get_json(silent=True) or {}
    user_id = str(current_user["_id"])

    raw_observations: list = body.get("observations", [])

    if not isinstance(raw_observations, list):
        return jsonify({"error": "'observations' must be a JSON array"}), 400

    if not raw_observations:
        return jsonify({
            "message":  "Sync complete — no observations received",
            "received": 0,
            "inserted": 0,
            "skipped":  0,
            "errors":   [],
        }), 200

    if len(raw_observations) > _MAX_OBSERVATIONS_PER_REQUEST:
        return jsonify({
            "error": (
                f"Batch too large: {len(raw_observations)} observations "
                f"exceeds the limit of {_MAX_OBSERVATIONS_PER_REQUEST}. "
                "Split the request into smaller batches."
            )
        }), 413

    # ── Validate each observation ─────────────────────────────────────────────
    # Bulk write ops are grouped per target collection, since each LOINC
    # code routes to its own vitals_* collection (LOINC_TO_COLLECTION) and
    # bulk_write() only operates against a single collection at a time.
    valid_ops_by_collection: dict[str, list[UpdateOne]] = {}
    errors: list[dict] = []

    for idx, obs in enumerate(raw_observations):
        if not isinstance(obs, dict):
            errors.append({
                "index":  idx,
                "id":     None,
                "field":  "root",
                "reason": "Observation must be a JSON object",
            })
            continue

        obs_id = obs.get("id", "")

        try:
            loinc_code = validate_hc_observation(obs, user_id)
        except HCValidationError as exc:
            logger.debug(
                "[hc_sync] user=%s obs_index=%d id=%s validation_error: %s",
                user_id, idx, obs_id, exc,
            )
            errors.append({"index": idx, "id": obs_id, **exc.to_dict()})
            continue

        # Enrich with server-side fields (including reading_id)
        enriched = enrich_for_storage(dict(obs), user_id, loinc_code)

        # loinc_code was already checked against ALLOWED_HC_LOINC_CODES in
        # validate_hc_observation(), and ALLOWED_HC_LOINC_CODES is reconciled
        # against LOINC_TO_COLLECTION at import time, so this lookup cannot
        # KeyError in practice.
        collection_name = LOINC_TO_COLLECTION[loinc_code]

        # Build an upsert operation keyed on the client UUID
        # This makes the sync endpoint idempotent.
        valid_ops_by_collection.setdefault(collection_name, []).append(
            UpdateOne(
                filter={"id": enriched["id"]},
                update={"$setOnInsert": enriched},
                upsert=True,
            )
        )

    # ── Bulk write, one batch per target collection ───────────────────────────
    inserted_count = 0

    for collection_name, ops in valid_ops_by_collection.items():
        result = mongo.db[collection_name].bulk_write(ops, ordered=False)
        # upserted_count = newly inserted documents
        # modified_count will be 0 because we use $setOnInsert
        inserted_count += result.upserted_count

    skipped_count = len(raw_observations) - inserted_count

    logger.info(
        "[hc_sync] user=%s received=%d inserted=%d skipped=%d errors=%d",
        user_id,
        len(raw_observations),
        inserted_count,
        skipped_count,
        len(errors),
    )

    # If every single observation failed validation, return 422
    if errors and not valid_ops_by_collection:
        return jsonify({
            "message":  "No observations were stored — all failed validation",
            "received": len(raw_observations),
            "inserted": 0,
            "skipped":  len(raw_observations),
            "errors":   errors,
        }), 422

    return jsonify({
        "message":  f"Sync complete — {inserted_count} observation(s) inserted",
        "received": len(raw_observations),
        "inserted": inserted_count,
        "skipped":  skipped_count,
        "errors":   errors,   # empty list when no validation failures
    }), 200


# ─────────────────────────────────────────────────────────────────────────────
# 2. GET /api/healthconnect/status
# ─────────────────────────────────────────────────────────────────────────────


@health_connect_bp.route("/api/healthconnect/status", methods=["GET"])
@token_required
@api_error_handler
def health_connect_status(current_user):
    """
    Return the Health Connect sync status for the authenticated patient.

    This queries the small, fixed set of vitals_* collections that Health
    Connect writes to (see build_hc_status_response() in
    utils/fhir_health_connect.py). The response is used by the mobile
    settings screen to display:
      • whether any HC data exists
      • the last sync timestamp
      • per-type observation counts (heart_rate, steps, ...)

    Response 200:
        {
          "has_data":  bool,
          "last_sync": str | null,    — ISO-8601 of most recently synced_at
          "counts": {
              "heart_rate": int,
              "steps":      int
          }
        }
    """
    user_id = str(current_user["_id"])
    status  = build_hc_status_response(user_id, mongo.db)
    return jsonify(status), 200


# ─────────────────────────────────────────────────────────────────────────────
# 3. DELETE /api/healthconnect/data
# ─────────────────────────────────────────────────────────────────────────────


@health_connect_bp.route("/api/healthconnect/data", methods=["DELETE"])
@token_required
@api_error_handler
def delete_health_connect_data(current_user):
    """
    GDPR/DSGVO Article 17 — Right to erasure (selective).

    Deletes all Health Connect sourced observations for the authenticated
    patient from every per-type vitals_* collection (see
    utils.vitals_storage.ALL_VITALS_COLLECTIONS). This is for selective HC
    data withdrawal — the patient's manually recorded vitals, visits, and
    other records are NOT affected, since those share the same collections
    but carry a different `source` value.

    Also sweeps the legacy ehr_vitals collection for any HC-sourced docs
    that predate the per-type-collection migration and haven't been backfilled
    yet, so a patient's erasure request is honored regardless of where their
    data physically lives.

    For full account erasure, use DELETE /api/auth/delete-account which
    wipes all vitals_* (and legacy ehr_vitals) documents regardless of
    source, along with all other patient collections. That endpoint already
    covers HC-sourced records automatically since they share the same
    collections.

    Response 200:
        {
          "message":       "Health Connect data deleted",
          "deleted_count": int
        }
    """
    user_id = str(current_user["_id"])

    hc_filter = {"patient_id": user_id, "source": "health_connect"}

    deleted_count = 0
    for collection_name in ALL_VITALS_COLLECTIONS:
        result = mongo.db[collection_name].delete_many(hc_filter)
        deleted_count += result.deleted_count

    # Legacy pre-migration data, if any is still sitting in ehr_vitals.
    legacy_result = mongo.db.ehr_vitals.delete_many(hc_filter)
    deleted_count += legacy_result.deleted_count

    logger.info(
        "[hc_delete] user=%s deleted %d HC-sourced observations across "
        "vitals_* collections (including legacy ehr_vitals)",
        user_id, deleted_count,
    )

    return jsonify({
        "message":       "Health Connect data deleted",
        "deleted_count": deleted_count,
    }), 200
