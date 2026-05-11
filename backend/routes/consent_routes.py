"""
backend/routes/consent_routes.py
─────────────────────────────────────────────────────────────────────────────
Consent management routes (gICS + gPAS + MongoDB).

Routes
------
GET    /api/patient/consent                     patient  — own consent status + masked pseudonym
POST   /api/patient/consent                     patient  — grant consent → MongoDB → gICS → gPAS
DELETE /api/patient/consent                     patient  — revoke consent → MongoDB → gICS
GET    /api/doctor/patient/<patient_id>/consent  doctor   — read a patient's consent (read-only)

MongoDB collection: patient_consents
─────────────────────────────────────
{
  "patient_id":      str,                          # MongoDB user _id as string
  "domain":          str,                          # e.g. "morafek-data-sharing"
  "policy_version":  str,                          # e.g. "1.0"
  "status":          "granted" | "revoked" | "pending",
  "granted_at":      ISO datetime | null,
  "revoked_at":      ISO datetime | null,
  "gics_consent_id": str | null,                   # returned by gICS addConsent
  "pseudonym":       str | null,                   # returned by gPAS get_or_create
  "updated_at":      ISO datetime
}

Design decisions
─────────────────
• MongoDB is written FIRST (source of truth). gICS and gPAS calls follow; any
  failure is logged but never surfaces to the client.
• Pseudonyms are stored in BOTH patient_consents (co-located) AND
  patient_fhir_identifiers (so the FHIR export pipeline sees them unchanged).
• Pseudonyms are NEVER cleared on revoke — re-grant reuses the same pseudonym.
• The pseudonym shown to the patient is masked (last 4 chars only).
• Doctor access uses check_doctor_patient_access() so the existing
  authorization model is respected without duplication.
"""

from flask import Blueprint, request, jsonify, current_app
from datetime import datetime, timezone
from typing import Optional

from utils.auth import token_required
from utils.error_handler import api_error_handler

consent_routes = Blueprint('consent_routes', __name__)

_POLICY_VERSION = "1.0"


# ─── Helpers ───────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _mask_pseudonym(psn: Optional[str]) -> Optional[str]:
    """Return the last 4 characters visible, rest as asterisks — safe for UI display."""
    if not psn or len(psn) < 4:
        return psn
    return "*" * (len(psn) - 4) + psn[-4:]


def _format_record(record: dict) -> dict:
    """Serialize a patient_consents document for an API response."""
    return {
        "status":           record.get("status", "none"),
        "pseudonym_masked": _mask_pseudonym(record.get("pseudonym")),
        "granted_at":       record.get("granted_at"),
        "revoked_at":       record.get("revoked_at"),
    }


_EMPTY_RECORD = {
    "status":           "none",
    "pseudonym_masked": None,
    "granted_at":       None,
    "revoked_at":       None,
}


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/patient/consent  — read own status
# ─────────────────────────────────────────────────────────────────────────────

@consent_routes.route('/api/patient/consent', methods=['GET'])
@token_required
@api_error_handler
def get_my_consent(current_user):
    """Return the authenticated patient's current consent status and masked pseudonym."""
    if current_user.get('user_type') != 'patient':
        return jsonify({"error": "Patients only"}), 403

    patient_id = str(current_user['_id'])
    record = current_app.mongo.db.patient_consents.find_one({"patient_id": patient_id})

    if not record:
        return jsonify(_EMPTY_RECORD), 200

    return jsonify(_format_record(record)), 200


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/patient/consent  — grant consent
# ─────────────────────────────────────────────────────────────────────────────

