"""
backend/routes/consent_routes.py
─────────────────────────────────────────────────────────────────────────────
Consent management routes (gICS + gPAS + MongoDB).

Routes
------
GET    /api/patient/consent                     patient  — own consent status + masked pseudonym
POST   /api/patient/consent                     patient  — grant consent → gICS → gPAS → MongoDB
DELETE /api/patient/consent                     patient  — revoke (soft): gICS → MongoDB only
GET    /api/doctor/patient/<patient_id>/consent  doctor   — read a patient's consent (read-only)

GET    /api/consent/status          patient  — gICS consent state (ACCEPTED | REJECTED | UNKNOWN)
POST   /api/consent/accept          patient  — strict grant:  gICS → gPAS → MongoDB
POST   /api/consent/revoke          patient  — strict revoke: gICS → MongoDB (pseudonym kept)
POST   /api/consent/admin/reactivate/<patient_id>
                                    doctor/admin — facility reactivation: gPAS delete → new
                                                   pseudonym → gICS accept → MongoDB update

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
GRANT ORDER  : gICS → gPAS → MongoDB (MongoDB is written LAST, never first).
               This ensures the database only records what the consent stack
               actually accepted — no orphaned "granted" records when gICS
               or gPAS are unreachable.

REVOKE       : Only marks status=revoked in gICS and MongoDB.
               Pseudonym is intentionally NOT deleted from gPAS or cleared
               from MongoDB on revoke. This preserves the pseudonym for
               re-grant (patient flow returns the same suffix) and keeps
               the audit trail intact.

EXPORT GATE  : fhir_export_pseudonymised() checks BOTH:
                 • patient_consents.status == "granted"
                 • users.pseudonym present
               A revoked patient has a pseudonym in MongoDB but status !=
               "granted", so the export is correctly blocked.

PATIENT REACTIVATION
               POST /api/consent/accept: gPAS is idempotent (get_or_create).
               Same pseudonym is returned → same suffix shown to patient.

FACILITY REACTIVATION  (POST /api/consent/admin/reactivate/<patient_id>)
               Deletes old pseudonym from gPAS, creates a brand-new one,
               re-accepts in gICS, and updates MongoDB.  This is the ONLY
               path that produces a new pseudonym for a patient.

Strict routes (/api/consent/*)
────────────────────────────────
• gICS and gPAS failures ARE hard (502).
• A duplicate-consent fault from gICS is treated as success (idempotent).
• The actual gICS fault message is included in the 502 response body under
  the "gics_fault" key so operators can diagnose issues without log access.
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

    Flow
    ----
    1. Call gICS addConsent (fire-and-forget — failure is logged, not raised).
    2. Call gPAS get_or_create (fire-and-forget — failure is logged, not raised).
    3. Write patient_consents + patient_fhir_identifiers in ONE atomic update
       at the end with whatever gICS/gPAS returned.

    MongoDB is written LAST so it only records what the consent stack actually
    accepted.  If gICS and gPAS are both unreachable the route still succeeds
    and records a "granted" record in MongoDB with null gics_consent_id and
    null pseudonym; the pseudonym will be filled on the next successful call.

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

    # ── Step 1: gICS — record consent (fire-and-forget) ──────────────────────
    gics_id = gics.get_or_create_consent(patient_id)
    if gics_id:
        logger.info("gICS consent ID obtained for patient %s: %s", patient_id, gics_id)
    else:
        logger.warning(
            "gICS unavailable during grant for patient %s — will record in MongoDB without gics_id",
            patient_id,
        )

    # ── Step 2: gPAS — get or create pseudonym (fire-and-forget) ─────────────
    pseudonym          = gpas.get_or_create(patient_id)
    pseudonym_assigned = bool(pseudonym)

    if pseudonym:
        logger.info("gPAS pseudonym obtained for patient %s: %s", patient_id, pseudonym)
    else:
        logger.warning(
            "gPAS unavailable during grant for patient %s — pseudonym will be created on next call",
            patient_id,
        )

    # ── Step 3: MongoDB — write grant record AFTER gICS+gPAS ─────────────────
    # Single upsert that captures everything we got above in one operation.
    mongo_update: dict = {
        "patient_id":     patient_id,
        "domain":         GICS_DOMAIN,
        "policy_version": _POLICY_VERSION,
        "status":         "granted",
        "granted_at":     now,
        "revoked_at":     None,
        "updated_at":     now,
    }
    if gics_id:
        mongo_update["gics_consent_id"] = gics_id
    if pseudonym:
        mongo_update["pseudonym"] = pseudonym

    db.patient_consents.update_one(
        {"patient_id": patient_id},
        {"$set": mongo_update},
        upsert=True,
    )
    logger.info("Consent granted in MongoDB for patient %s (gics_id=%s, pseudonym_assigned=%s)",
                patient_id, bool(gics_id), pseudonym_assigned)

    # Mirror pseudonym into patient_fhir_identifiers so the FHIR export
    # pipeline sees it without any changes on its side.
    if pseudonym:
        db.patient_fhir_identifiers.update_one(
            {"patient_id": patient_id},
            {"$set": {"pseudonym": pseudonym, "patient_id": patient_id}},
            upsert=True,
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

    Flow
    ----
    1. Update patient_consents: status "revoked", revoked_at = now.
       Pseudonym is intentionally NOT cleared — re-grant reuses same pseudonym.
    2. Call gICS revokeConsent — fire-and-forget.
    3. Return { status: "revoked" }.

    gPAS is NOT touched on revoke.  The pseudonym remains in gPAS and MongoDB
    so the patient can reactivate later and get the same pseudonym back
    (gPAS getOrCreatePseudonymFor is idempotent).

    Export is blocked by the status check in fhir_export_pseudonymised(), not
    by clearing the pseudonym field.
    """
    if current_user.get('user_type') != 'patient':
        return jsonify({"error": "Patients only"}), 403

    patient_id = str(current_user['_id'])
    db         = current_app.mongo.db
    logger     = current_app.logger

    from services.gics_service import gics

    now = _now_iso()

    # ── Step 1: MongoDB — mark revoked (pseudonym field left untouched) ───────
    db.patient_consents.update_one(
        {"patient_id": patient_id},
        {"$set": {
            "status":     "revoked",
            "revoked_at": now,
            "updated_at": now,
            # pseudonym field intentionally NOT cleared
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
# POST   /api/consent/accept   — strict grant:  gICS → gPAS → MongoDB
# POST   /api/consent/revoke   — strict revoke: gICS → MongoDB (pseudonym kept)
# GET    /api/consent/status   — query gICS consent state
# POST   /api/consent/admin/reactivate/<patient_id>
#                              — facility reactivation: new pseudonym from gPAS
#
# Design:
#   • gICS and gPAS failures are HARD (502) — not fire-and-forget.
#   • A duplicate-consent fault from gICS is treated as idempotent success.
#   • Pseudonym is NEVER deleted from gPAS on revoke — only the status flag
#     changes.  The export gate (fhir_export_pseudonymised) checks BOTH the
#     pseudonym field AND status == "granted".
#   • The "gics_fault" key in 502 responses carries the fault string for
#     operator diagnostics.
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
    2. Check gICS — if already ACCEPTED, skip addConsent (idempotency guard).
    3. Call gics.add_consent(patient_id, template_id)        → hard failure.
       Duplicate-consent fault treated as idempotent success.
    4. Call gpas.get_or_create_pseudonym(patient_id, domain) → hard failure.
       On gPAS failure: attempt gICS rollback, return 502.
    5. Write MongoDB (users + patient_consents) AFTER gICS and gPAS succeed.
    6. Return ONLY { "pseudonymSuffix": "XXXX" }.

    Patient reactivation
    --------------------
    gPAS is idempotent (getOrCreatePseudonymFor): if the pseudonym was NOT
    deleted from gPAS during revoke, the same pseudonym is returned here,
    giving the patient the same suffix they had before.

    Security
    --------
    Full pseudonym is never returned to the client.
    Only patients may call this endpoint.
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

    # ── Step 1: Check existing gICS consent (idempotency guard) ──────────────
    existing_status = gics.get_consent_status(patient_id, template_id)
    gics_already_registered = (existing_status == "ACCEPTED")

    if gics_already_registered:
        logger.info(
            "accept_consent: patient %s already ACCEPTED in gICS — skipping addConsent",
            patient_id,
        )

    # ── Step 2: Submit consent to gICS ────────────────────────────────────────
    if not gics_already_registered:
        try:
            gics.add_consent(patient_id, template_id)
        except RuntimeError as exc:
            fault_str = str(exc)
            if _is_duplicate_fault(fault_str):
                logger.info(
                    "accept_consent: duplicate-consent fault for patient %s — idempotent success",
                    patient_id,
                )
            else:
                logger.error("gICS add_consent failed for patient %s: %s", patient_id, fault_str)
                return jsonify({
                    'error':      'Consent registration failed — gICS error.',
                    'gics_fault': fault_str,
                }), 502

    # ── Step 3: Get or create pseudonym in gPAS ───────────────────────────────
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
                'hint':        'Set GPAS_ENABLED=false in .env to skip gPAS when not running.',
                'gpas_domain': gpas_domain,
            }), 502

    # ── Step 4: Persist in MongoDB AFTER gICS and gPAS have both succeeded ────
    now = _now_iso()
    pseudonym_suffix: Optional[str] = None

    if pseudonym:
        pseudonym_suffix = pseudonym[-4:]
        db.users.update_one(
            {'_id': ObjectId(patient_id)},
            {'$set': {'pseudonym': pseudonym, 'pseudonymSuffix': pseudonym_suffix}},
        )
        logger.info(
            "Pseudonym stored in users for patient %s (suffix: …%s)",
            patient_id, pseudonym_suffix,
        )
    else:
        logger.info(
            "accept_consent: no pseudonym for patient %s (gPAS skipped or unavailable)",
            patient_id,
        )

    # ── Step 5: Mirror into patient_consents ──────────────────────────────────
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

    return jsonify({'pseudonymSuffix': pseudonym_suffix}), 200


@consent_routes.route('/api/consent/revoke', methods=['POST'])
@token_required
@api_error_handler
def revoke_consent_strict(current_user):
    """
    POST /api/consent/revoke — revoke gICS consent (strict flow).

    Flow
    ----
    1. Call gics.revoke_consent(patient_id, template_id).
       "not found" faults are treated as success (already revoked / never granted).
    2. Update patient_consents: status="revoked", revoked_at=now.
       Pseudonym is intentionally NOT touched in patient_consents or users.
    3. Return { "success": true }.

    Why pseudonym is kept
    ─────────────────────
    Keeping the pseudonym in gPAS and MongoDB on revoke means:
      • Patient reactivation (POST /api/consent/accept) returns the SAME suffix
        via gPAS idempotency — no new pseudonym, audit trail is continuous.
      • Export is blocked by the status check, not by pseudonym absence.
      • If a facility needs a BRAND-NEW pseudonym, use the admin reactivation
        endpoint (POST /api/consent/admin/reactivate/<patient_id>) instead.

    Security
    --------
    • Export gate checks BOTH status == "granted" AND pseudonym present.
      Revoked status alone is sufficient to block the export.
    • Only patients may call this endpoint.
    """
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Patients only'}), 403

    patient_id = str(current_user['_id'])
    db         = current_app.mongo.db
    logger     = current_app.logger

    from services.gics_service import gics

    template_id = current_app.config.get('CONSENT_TEMPLATE_ID', 'morafek-data-sharing')

    # ── Step 1: Revoke in gICS ─────────────────────────────────────────────────
    ok = gics.revoke_consent(patient_id, template_id)
    if not ok:
        logger.warning(
            "gICS revoke_consent returned False for patient %s — continuing with MongoDB update",
            patient_id,
        )

    # ── Step 2: Mark revoked in MongoDB — pseudonym fields left intact ─────────
    # NOTE: We do NOT call gpas.delete_pseudonym() here.
    # NOTE: We do NOT $unset pseudonym / pseudonymSuffix from users.
    # The pseudonym survives so patient reactivation gets the same suffix back.
    now = _now_iso()
    db.patient_consents.update_one(
        {'patient_id': patient_id},
        {'$set': {
            'status':     'revoked',
            'revoked_at': now,
            'updated_at': now,
            # pseudonym field intentionally NOT touched
        }},
    )
    logger.info(
        "Consent revoked for patient %s — pseudonym retained in gPAS and MongoDB",
        patient_id,
    )

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


# ═════════════════════════════════════════════════════════════════════════════
# POST /api/consent/admin/reactivate/<patient_id>
# ─────────────────────────────────────────────────────────────────────────────
# Facility-initiated reactivation.  This is the ONLY flow that produces a
# brand-new pseudonym for a patient.  Use this when:
#   • A hospital/facility is re-enrolling a patient after a revocation, and
#   • The facility policy requires a fresh pseudonym (new research cohort, etc.)
#
# Patient-initiated reactivation should use POST /api/consent/accept instead,
# which returns the existing pseudonym via gPAS idempotency.
# ═════════════════════════════════════════════════════════════════════════════

@consent_routes.route('/api/consent/admin/reactivate/<patient_id>', methods=['POST'])
@token_required
@api_error_handler
def admin_reactivate_consent(current_user, patient_id):
    """
    POST /api/consent/admin/reactivate/<patient_id>
    Facility-initiated reactivation — issues a NEW pseudonym.

    Flow
    ----
    1. Authorise caller: must be doctor or admin.
    2. Delete old pseudonym from gPAS (hard failure).
       "not found" treated as success (already gone or never created).
    3. Create fresh pseudonym in gPAS (hard failure).
    4. Re-accept in gICS (hard failure; duplicate treated as success).
    5. Update MongoDB users + patient_consents with the new pseudonym.
    6. Return { "pseudonymSuffix": "XXXX" }.

    This endpoint is intentionally NOT available to patients.
    Patients reactivating themselves get the SAME pseudonym via idempotent
    POST /api/consent/accept.
    """
    caller_type = current_user.get('user_type')
    if caller_type not in ('doctor', 'admin'):
        return jsonify({'error': 'Doctors and admins only'}), 403

    db     = current_app.mongo.db
    logger = current_app.logger

    from services.gics_service import gics
    from services.gpas_service import gpas
    from bson.objectid import ObjectId

    template_id = current_app.config.get('CONSENT_TEMPLATE_ID', 'morafek-data-sharing')
    gpas_domain = current_app.config.get('GPAS_DOMAIN',          'morafek-patients')
    gpas_enabled = current_app.config.get('GPAS_ENABLED',        True)

    # ── Step 1: Delete old pseudonym from gPAS ────────────────────────────────
    if gpas_enabled:
        try:
            gpas.delete_pseudonym(patient_id, gpas_domain)
            logger.info(
                "admin_reactivate: old pseudonym deleted from gPAS for patient %s", patient_id,
            )
        except RuntimeError as exc:
            logger.error(
                "admin_reactivate: gPAS delete_pseudonym failed for patient %s: %s",
                patient_id, exc,
            )
            return jsonify({
                'error':      'Could not delete old pseudonym from gPAS.',
                'gpas_error': str(exc),
            }), 502

        # ── Step 2: Create fresh pseudonym in gPAS ────────────────────────────
        try:
            new_pseudonym = gpas.get_or_create_pseudonym(patient_id, gpas_domain)
        except RuntimeError as exc:
            logger.error(
                "admin_reactivate: gPAS get_or_create_pseudonym failed for patient %s: %s",
                patient_id, exc,
            )
            return jsonify({
                'error':      'Could not create new pseudonym in gPAS.',
                'gpas_error': str(exc),
            }), 502
    else:
        logger.warning(
            "admin_reactivate: GPAS_ENABLED=false — skipping pseudonym rotation for patient %s",
            patient_id,
        )
        new_pseudonym = None

    # ── Step 3: Re-accept in gICS ─────────────────────────────────────────────
    try:
        gics.add_consent(patient_id, template_id)
    except RuntimeError as exc:
        fault_str = str(exc)
        if _is_duplicate_fault(fault_str):
            logger.info(
                "admin_reactivate: duplicate gICS consent for patient %s — treated as success",
                patient_id,
            )
        else:
            logger.error(
                "admin_reactivate: gICS add_consent failed for patient %s: %s",
                patient_id, fault_str,
            )
            return jsonify({
                'error':      'gICS re-accept failed.',
                'gics_fault': fault_str,
            }), 502

    # ── Step 4: Update MongoDB with new pseudonym ──────────────────────────────
    now = _now_iso()
    new_suffix: Optional[str] = None

    if new_pseudonym:
        new_suffix = new_pseudonym[-4:]
        db.users.update_one(
            {'_id': ObjectId(patient_id)},
            {'$set': {'pseudonym': new_pseudonym, 'pseudonymSuffix': new_suffix}},
        )
        db.patient_fhir_identifiers.update_one(
            {'patient_id': patient_id},
            {'$set': {'pseudonym': new_pseudonym, 'patient_id': patient_id}},
            upsert=True,
        )

    consent_doc: dict = {
        'status':         'granted',
        'granted_at':     now,
        'revoked_at':     None,
        'updated_at':     now,
    }
    if new_pseudonym:
        consent_doc['pseudonym'] = new_pseudonym

    db.patient_consents.update_one(
        {'patient_id': patient_id},
        {'$set': consent_doc},
    )
    logger.info(
        "admin_reactivate: patient %s reactivated by %s (%s) — new suffix …%s",
        patient_id, str(current_user.get('_id')), caller_type, new_suffix,
    )

    return jsonify({'pseudonymSuffix': new_suffix}), 200


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/consent/diagnose  — operator diagnostic (patient-scoped)
# ─────────────────────────────────────────────────────────────────────────────

@consent_routes.route('/api/consent/diagnose', methods=['GET'])
@token_required
@api_error_handler
def diagnose_consent_stack(current_user):
    """
    GET /api/consent/diagnose — live health check of the full consent pipeline.

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

    try:
        result["gics"] = gics.check_and_diagnose(template_id)
    except Exception as exc:
        result["gics"] = {"reachable": False, "error": str(exc)}
        logger.warning("diagnose: gICS check failed: %s", exc)

    if gpas_enabled:
        try:
            from services.gpas_service import gpas
            if hasattr(gpas, 'check_and_diagnose'):
                result["gpas"] = gpas.check_and_diagnose(gpas_domain)
            else:
                reachable = gpas.is_available() if hasattr(gpas, 'is_available') else None
                result["gpas"] = {"reachable": reachable, "domain": gpas_domain}
        except Exception as exc:
            result["gpas"] = {"reachable": False, "error": str(exc)}
            logger.warning("diagnose: gPAS check failed: %s", exc)
    else:
        result["gpas"] = {"skipped": True, "reason": "GPAS_ENABLED=false"}

    try:
        result["consent_status"] = gics.get_consent_status(patient_id, template_id)
    except Exception as exc:
        result["consent_status"] = f"ERROR: {exc}"
        logger.warning("diagnose: get_consent_status failed: %s", exc)

    record = db.patient_consents.find_one({"patient_id": patient_id})
    if record:
        result["mongo_record"] = _format_record(record)

    return jsonify(result), 200