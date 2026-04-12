from flask import Blueprint, request, jsonify
from bson.objectid import ObjectId
from datetime import datetime, timezone
from utils.auth import token_required
from utils.error_handler import api_error_handler
from utils.fhir_de import build_fhir_patient, IdentifierSystem
from config import mongo
import logging
import re

logger = logging.getLogger(__name__)

patient_routes = Blueprint('patient_routes', __name__)

_BASE_URL = "https://morafek-caremate.onrender.com"


# ─── Internal helpers ─────────────────────────────────────────────────────────

def _get_user_and_identifiers(patient_id: str) -> tuple:
    """Fetch user doc + stored German identifiers. Returns (user, id_doc)."""
    try:
        user = mongo.db.users.find_one({"_id": ObjectId(patient_id)})
    except Exception:
        return None, {}
    if not user:
        return None, {}
    id_doc = mongo.db.patient_fhir_identifiers.find_one({"patient_id": patient_id}) or {}
    return user, id_doc


def _assemble_fhir_patient(user: dict, id_doc: dict) -> dict:
    """Combine user + identifiers + medical profile into a FHIR Patient."""
    medical = mongo.db.patient_profiles.find_one({"patient_id": str(user["_id"])}) or {}
    return build_fhir_patient(
        user,
        gkv_kvid    = id_doc.get("gkv_kvid"),
        birthdate   = medical.get("date_of_birth"),
        gender      = medical.get("gender"),
        phone       = id_doc.get("phone"),
        street      = id_doc.get("street"),
        postal_code = id_doc.get("postal_code"),
        city        = id_doc.get("city"),
    )


def _serialize_fhir_identifiers(id_doc: dict) -> dict:
    """
    Return a JSON-safe summary of stored German FHIR identifiers.
    GKV number is masked — only first 4 chars shown.
    """
    gkv = id_doc.get('gkv_kvid', '')
    masked_gkv = (gkv[:4] + '••••••') if len(gkv) >= 4 else (gkv or '')
    return {
        'gkv_kvid_masked': masked_gkv,
        'gkv_kvid_stored': bool(gkv),
        'phone':           id_doc.get('phone',       ''),
        'street':          id_doc.get('street',      ''),
        'postal_code':     id_doc.get('postal_code', ''),
        'city':            id_doc.get('city',        ''),
    }


def _empty_bundle() -> dict:
    return {"resourceType": "Bundle", "type": "searchset", "total": 0, "entry": []}


# ─── Patient profile (app-native) ─────────────────────────────────────────────

@patient_routes.route('/api/patient/profile', methods=['GET'])
@token_required
@api_error_handler
def get_patient_profile(current_user):
    """GET /api/patient/profile — basic profile for the home screen."""
    if current_user.get('user_type') != 'patient':
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


@patient_routes.route('/api/patient/medical-profile', methods=['GET'])
@token_required
@api_error_handler
def get_patient_medical_profile(current_user):
    """GET /api/patient/medical-profile — full medical profile including GKV summary."""
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
        'first_name': user.get('first_name', '') if user else '',
        'last_name':  user.get('last_name',  '') if user else '',
        'email':      user.get('email',       '') if user else '',
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


# ─── FHIR Patient — app alias (token-based, no ID in URL) ────────────────────

@patient_routes.route('/api/patient/fhir-profile', methods=['GET'])
@token_required
@api_error_handler
def get_patient_fhir_profile(current_user):
    """
    GET /api/patient/fhir-profile

    Mobile-friendly alias for GET /fhir/Patient/{id}.
    Returns the authenticated patient's own FHIR Patient resource without
    requiring the patient to know their ID.
    """
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Patients only'}), 403

    patient_id = str(current_user['_id'])
    user, id_doc = _get_user_and_identifiers(patient_id)
    if not user:
        return jsonify({'error': 'User not found'}), 404

    return jsonify(_assemble_fhir_patient(user, id_doc)), 200