@consent_routes.route('/api/patient/consent', methods=['POST'])
@token_required
@api_error_handler
def grant_consent(current_user):
    """
    Grant consent.

    Flow:
      1. Write patient_consents with status "granted" (MongoDB first — always succeeds).
      2. Call gICS addConsent — store returned ID if available.
      3. Call gPAS get_or_create — store pseudonym in patient_consents AND
         patient_fhir_identifiers.
      4. Return { status, pseudonym_assigned }.

    gICS or gPAS being down does NOT fail the request.
    """
    if current_user.get('user_type') != 'patient':
        return jsonify({"error": "Patients only"}), 403

    patient_id = str(current_user['_id'])
    db         = current_app.mongo.db
    logger     = current_app.logger

    # Lazy imports — services may be unavailable in test environments.
    from services.gics_service import gics, GICS_DOMAIN
    from services.gpas_service import gpas

    now = _now_iso()

    # ── Step 1: MongoDB — write grant record (source of truth) ────────────────
    db.patient_consents.update_one(
        {"patient_id": patient_id},
        {"$set": {
            "patient_id":     patient_id,
            "domain":         GICS_DOMAIN,
            "policy_version": _POLICY_VERSION,
            "status":         "granted",
            "granted_at":     now,
            "revoked_at":     None,
            "updated_at":     now,
        }},
        upsert=True,
    )
    logger.info("Consent granted in MongoDB for patient %s", patient_id)

    # ── Step 2: gICS — record consent ─────────────────────────────────────────
    gics_id = gics.get_or_create_consent(patient_id)
    if gics_id:
        db.patient_consents.update_one(
            {"patient_id": patient_id},
            {"$set": {"gics_consent_id": gics_id, "updated_at": _now_iso()}},
        )
        logger.info("gICS consent ID stored for patient %s: %s", patient_id, gics_id)
    else:
        logger.warning(
            "gICS unavailable during grant for patient %s — consent recorded in MongoDB only",
            patient_id,
        )

    # ── Step 3: gPAS — get or create pseudonym ────────────────────────────────
    pseudonym          = gpas.get_or_create(patient_id)
    pseudonym_assigned = False

    if pseudonym:
        pseudonym_assigned = True

        # Store in patient_consents (consent ↔ pseudonym co-located)
        db.patient_consents.update_one(
            {"patient_id": patient_id},
            {"$set": {"pseudonym": pseudonym, "updated_at": _now_iso()}},
        )

        # Keep patient_fhir_identifiers in sync so the FHIR export pipeline
        # (ehr_routes.py) sees the pseudonym without any changes on its side.
        db.patient_fhir_identifiers.update_one(
            {"patient_id": patient_id},
            {"$set": {"pseudonym": pseudonym, "patient_id": patient_id}},
            upsert=True,
        )
        logger.info("gPAS pseudonym stored for patient %s: %s", patient_id, pseudonym)
    else:
        logger.warning(
            "gPAS unavailable during grant for patient %s — pseudonym will be created on next call",
            patient_id,
        )

    return jsonify({
        "status":             "granted",
        "pseudonym_assigned": pseudonym_assigned,
    }), 200


# ─────────────────────────────────────────────────────────────────────────────
# DELETE /api/patient/consent  — revoke consent
# ─────────────────────────────────────────────────────────────────────────────

@consent_routes.route('/api/patient/consent', methods=['DELETE'])
@token_required
@api_error_handler
def revoke_consent(current_user):
    """
    Revoke consent.

    Flow:
      1. Update patient_consents: status "revoked", revoked_at = now.
         Pseudonym is intentionally NOT cleared — reused on re-grant.
      2. Call gICS revokeConsent — fire-and-forget.
      3. Return { status: "revoked" }.
    """
    if current_user.get('user_type') != 'patient':
        return jsonify({"error": "Patients only"}), 403

    patient_id = str(current_user['_id'])
    db         = current_app.mongo.db
    logger     = current_app.logger

    from services.gics_service import gics

    now = _now_iso()

    # ── Step 1: MongoDB — mark revoked ────────────────────────────────────────
    db.patient_consents.update_one(
        {"patient_id": patient_id},
        {"$set": {
            "status":     "revoked",
            "revoked_at": now,
            "updated_at": now,
            # pseudonym field intentionally left untouched
        }},
        upsert=True,
    )
    logger.info("Consent revoked in MongoDB for patient %s", patient_id)

    # ── Step 2: gICS — fire-and-forget ────────────────────────────────────────
    ok = gics.revoke_consent(patient_id)
    if not ok:
        logger.warning(
            "gICS revoke failed for patient %s — MongoDB already updated, audit trail preserved",
            patient_id,
        )

    return jsonify({"status": "revoked"}), 200


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/doctor/patient/<patient_id>/consent  — doctor read-only view
# ─────────────────────────────────────────────────────────────────────────────

@consent_routes.route('/api/doctor/patient/<patient_id>/consent', methods=['GET'])
@token_required
@api_error_handler
def get_patient_consent_doctor(current_user, patient_id):
    """
    Doctor read-only view of a patient's consent state.

    Uses check_doctor_patient_access() so the existing doctor→patient
    authorization model is respected without any duplication.
    """
    if current_user.get('user_type') != 'doctor':
        return jsonify({"error": "Doctors only"}), 403

    # Reuse the same access-check guard used throughout ehr_routes.py
    from routes.doctor_routes import check_doctor_patient_access
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    db     = current_app.mongo.db
    record = db.patient_consents.find_one({"patient_id": patient_id})

    if not record:
        return jsonify(_EMPTY_RECORD), 200

    return jsonify(_format_record(record)), 200
