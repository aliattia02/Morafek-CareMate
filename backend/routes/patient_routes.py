from flask import Blueprint, jsonify, request
from bson.objectid import ObjectId
from utils.auth import token_required
from utils.error_handler import api_error_handler
from utils.fhir_de import build_fhir_patient
from config import mongo
import logging

logger = logging.getLogger(__name__)

patient_routes = Blueprint('patient_routes', __name__)


# ─── Existing endpoint — unchanged ───────────────────────────────────────────

@patient_routes.route('/api/patient/profile', methods=['GET'])
@token_required
@api_error_handler
def get_patient_profile(current_user):
    """GET /api/patient/profile — returns the current patient's profile.

    Unchanged from previous version. Used by the mobile home screen to
    display name / avatar. FHIR-native callers should use
    GET /fhir/Patient/{id} instead.
    """
    if current_user.get('user_type') not in ['patient']:
        return jsonify({'error': 'Patients only'}), 403

    user = mongo.db.users.find_one(
        {"_id": ObjectId(str(current_user['_id']))},
        {"password": 0}
    )
    if not user:
        return jsonify({'error': 'User not found'}), 404

    return jsonify({
        'first_name':           user.get('first_name', ''),
        'last_name':            user.get('last_name', ''),
        'email':                user.get('email', ''),
        'profile_picture_url':  user.get('profile_picture_url', ''),
        'ehr_profile':          user.get('ehr_profile', {
            'blood_type': '',
            'allergies': [],
            'chronic_conditions': [],
            'emergency_contact': '',
        }),
    }), 200


# ─── Existing endpoint — extended with GKV data ───────────────────────────────

@patient_routes.route('/api/patient/medical-profile', methods=['GET'])
@token_required
@api_error_handler
def get_patient_medical_profile(current_user):
    """GET /api/patient/medical-profile — full medical profile for the patient.

    Changes vs. previous version
    ─────────────────────────────
    • Now includes `fhir_identifiers` block (GKV number, address) from the
      patient_fhir_identifiers collection so the profile screen can show
      whether the patient has entered their GKV Versichertennummer.
    • All other fields and shape are unchanged — backward-compatible.
    """
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Patients only'}), 403

    patient_id = str(current_user['_id'])

    user = mongo.db.users.find_one(
        {"_id": ObjectId(patient_id)},
        {"first_name": 1, "last_name": 1, "email": 1}
    )

    doc    = mongo.db.patient_profiles.find_one({'patient_id': patient_id})
    id_doc = mongo.db.patient_fhir_identifiers.find_one({'patient_id': patient_id}) or {}

    profile = {
        # Identity
        'first_name': user.get('first_name', '') if user else '',
        'last_name':  user.get('last_name',  '') if user else '',
        'email':      user.get('email',       '') if user else '',

        # Medical profile fields
        'date_of_birth':           '',
        'gender':                  '',
        'blood_type':              'unknown',
        'height_cm':               None,
        'weight_kg':               None,
        'allergies':               [],
        'chronic_conditions':      [],
        'current_medications':     [],
        'smoking_status':          'unknown',
        'emergency_contact_name':  '',
        'emergency_contact_phone': '',
        'notes':                   '',
        'updated_at':              '',
        'updated_by':              '',

        # German FHIR identifiers block.
        # gkv_kvid is masked in the response (show first 4 chars only)
        # so it can be displayed as "A123••••••" without exposing the full number.
        'fhir_identifiers': _serialize_fhir_identifiers(id_doc),
    }

    if doc:
        profile.update({
            'date_of_birth':           doc.get('date_of_birth',           ''),
            'gender':                  doc.get('gender',                  ''),
            'blood_type':              doc.get('blood_type',              'unknown'),
            'height_cm':               doc.get('height_cm'),
            'weight_kg':               doc.get('weight_kg'),
            'allergies':               doc.get('allergies',               []),
            'chronic_conditions':      doc.get('chronic_conditions',      []),
            'current_medications':     doc.get('current_medications',     []),
            'smoking_status':          doc.get('smoking_status',          'unknown'),
            'emergency_contact_name':  doc.get('emergency_contact_name',  ''),
            'emergency_contact_phone': doc.get('emergency_contact_phone', ''),
            'notes':                   doc.get('notes',                   ''),
            'updated_at':              doc.get('updated_at',              ''),
            'updated_by':              doc.get('updated_by',              ''),
        })

    return jsonify(profile), 200


# ─── New endpoint — FHIR-native Patient resource ──────────────────────────────

@patient_routes.route('/api/patient/fhir-profile', methods=['GET'])
@token_required
@api_error_handler
def get_patient_fhir_profile(current_user):
    """GET /api/patient/fhir-profile — patient's own FHIR Patient resource.

    Returns a de.basisprofil.r4 + ISiKPatient-profiled FHIR R4 Patient
    resource for the currently authenticated patient.

    This is the mobile-app-friendly alias for GET /fhir/Patient/{id}.
    It requires no patient_id in the URL (the token supplies it), which
    avoids the patient needing to know their own FHIR ID.

    Response shape
    ──────────────
    {
      "resourceType": "Patient",
      "id": "...",
      "meta": { "profile": ["http://fhir.de/StructureDefinition/Patient", ...] },
      "identifier": [...],   ← internal ID + GKV if stored
      "name": [...],
      "telecom": [...],
      "gender": "...",       ← if stored in patient_profiles
      "birthDate": "...",    ← if stored in patient_profiles
      "address": [...]       ← if stored in fhir_identifiers
    }

    FHIR integration partners should use GET /fhir/Patient/{id} instead.
    """
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Patients only'}), 403

    patient_id = str(current_user['_id'])

    user = mongo.db.users.find_one(
        {"_id": ObjectId(patient_id)},
        {"password": 0}
    )
    if not user:
        return jsonify({'error': 'User not found'}), 404

    medical = mongo.db.patient_profiles.find_one({'patient_id': patient_id}) or {}
    id_doc  = mongo.db.patient_fhir_identifiers.find_one({'patient_id': patient_id}) or {}

    resource = build_fhir_patient(
        user,
        gkv_kvid    = id_doc.get('gkv_kvid'),
        birthdate   = medical.get('date_of_birth'),
        gender      = medical.get('gender'),
        phone       = id_doc.get('phone'),
        street      = id_doc.get('street'),
        postal_code = id_doc.get('postal_code'),
        city        = id_doc.get('city'),
    )

    return jsonify(resource), 200


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _serialize_fhir_identifiers(id_doc: dict) -> dict:
    """
    Return a JSON-safe summary of the stored German FHIR identifiers.
    The GKV number is masked — only the first 4 chars are shown so the UI
    can confirm it's been entered without displaying the full number.
    """
    gkv = id_doc.get('gkv_kvid', '')
    masked_gkv = (gkv[:4] + '••••••') if len(gkv) >= 4 else (gkv or '')

    return {
        'gkv_kvid_masked': masked_gkv,           # e.g. "A123••••••"
        'gkv_kvid_stored': bool(gkv),            # True/False for UI toggle
        'phone':           id_doc.get('phone',       ''),
        'street':          id_doc.get('street',      ''),
        'postal_code':     id_doc.get('postal_code', ''),
        'city':            id_doc.get('city',        ''),
    }