# ─── FHIR Patient — store German identifiers ─────────────────────────────────

@patient_routes.route('/api/patient/fhir-identifiers', methods=['PUT'])
@token_required
@api_error_handler
def update_fhir_identifiers(current_user):
    """
    PUT /api/patient/fhir-identifiers

    Patient upserts their German health system identifiers. All fields optional.

    Body:
      gkv_kvid    : GKV Krankenversichertennummer (1 letter + 9 digits)
      phone       : contact phone
      street      : street + house number
      postal_code : German PLZ (5 digits)
      city        : city
    """
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Patients only'}), 403

    data = request.get_json() or {}
    patient_id = str(current_user['_id'])
    update: dict = {}

    gkv = data.get('gkv_kvid', '').strip().upper()
    if gkv:
        if not re.match(r'^[A-Z]\d{9}$', gkv):
            return jsonify({
                'error': 'Ungültige GKV-Versichertennummer. Format: 1 Buchstabe + 9 Ziffern (z.B. A123456789)'
            }), 400
        update['gkv_kvid'] = gkv

    for field in ('phone', 'street', 'postal_code', 'city'):
        if field in data:
            update[field] = str(data[field]).strip()

    if not update:
        return jsonify({'message': 'Keine Änderungen'}), 200

    update['patient_id'] = patient_id
    mongo.db.patient_fhir_identifiers.update_one(
        {'patient_id': patient_id},
        {'$set': update},
        upsert=True,
    )

    logger.info('FHIR identifiers updated for patient %s', patient_id)
    return jsonify({'message': 'Identifikatoren gespeichert', 'updated': list(update.keys())}), 200


# ─── FHIR Patient — read (GET /fhir/Patient/{id}) ────────────────────────────

@patient_routes.route('/fhir/Patient/<patient_id>', methods=['GET'])
@token_required
@api_error_handler
def fhir_patient_read(current_user, patient_id: str):
    """
    GET /fhir/Patient/{patient_id}

    Returns a de.basisprofil.r4 + ISiKPatient-profiled FHIR R4 Patient resource.

    Access:
      • Patient reads their own record only.
      • Doctor reads any patient in their authorized list.
      • Admin reads any patient.
    """
    requester_id   = str(current_user['_id'])
    requester_type = current_user.get('user_type')

    if requester_type == 'patient':
        if requester_id != patient_id:
            return jsonify({'error': 'Unauthorized'}), 403
    elif requester_type == 'doctor':
        patient = mongo.db.users.find_one({'_id': ObjectId(patient_id)})
        if not patient:
            return jsonify({
                'resourceType': 'OperationOutcome',
                'issue': [{'severity': 'error', 'code': 'not-found',
                           'diagnostics': f'Patient/{patient_id} not found'}]
            }), 404
        if requester_id not in patient.get('authorized_doctors', []):
            return jsonify({'error': 'Patient has not authorized this doctor'}), 403
    elif requester_type != 'admin':
        return jsonify({'error': 'Unauthorized'}), 403

    user, id_doc = _get_user_and_identifiers(patient_id)
    if not user:
        return jsonify({
            'resourceType': 'OperationOutcome',
            'issue': [{'severity': 'error', 'code': 'not-found',
                       'diagnostics': f'Patient/{patient_id} not found'}]
        }), 404

    return jsonify(_assemble_fhir_patient(user, id_doc)), 200


# ─── FHIR Patient — search (GET /fhir/Patient?...) ───────────────────────────

