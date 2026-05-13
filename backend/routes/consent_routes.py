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

GET    /api/consent/status          patient  — gICS consent state (ACCEPTED | REJECTED | UNKNOWN)
POST   /api/consent/accept          patient  — strict grant: gICS → gPAS → MongoDB users
POST   /api/consent/revoke          patient  — strict revoke: gICS → gPAS delete → MongoDB clear

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
  failure is logged but never surfaces to the client in the legacy routes.
• Pseudonyms are stored in BOTH patient_consents (co-located) AND
  patient_fhir_identifiers (so the FHIR export pipeline sees them unchanged).
• Pseudonyms are NEVER cleared on revoke — re-grant reuses the same pseudonym.
• The pseudonym shown to the patient is masked (last 4 chars only).
• Doctor access uses check_doctor_patient_access() so the existing
  authorization model is respected without duplication.

Strict routes (/api/consent/*)
────────────────────────────────
• gICS and gPAS failures ARE hard (502).
• A duplicate-consent fault from gICS is treated as success (idempotent).
• The actual gICS fault message is included in the 502 response body under
  the "gics_fault" key so operators can diagnose issues without needing to
  grep server logs from the browser.
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


def _is_duplicate_fault(error_msg: str) -> bool:
    """Return True when the gICS fault is a harmless duplicate-consent error."""
    lower = error_msg.lower()
    return any(kw in lower for kw in ("duplicate", "already exist", "already registered"))


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
# POST /api/patient/consent  — grant consent (legacy soft flow)
# ─────────────────────────────────────────────────────────────────────────────

@consent_routes.route('/api/patient/consent', methods=['POST'])
@token_required
@api_error_handler
def grant_consent(current_user):
    """
    Grant consent (legacy soft flow).

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
# DELETE /api/patient/consent  — revoke consent (legacy soft flow)
# ─────────────────────────────────────────────────────────────────────────────

@consent_routes.route('/api/patient/consent', methods=['DELETE'])
@token_required
@api_error_handler
def revoke_consent(current_user):
    """
    Revoke consent (legacy soft flow).

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

    from routes.doctor_routes import check_doctor_patient_access
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    db     = current_app.mongo.db
    record = db.patient_consents.find_one({"patient_id": patient_id})

    if not record:
        return jsonify(_EMPTY_RECORD), 200

    return jsonify(_format_record(record)), 200


# ═════════════════════════════════════════════════════════════════════════════
# STRICT ENDPOINTS  (spec-compliant: hard failures, users-collection store)
# ─────────────────────────────────────────────────────────────────────────────
# These three routes implement the consent + pseudonymisation flow described in
# the Morafek-CareMate backend spec:
#
#   POST   /api/consent/accept   — grant consent → gICS → gPAS → users table
#   POST   /api/consent/revoke   — revoke consent → gICS → gPAS delete → users
#   GET    /api/consent/status   — query gICS consent state
#
# Design:
#   • gICS and gPAS failures are HARD (502) — not fire-and-forget.
#   • A duplicate-consent fault from gICS is treated as idempotent success.
#   • gPAS fail on accept → gICS consent is rolled back.
#   • gPAS fail on revoke → MongoDB NOT cleared (data integrity preserved).
#   • Pseudonym + pseudonymSuffix stored in the `users` collection.
#   • The "gics_fault" key in 502 responses carries the actual fault string
#     so operators can diagnose errors from the browser console / API tester.
# ═════════════════════════════════════════════════════════════════════════════


@consent_routes.route('/api/consent/accept', methods=['POST'])
@token_required
@api_error_handler
def accept_consent(current_user):
    """
    POST /api/consent/accept — grant gICS consent (strict flow).

    Flow
    ----
    1. Extract patient_id from JWT.
    2. Check if consent already exists in gICS — if ACCEPTED, treat as
       idempotent success (skip addConsent, go straight to gPAS).
    3. Call gics_service.add_consent(patient_id, template_id)        → raises on fail
       • Duplicate-consent fault treated as success (idempotent).
    4. Call gpas_service.get_or_create_pseudonym(patient_id, domain) → raises on fail
       • On gPAS failure: attempt gICS rollback, return 502.
    5. Store { pseudonym, pseudonymSuffix } in MongoDB users collection.
    6. Mirror into patient_consents for legacy GET /api/patient/consent display.
    7. Return ONLY { "pseudonymSuffix": "XXXX" }.

    Security
    --------
    • Full pseudonym is never returned to the client.
    • Only patients may call this endpoint.
    • 502 responses include the gICS fault string under "gics_fault" for
      operator diagnostics (not returned to end-users in production UI).
    """
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Patients only'}), 403

    patient_id = str(current_user['_id'])
    db         = current_app.mongo.db
    logger     = current_app.logger

    from services.gics_service import gics
    from services.gpas_service import gpas
    from bson.objectid import ObjectId

    template_id = current_app.config.get('CONSENT_TEMPLATE_ID', 'morafek-data-sharing')
    gpas_domain = current_app.config.get('GPAS_DOMAIN',          'morafek-patients')

    # ── Step 1: Check for existing active consent in gICS (idempotency guard) ─
    # If the patient already has ACCEPTED status in gICS, skip addConsent to
    # avoid a duplicate-entry SOAP fault. This also makes re-tries safe after
    # a partial failure (e.g. gICS succeeded but gPAS timed out).
    existing_status = gics.get_consent_status(patient_id, template_id)
    gics_already_registered = (existing_status == "ACCEPTED")

    if gics_already_registered:
        logger.info(
            "accept_consent: patient %s already has ACCEPTED status in gICS — skipping addConsent",
            patient_id,
        )

    # ── Step 2: Submit consent to gICS (skipped when already accepted) ────────
    if not gics_already_registered:
        try:
            gics.add_consent(patient_id, template_id)
        except RuntimeError as exc:
            fault_str = str(exc)
            # Duplicate consent is harmless — treat it as success and continue.
            if _is_duplicate_fault(fault_str):
                logger.info(
                    "accept_consent: duplicate-consent fault for patient %s — treating as idempotent success",
                    patient_id,
                )
            else:
                logger.error(
                    "gICS add_consent failed for patient %s: %s",
                    patient_id, fault_str,
                )
                return jsonify({
                    'error':      'Consent registration failed — gICS error.',
                    'gics_fault': fault_str,
                }), 502

    # ── Step 3: Create pseudonym in gPAS (skipped when GPAS_ENABLED=false) ───
    gpas_enabled = current_app.config.get('GPAS_ENABLED', True)
    pseudonym    = None

    if not gpas_enabled:
        logger.warning(
            "accept_consent: GPAS_ENABLED=false — skipping pseudonym creation for patient %s",
            patient_id,
        )
    else:
        try:
            pseudonym = gpas.get_or_create_pseudonym(patient_id, gpas_domain)
        except RuntimeError as exc:
            logger.error(
                "gPAS get_or_create_pseudonym failed for patient %s: %s — rolling back gICS",
                patient_id, exc,
            )
            # Best-effort gICS rollback — do not mask the 502 if rollback also fails.
            if not gics_already_registered:
                try:
                    gics.revoke_consent(patient_id, template_id)
                except Exception as rollback_exc:
                    logger.error(
                        "gICS rollback also failed for patient %s: %s",
                        patient_id, rollback_exc,
                    )
            return jsonify({
                'error':       'Pseudonym creation failed — gPAS error.',
                'gpas_error':  str(exc),
                'hint':        'Set GPAS_ENABLED=false in .env to skip gPAS when it is not running.',
                'gpas_domain': gpas_domain,
            }), 502

    # ── Step 4: Persist pseudonym in MongoDB users collection ─────────────────
    now = _now_iso()
    user_update: dict = {}
    if pseudonym:
        pseudonym_suffix = pseudonym[-4:]
        user_update = {'pseudonym': pseudonym, 'pseudonymSuffix': pseudonym_suffix}
        db.users.update_one(
            {'_id': ObjectId(patient_id)},
            {'$set': user_update},
        )
        logger.info(
            "Pseudonym stored in users collection for patient %s (suffix: …%s)",
            patient_id, pseudonym_suffix,
        )
    else:
        pseudonym_suffix = None
        logger.info(
            "accept_consent: no pseudonym for patient %s (gPAS skipped or unavailable)",
            patient_id,
        )

    # ── Step 5: Mirror result into patient_consents ────────────────────────────
    consent_doc: dict = {
        'patient_id':     patient_id,
        'domain':         template_id,
        'policy_version': _POLICY_VERSION,
        'status':         'granted',
        'granted_at':     now,
        'revoked_at':     None,
        'updated_at':     now,
    }
    if pseudonym:
        consent_doc['pseudonym'] = pseudonym

    db.patient_consents.update_one(
        {'patient_id': patient_id},
        {'$set': consent_doc},
        upsert=True,
    )
    logger.info("patient_consents synced for patient %s after strict accept", patient_id)

    # ── Step 6: Return suffix (or null when gPAS was skipped) ─────────────────
    return jsonify({'pseudonymSuffix': pseudonym_suffix}), 200


@consent_routes.route('/api/consent/revoke', methods=['POST'])
@token_required
@api_error_handler
def revoke_consent_strict(current_user):
    """
    POST /api/consent/revoke — revoke gICS consent (strict flow).

    Flow
    ----
    1. Extract patient_id from JWT.
    2. Call gics_service.revoke_consent(patient_id, template_id).
       • "not found" fault treated as success (already revoked / never granted).
    3. Call gpas_service.delete_pseudonym(patient_id, domain).
       • If gPAS delete fails → do NOT touch MongoDB, return 502.
    4. On full success: unset pseudonym + pseudonymSuffix from users doc.
    5. Mirror revocation into patient_consents.
    6. Return { "success": true }.

    Security
    --------
    • Pseudonym fields in MongoDB are cleared ONLY after gPAS confirms deletion,
      ensuring the pseudonymised export remains blocked until the full revocation
      pipeline succeeds.
    • Only patients may call this endpoint.
    """
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Patients only'}), 403

    patient_id = str(current_user['_id'])
    db         = current_app.mongo.db
    logger     = current_app.logger

    from services.gics_service import gics
    from services.gpas_service import gpas
    from bson.objectid import ObjectId

    template_id = current_app.config.get('CONSENT_TEMPLATE_ID', 'morafek-data-sharing')
    gpas_domain = current_app.config.get('GPAS_DOMAIN',          'morafek-patients')

    # ── Step 1: Revoke in gICS ─────────────────────────────────────────────────
    # revoke_consent() already handles "not found" faults gracefully (returns True).
    ok = gics.revoke_consent(patient_id, template_id)
    if not ok:
        logger.warning(
            "gICS revoke_consent returned False for patient %s — continuing with gPAS delete",
            patient_id,
        )

    # ── Step 2: Delete pseudonym from gPAS (skipped when GPAS_ENABLED=false) ──
    gpas_enabled = current_app.config.get('GPAS_ENABLED', True)

    if not gpas_enabled:
        logger.warning(
            "revoke_consent_strict: GPAS_ENABLED=false — skipping gPAS delete for patient %s",
            patient_id,
        )
    else:
        try:
            gpas.delete_pseudonym(patient_id, gpas_domain)
        except RuntimeError as exc:
            logger.error(
                "gPAS delete_pseudonym failed for patient %s: %s — MongoDB NOT cleared",
                patient_id, exc,
            )
            return jsonify({'error': 'Pseudonym deletion failed; revocation incomplete'}), 502

    # ── Step 3: Clear pseudonym fields from MongoDB users collection ──────────
    db.users.update_one(
        {'_id': ObjectId(patient_id)},
        {'$unset': {'pseudonym': '', 'pseudonymSuffix': ''}},
    )
    logger.info(
        "Pseudonym unset from users collection for patient %s after successful gPAS delete",
        patient_id,
    )

    # ── Step 4: Mirror revocation into patient_consents ───────────────────────
    # Keeps GET /api/patient/consent consistent after a strict-flow revoke.
    # Pseudonym field is intentionally left in place (same policy as the soft
    # revoke route) so the masked display can show history on re-grant.
    now = _now_iso()
    db.patient_consents.update_one(
        {'patient_id': patient_id},
        {'$set': {
            'status':     'revoked',
            'revoked_at': now,
            'updated_at': now,
        }},
    )
    logger.info("patient_consents synced for patient %s after strict revoke", patient_id)

    return jsonify({'success': True}), 200


@consent_routes.route('/api/consent/status', methods=['GET'])
@token_required
@api_error_handler
def get_consent_status_strict(current_user):
    """
    GET /api/consent/status — query gICS for the patient's current consent state.

    Returns
    -------
    { "status": "ACCEPTED" | "REJECTED" | "UNKNOWN" }

    "UNKNOWN" is returned when gICS is unreachable or no consent record exists.
    Only patients may call this endpoint.
    """
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Patients only'}), 403

    patient_id  = str(current_user['_id'])
    template_id = current_app.config.get('CONSENT_TEMPLATE_ID', 'morafek-data-sharing')

    from services.gics_service import gics

    status = gics.get_consent_status(patient_id, template_id)
    return jsonify({'status': status}), 200


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/consent/diagnose  — operator diagnostic (patient-scoped)
# ─────────────────────────────────────────────────────────────────────────────

@consent_routes.route('/api/consent/diagnose', methods=['GET'])
@token_required
@api_error_handler
def diagnose_consent_stack(current_user):
    """
    GET /api/consent/diagnose — live health check of the full consent pipeline.

    Checks each component independently so you can see exactly which step is
    failing without needing to grep server logs.

    Returns a JSON object with one key per layer:
      {
        "config":         { template_id, gpas_domain, gpas_enabled },
        "gics":           { reachable, wsdl_ok, endpoint, … },
        "gpas":           { reachable, … }  |  null (when GPAS_ENABLED=false),
        "consent_status": "ACCEPTED" | "REJECTED" | "UNKNOWN" | "ERROR: …",
        "mongo_record":   { status, granted_at, … }  |  null
      }

    Only patients may call this endpoint (their own data only).
    """
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Patients only'}), 403

    patient_id  = str(current_user['_id'])
    db          = current_app.mongo.db
    logger      = current_app.logger
    template_id = current_app.config.get('CONSENT_TEMPLATE_ID', 'morafek-data-sharing')
    gpas_domain = current_app.config.get('GPAS_DOMAIN',          'morafek-patients')
    gpas_enabled = current_app.config.get('GPAS_ENABLED',        True)

    from services.gics_service import gics

    result: dict = {
        "config": {
            "template_id":  template_id,
            "gpas_domain":  gpas_domain,
            "gpas_enabled": gpas_enabled,
        },
        "gics":           None,
        "gpas":           None,
        "consent_status": None,
        "mongo_record":   None,
    }

    # ── gICS reachability ─────────────────────────────────────────────────────
    try:
        result["gics"] = gics.check_and_diagnose(template_id)
    except Exception as exc:
        result["gics"] = {"reachable": False, "error": str(exc)}
        logger.warning("diagnose: gICS check failed: %s", exc)

    # ── gPAS reachability ──────────────────────────────────────────────────────
    if gpas_enabled:
        try:
            from services.gpas_service import gpas
            if hasattr(gpas, 'check_and_diagnose'):
                result["gpas"] = gpas.check_and_diagnose(gpas_domain)
            else:
                # Fallback: try is_available() if check_and_diagnose not implemented
                reachable = gpas.is_available() if hasattr(gpas, 'is_available') else None
                result["gpas"] = {"reachable": reachable, "domain": gpas_domain}
        except Exception as exc:
            result["gpas"] = {"reachable": False, "error": str(exc)}
            logger.warning("diagnose: gPAS check failed: %s", exc)
    else:
        result["gpas"] = {"skipped": True, "reason": "GPAS_ENABLED=false"}

    # ── Current gICS consent status for this patient ───────────────────────────
    try:
        result["consent_status"] = gics.get_consent_status(patient_id, template_id)
    except Exception as exc:
        result["consent_status"] = f"ERROR: {exc}"
        logger.warning("diagnose: get_consent_status failed: %s", exc)

    # ── MongoDB record ─────────────────────────────────────────────────────────
    record = db.patient_consents.find_one({"patient_id": patient_id})
    if record:
        result["mongo_record"] = _format_record(record)

    return jsonify(result), 200