@patient_routes.route('/fhir/Patient', methods=['GET'])
@token_required
@api_error_handler
def fhir_patient_search(current_user):
    """
    GET /fhir/Patient?<search params>

    Returns a FHIR searchset Bundle. Doctors and admins only.

    Supported search parameters (ISiK Stage 1 Basisdaten required set):
      _id        : token  — exact match on patient ObjectId
      name       : string — case-insensitive substring on first or last name
      birthdate  : date   — exact ISO date match "YYYY-MM-DD"
      gender     : token  — exact match (male | female | other | unknown)
      identifier : token  — system|value or plain value for GKV / internal ID
    """
    requester_type = current_user.get('user_type')
    if requester_type not in ('doctor', 'admin'):
        return jsonify({'error': 'Doctors and admins only'}), 403

    doctor_id = str(current_user['_id'])

    # Scope: admins see all patients; doctors see only authorized patients
    if requester_type == 'admin':
        base_query: dict = {'user_type': 'patient'}
    else:
        patient = mongo.db.users.find_one({'_id': ObjectId(doctor_id)})
        authorized_ids = patient.get('authorized_doctors', []) if patient else []
        # Use the authorized_doctors field on the patient side
        base_query = {
            'user_type': 'patient',
            'authorized_doctors': doctor_id,
        }

    # ── _id ───────────────────────────────────────────────────────────────────
    _id_param = request.args.get('_id')
    if _id_param:
        try:
            base_query['_id'] = ObjectId(_id_param)
        except Exception:
            return jsonify(_empty_bundle()), 200

    # ── name ──────────────────────────────────────────────────────────────────
    name_param = request.args.get('name')
    if name_param:
        pattern = re.compile(re.escape(name_param), re.IGNORECASE)
        base_query['$or'] = [
            {'first_name': {'$regex': pattern}},
            {'last_name':  {'$regex': pattern}},
        ]

    users = list(mongo.db.users.find(base_query, {'password': 0}))

    if not users:
        return jsonify(_empty_bundle()), 200

    # Batch-fetch identifier docs to avoid N+1
    patient_ids   = [str(u['_id']) for u in users]
    id_docs_raw   = list(mongo.db.patient_fhir_identifiers.find(
        {'patient_id': {'$in': patient_ids}}
    ))
    id_docs_by_id = {d['patient_id']: d for d in id_docs_raw}

    # Batch-fetch medical profiles (needed for birthdate/gender filters)
    medical_raw   = list(mongo.db.patient_profiles.find(
        {'patient_id': {'$in': patient_ids}}
    ))
    medical_by_id = {d['patient_id']: d for d in medical_raw}

    # ── birthdate (post-filter — stored in patient_profiles) ─────────────────
    birthdate_param = request.args.get('birthdate')
    if birthdate_param:
        users = [u for u in users
                 if medical_by_id.get(str(u['_id']), {}).get('date_of_birth') == birthdate_param]

    # ── gender (post-filter) ──────────────────────────────────────────────────
    gender_param = request.args.get('gender')
    if gender_param:
        users = [u for u in users
                 if medical_by_id.get(str(u['_id']), {}).get('gender') == gender_param]

    # ── identifier (post-filter) ──────────────────────────────────────────────
    identifier_param = request.args.get('identifier')
    if identifier_param:
        if '|' in identifier_param:
            id_system, id_value = identifier_param.split('|', 1)
        else:
            id_system, id_value = None, identifier_param

        filtered = []
        for user in users:
            pid    = str(user['_id'])
            id_doc = id_docs_by_id.get(pid, {})
            if id_value == pid:
                filtered.append(user)
                continue
            if (not id_system or id_system == IdentifierSystem.GKV_KVID) and \
               id_doc.get('gkv_kvid') == id_value:
                filtered.append(user)
        users = filtered

    # Assemble Bundle entries
    entries = []
    for user in users:
        pid      = str(user['_id'])
        id_doc   = id_docs_by_id.get(pid, {})
        resource = _assemble_fhir_patient(user, id_doc)
        entries.append({
            'fullUrl':  f'{_BASE_URL}/fhir/Patient/{pid}',
            'resource': resource,
            'search':   {'mode': 'match'},
        })

    return jsonify({
        'resourceType': 'Bundle',
        'type':         'searchset',
        'total':        len(entries),
        'entry':        entries,
    }), 200