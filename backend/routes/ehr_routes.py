from flask import Blueprint, request, jsonify
from bson.objectid import ObjectId
from datetime import datetime, timezone, timedelta
from uuid import uuid4
from utils.auth import token_required
from utils.error_handler import api_error_handler
from routes.doctor_routes import check_doctor_patient_access
from utils.fhir_de import (
    build_observations_from_vitals_doc,
    build_document_bundle,
    build_isik_observation_vitals_fields,
    build_isik_encounter_fields,
    build_isik_condition_fields,
    build_fhir_medication_request,
    build_medication_resource,
    build_medication_statement,
    validate_kbv_medication_resource,
    validate_kbv_medication_request_resource,
    validate_medication_bundle_entries,
)
from config import mongo
import cloudinary.uploader
import logging

logger = logging.getLogger(__name__)
MEDICATION_INTAKE_LOOKBACK_DAYS = 90

ehr_routes = Blueprint('ehr_routes', __name__)


# ─── Vitals (ehr_vitals) ─────────────────────────────────────────────────────

@ehr_routes.route('/api/doctor/patient/<patient_id>/vitals', methods=['POST'])
@token_required
@api_error_handler
def create_vitals(current_user, patient_id):
    """POST /api/ehr/vitals/<patient_id> — record a vital-signs observation.

    Required JSON fields:
      systolic  (int/float) — systolic blood pressure in mmHg
      diastolic (int/float) — diastolic blood pressure in mmHg
      pulse     (int/float) — heart rate in beats per minute
    Optional JSON fields:
      notes  (str)  — free-text clinical notes
      urgent (bool) — flag this reading as urgent (default: false)
      source (str)  — origin of the reading, e.g. "manual" (default: "manual")
    """
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    data = request.get_json()
    if not data:
        return jsonify({'error': 'Missing request body'}), 400

    required = ['systolic', 'diastolic', 'pulse']
    for field in required:
        if field not in data:
            return jsonify({'error': f'Missing required field: {field}'}), 400

    systolic = data['systolic']
    diastolic = data['diastolic']
    pulse = data['pulse']
    notes = data.get('notes', '')
    urgent = systolic > 180 or diastolic > 120
    source = data.get('source', 'manual')

    recorded_by = str(current_user['_id'])
    effective_dt = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    # Determine performer reference — doctor recording on behalf of patient,
    # or patient self-reporting.
    recorder_type  = current_user.get('user_type', 'patient')
    performer_type = 'Practitioner' if recorder_type == 'doctor' else 'Patient'
    performer_ref  = f'{performer_type}/{recorded_by}'

    document = {
        'resourceType': 'Observation',
        'id': str(uuid4()),
        'patient_id': patient_id,
        'recorded_by': recorded_by,
        'status': 'final',
        'category': [{
            'coding': [{
                'system': 'http://terminology.hl7.org/CodeSystem/observation-category',
                'code': 'vital-signs',
                'display': 'Vital Signs'
            }]
        }],
        'code': {
            'coding': [{
                'system': 'http://loinc.org',
                'code': '55284-4',
                'display': 'Blood pressure systolic and diastolic'
            }]
        },
        'subject': {'reference': f'Patient/{patient_id}'},
        'effectiveDateTime': effective_dt,
        # performer — required by ISiK and MII profiles
        'performer': [{'reference': performer_ref}],
        'component': [
            {
                'code': {'coding': [{'system': 'http://loinc.org',
                                     'code': '8480-6', 'display': 'Systolic BP'}]},
                'valueQuantity': {'value': systolic, 'unit': 'mmHg',
                                  'system': 'http://unitsofmeasure.org', 'code': 'mm[Hg]'}
            },
            {
                'code': {'coding': [{'system': 'http://loinc.org',
                                     'code': '8462-4', 'display': 'Diastolic BP'}]},
                'valueQuantity': {'value': diastolic, 'unit': 'mmHg',
                                  'system': 'http://unitsofmeasure.org', 'code': 'mm[Hg]'}
            },
            {
                'code': {'coding': [{'system': 'http://loinc.org',
                                     'code': '8867-4', 'display': 'Heart rate'}]},
                'valueQuantity': {'value': pulse, 'unit': '/min',
                                  'system': 'http://unitsofmeasure.org', 'code': '/min'}
            }
        ],
        'note': [{'text': notes}] if notes else [],
        'extension': [
            {
                'url': 'https://morafek.app/fhir/StructureDefinition/urgent-flag',
                'valueBoolean': urgent
            },
            {
                'url': 'https://morafek.app/fhir/StructureDefinition/source',
                'valueString': source
            }
        ]
    }

    # Stamp de.basisprofil.r4 + ISiK profile URLs onto meta.profile
    build_isik_observation_vitals_fields(document)

    result = mongo.db.ehr_vitals.insert_one(document)
    logger.info("Vitals observation stored in ehr_vitals")

    return jsonify({
        'id': str(result.inserted_id),
        'systolic': systolic,
        'diastolic': diastolic,
        'pulse': pulse,
        'urgent': urgent,
        'timestamp': effective_dt
    }), 201


@ehr_routes.route('/api/doctor/patient/<patient_id>/vitals', methods=['GET'])
@token_required
@api_error_handler
def get_vitals(current_user, patient_id):
    """GET /api/ehr/vitals/<patient_id> — list vital-sign observations (flat)."""
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    docs = list(
        mongo.db.ehr_vitals
        .find({'patient_id': patient_id})
        .sort('effectiveDateTime', -1)
    )

    result = []
    for doc in docs:
        systolic = diastolic = pulse = None
        for comp in doc.get('component', []):
            codings = comp.get('code', {}).get('coding', [])
            code_val = codings[0].get('code') if codings else None
            qty = comp.get('valueQuantity', {}).get('value')
            if code_val == '8480-6':
                systolic = qty
            elif code_val == '8462-4':
                diastolic = qty
            elif code_val == '8867-4':
                pulse = qty

        urgent = False
        for ext in doc.get('extension', []):
            if ext.get('url') == 'https://morafek.app/fhir/StructureDefinition/urgent-flag':
                urgent = ext.get('valueBoolean', False)

        result.append({
            'id': str(doc['_id']),
            'systolic': systolic,
            'diastolic': diastolic,
            'pulse': pulse,
            'urgent': urgent,
            'timestamp': doc.get('effectiveDateTime')
        })

    return jsonify(result), 200


# ─── Visits (ehr_visits + ehr_conditions) ────────────────────────────────────

@ehr_routes.route('/api/patient/vitals', methods=['GET'])
@token_required
@api_error_handler
def get_own_vitals(current_user):
    """GET /api/patient/vitals — patient views their own vital-sign observations."""
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Unauthorized access'}), 403

    patient_id = str(current_user['_id'])

    docs = list(
        mongo.db.ehr_vitals
        .find({'patient_id': patient_id})
        .sort('effectiveDateTime', -1)
    )

    result = []
    for doc in docs:
        systolic = diastolic = pulse = None
        for comp in doc.get('component', []):
            codings = comp.get('code', {}).get('coding', [])
            code_val = codings[0].get('code') if codings else None
            qty = comp.get('valueQuantity', {}).get('value')
            if code_val == '8480-6':
                systolic = qty
            elif code_val == '8462-4':
                diastolic = qty
            elif code_val == '8867-4':
                pulse = qty

        urgent = False
        for ext in doc.get('extension', []):
            if ext.get('url') == 'https://morafek.app/fhir/StructureDefinition/urgent-flag':
                urgent = ext.get('valueBoolean', False)

        result.append({
            'id': str(doc['_id']),
            'systolic': systolic,
            'diastolic': diastolic,
            'pulse': pulse,
            'urgent': urgent,
            'timestamp': doc.get('effectiveDateTime')
        })

    return jsonify(result), 200


@ehr_routes.route('/api/patient/vitals', methods=['POST'])
@token_required
@api_error_handler
def create_own_vitals(current_user):
    """POST /api/patient/vitals — patient records their own vital-sign observation."""
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Unauthorized access'}), 403

    data = request.get_json()
    if not data:
        return jsonify({'error': 'Missing request body'}), 400

    required = ['systolic', 'diastolic', 'pulse']
    for field in required:
        if field not in data:
            return jsonify({'error': f'Missing required field: {field}'}), 400

    systolic = data['systolic']
    diastolic = data['diastolic']
    pulse = data['pulse']
    weight_kg = data.get('weight_kg')
    notes = data.get('notes', '')

    patient_id = str(current_user['_id'])
    recorded_by = str(current_user['_id'])
    source = 'patient_home'
    urgent = systolic > 180 or diastolic > 120

    effective_dt = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    components = [
        {
            'code': {'coding': [{'system': 'http://loinc.org',
                                 'code': '8480-6', 'display': 'Systolic BP'}]},
            'valueQuantity': {'value': systolic, 'unit': 'mmHg',
                              'system': 'http://unitsofmeasure.org', 'code': 'mm[Hg]'}
        },
        {
            'code': {'coding': [{'system': 'http://loinc.org',
                                 'code': '8462-4', 'display': 'Diastolic BP'}]},
            'valueQuantity': {'value': diastolic, 'unit': 'mmHg',
                              'system': 'http://unitsofmeasure.org', 'code': 'mm[Hg]'}
        },
        {
            'code': {'coding': [{'system': 'http://loinc.org',
                                 'code': '8867-4', 'display': 'Heart rate'}]},
            'valueQuantity': {'value': pulse, 'unit': '/min',
                              'system': 'http://unitsofmeasure.org', 'code': '/min'}
        }
    ]

    if weight_kg is not None:
        components.append({
            'code': {'coding': [{'system': 'http://loinc.org',
                                 'code': '29463-7', 'display': 'Body weight'}]},
            'valueQuantity': {'value': weight_kg, 'unit': 'kg',
                              'system': 'http://unitsofmeasure.org', 'code': 'kg'}
        })

    document = {
        'resourceType': 'Observation',
        'id': str(uuid4()),
        'patient_id': patient_id,
        'recorded_by': recorded_by,
        'status': 'final',
        'category': [{
            'coding': [{
                'system': 'http://terminology.hl7.org/CodeSystem/observation-category',
                'code': 'vital-signs',
                'display': 'Vital Signs'
            }]
        }],
        'code': {
            'coding': [{
                'system': 'http://loinc.org',
                'code': '55284-4',
                'display': 'Blood pressure systolic and diastolic'
            }]
        },
        'subject': {'reference': f'Patient/{patient_id}'},
        'effectiveDateTime': effective_dt,
        'component': components,
        'note': [{'text': notes}] if notes else [],
        'extension': [
            {
                'url': 'https://morafek.app/fhir/StructureDefinition/urgent-flag',
                'valueBoolean': urgent
            },
            {
                'url': 'https://morafek.app/fhir/StructureDefinition/source',
                'valueString': source
            }
        ]
    }

    result = mongo.db.ehr_vitals.insert_one(document)
    logger.info("Patient home vitals observation stored in ehr_vitals")

    return jsonify({
        'id': str(result.inserted_id),
        'systolic': systolic,
        'diastolic': diastolic,
        'pulse': pulse,
        'urgent': urgent,
        'timestamp': effective_dt
    }), 201


@ehr_routes.route('/api/patient/visits', methods=['GET'])
@token_required
@api_error_handler
def get_own_visits(current_user):
    """GET /api/patient/visits — patient views their own visit history."""
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Unauthorized access'}), 403

    patient_id = str(current_user['_id'])

    encounters = list(
        mongo.db.ehr_visits
        .find({'patient_id': patient_id})
        .sort('period.start', -1)
    )

    encounter_uuids = [enc.get('id') for enc in encounters if enc.get('id')]
    conditions_list = list(
        mongo.db.ehr_conditions.find({'encounter_id': {'$in': encounter_uuids}})
    )
    conditions_by_encounter = {c['encounter_id']: c for c in conditions_list}

    result = []
    for enc in encounters:
        encounter_uuid = enc.get('id')
        condition = conditions_by_encounter.get(encounter_uuid)

        diagnosis_icd10 = diagnosis_text = None
        if condition:
            codings = condition.get('code', {}).get('coding', [])
            if codings:
                diagnosis_icd10 = codings[0].get('code')
                diagnosis_text = codings[0].get('display')

        notes_list = enc.get('note', [])
        notes = notes_list[0].get('text', '') if notes_list else ''

        reason_codes = enc.get('reasonCode') or []
        chief_complaint = reason_codes[0].get('text') if reason_codes else None

        result.append({
            'id': str(enc['_id']),
            'encounter_fhir_id': encounter_uuid,
            'doctor_id': enc.get('doctor_id'),
            'chief_complaint': chief_complaint,
            'diagnosis_icd10': diagnosis_icd10,
            'diagnosis_text': diagnosis_text,
            'visit_date': enc.get('period', {}).get('start'),
            'notes': notes
        })

    return jsonify(result), 200


@ehr_routes.route('/api/doctor/patient/<patient_id>/visits', methods=['POST'])
@token_required
@api_error_handler
def create_visit(current_user, patient_id):
    """POST /api/ehr/visits/<patient_id> — record a clinical visit.

    Required JSON fields:
      chief_complaint  (str) — patient's main reason for the visit
      diagnosis_text   (str) — human-readable diagnosis label
    Optional JSON fields:
      diagnosis_icd10 (str) — ICD-10-GM code, e.g. "E11.9" (defaults to "")
      notes      (str) — additional clinical notes
      visit_date (str) — ISO 8601 datetime string, e.g. "2025-06-01T09:00:00Z"
                         (defaults to the current UTC time if omitted)
    """
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    data = request.get_json()
    if not data:
        return jsonify({'error': 'Missing request body'}), 400

    # FIX: diagnosis_icd10 is now optional — only chief_complaint and
    # diagnosis_text are required. The ICD code field is blank in many
    # real-world workflows; enforcing it caused silent 400 failures from
    # the form which left the field empty.
    required = ['chief_complaint', 'diagnosis_text']
    for field in required:
        if field not in data or not str(data[field]).strip():
            return jsonify({'error': f'Missing required field: {field}'}), 400

    chief_complaint = data['chief_complaint']
    diagnosis_icd10 = data.get('diagnosis_icd10', '') or ''   # optional, default ''
    diagnosis_text = data['diagnosis_text']

    if diagnosis_icd10 and len(diagnosis_icd10.strip()) < 3:
        return jsonify({'error': 'ICD-10 code must be at least 3 characters (e.g. I10)'}), 400
    notes = data.get('notes', '')
    doctor_id = str(current_user['_id'])

    # Parse or default visit date
    raw_date = data.get('visit_date')
    if raw_date:
        try:
            visit_dt = datetime.fromisoformat(raw_date.replace('Z', '+00:00'))
            visit_date_iso = visit_dt.strftime('%Y-%m-%dT%H:%M:%SZ')
        except ValueError:
            return jsonify({'error': 'Invalid visit_date format. Use ISO 8601.'}), 400
    else:
        visit_date_iso = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    encounter_uuid = str(uuid4())
    condition_uuid = str(uuid4())

    # Document 1 — Encounter (stored in ehr_visits)
    encounter_doc = {
        'resourceType': 'Encounter',
        'id': encounter_uuid,
        'patient_id': patient_id,
        'doctor_id': doctor_id,
        'status': 'finished',
        'class': {
            'system': 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
            'code': 'AMB',
            'display': 'ambulatory'
        },
        'subject': {'reference': f'Patient/{patient_id}'},
        'participant': [{
            'individual': {'reference': f'Practitioner/{doctor_id}'}
        }],
        'period': {
            'start': visit_date_iso,
            'end': visit_date_iso
        },
        'reasonCode': [{'text': chief_complaint}],
        'diagnosis': [{
            'condition': {'reference': f'Condition/{condition_uuid}'},
            'use': {
                'coding': [{
                    'system': 'http://terminology.hl7.org/CodeSystem/diagnosis-role',
                    'code': 'CC'
                }]
            }
        }],
        'note': [{'text': notes}] if notes else []
    }

    # Document 2 — Condition (stored in ehr_conditions)
    condition_doc = {
        'resourceType': 'Condition',
        'id': condition_uuid,
        'patient_id': patient_id,
        'encounter_id': encounter_uuid,
        'clinicalStatus': {
            'coding': [{'system': 'http://terminology.hl7.org/CodeSystem/condition-clinical',
                        'code': 'active'}]
        },
        'verificationStatus': {
            'coding': [{
                'system': 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
                'code': 'confirmed',
                'display': 'Confirmed'
            }]
        },
        'code': {
            'coding': [] if not diagnosis_icd10 else [{
                'system': 'http://fhir.de/CodeSystem/bfarm/icd-10-gm',
                'code': diagnosis_icd10,
                'display': diagnosis_text
            }]
        },
        'subject': {'reference': f'Patient/{patient_id}'},
        'encounter': {'reference': f'Encounter/{encounter_uuid}'}
    }

    encounter_result = mongo.db.ehr_visits.insert_one(encounter_doc)
    condition_result = mongo.db.ehr_conditions.insert_one(condition_doc)

    logger.info("Visit encounter and condition stored in ehr_visits / ehr_conditions")

    encounter_mongo_id = str(encounter_result.inserted_id)
    return jsonify({
        # 'id' and '_id' are aliases for the MongoDB ObjectId of the encounter.
        # visit-form.tsx reads `visitRes.data?.id ?? visitRes.data?._id` to
        # obtain the visitId it passes to MedicationPrescriptionPanel.
        # Without this field the visitId was always undefined and the
        # "Alle speichern" button stayed permanently disabled.
        'id': encounter_mongo_id,
        '_id': encounter_mongo_id,
        'encounter_id': encounter_mongo_id,
        'condition_id': str(condition_result.inserted_id),
        'patient_id': patient_id,
        'doctor_id': doctor_id,
        'chief_complaint': chief_complaint,
        'diagnosis_icd10': diagnosis_icd10,
        'diagnosis_text': diagnosis_text,
        'visit_date': visit_date_iso
    }), 201


@ehr_routes.route('/api/doctor/patient/<patient_id>/visits', methods=['GET'])
@token_required
@api_error_handler
def get_visits(current_user, patient_id):
    """GET /api/ehr/visits/<patient_id> — list visits with linked diagnosis."""
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    encounters = list(
        mongo.db.ehr_visits
        .find({'patient_id': patient_id})
        .sort('period.start', -1)
    )

    # Pre-fetch all conditions for this patient in one query to avoid N+1
    encounter_uuids = [enc.get('id') for enc in encounters if enc.get('id')]
    conditions_list = list(
        mongo.db.ehr_conditions.find({'encounter_id': {'$in': encounter_uuids}})
    )
    conditions_by_encounter = {c['encounter_id']: c for c in conditions_list}

    result = []
    for enc in encounters:
        encounter_uuid = enc.get('id')
        condition = conditions_by_encounter.get(encounter_uuid)

        diagnosis_icd10 = diagnosis_text = None
        if condition:
            codings = condition.get('code', {}).get('coding', [])
            if codings:
                diagnosis_icd10 = codings[0].get('code')
                diagnosis_text = codings[0].get('display')

        notes_list = enc.get('note', [])
        notes = notes_list[0].get('text', '') if notes_list else ''

        reason_codes = enc.get('reasonCode') or []
        chief_complaint = reason_codes[0].get('text') if reason_codes else None

        result.append({
            'id': str(enc['_id']),
            'encounter_fhir_id': encounter_uuid,
            'doctor_id': enc.get('doctor_id'),
            'chief_complaint': chief_complaint,
            'diagnosis_icd10': diagnosis_icd10,
            'diagnosis_text': diagnosis_text,
            'visit_date': enc.get('period', {}).get('start'),
            'notes': notes
        })

    return jsonify(result), 200


# ─── Medical Profile (patient_profiles) ──────────────────────────────────────

VALID_BLOOD_TYPES  = {'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown'}
VALID_GENDERS      = {'male', 'female', 'other', 'prefer_not_to_say'}
VALID_SMOKING      = {'never', 'former', 'current', 'unknown'}


def _serialize_profile(doc) -> dict:
    """Return a JSON-serialisable medical profile dict."""
    return {
        'patient_id':          doc.get('patient_id', ''),
        'date_of_birth':       doc.get('date_of_birth', ''),
        'gender':              doc.get('gender', ''),
        'blood_type':          doc.get('blood_type', 'unknown'),
        'height_cm':           doc.get('height_cm'),
        'weight_kg':           doc.get('weight_kg'),
        'allergies':           doc.get('allergies', []),
        'chronic_conditions':  doc.get('chronic_conditions', []),
        'current_medications': doc.get('current_medications', []),
        'smoking_status':      doc.get('smoking_status', 'unknown'),
        'emergency_contact_name':  doc.get('emergency_contact_name', ''),
        'emergency_contact_phone': doc.get('emergency_contact_phone', ''),
        'notes':               doc.get('notes', ''),
        'updated_at':          doc.get('updated_at', ''),
        'updated_by':          doc.get('updated_by', ''),
    }


@ehr_routes.route('/api/doctor/patient/<patient_id>/profile', methods=['GET'])
@token_required
@api_error_handler
def get_patient_profile(current_user, patient_id):
    """GET /api/doctor/patient/<patient_id>/profile — fetch the patient's medical profile."""
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    doc = mongo.db.patient_profiles.find_one({'patient_id': patient_id})
    if not doc:
        # Return an empty profile shell so the frontend always gets a valid object
        return jsonify(_serialize_profile({'patient_id': patient_id})), 200

    return jsonify(_serialize_profile(doc)), 200


@ehr_routes.route('/api/doctor/patient/<patient_id>/profile', methods=['PUT'])
@token_required
@api_error_handler
def update_patient_profile(current_user, patient_id):
    """PUT /api/doctor/patient/<patient_id>/profile — create or update the patient's medical profile.

    All fields are optional; only supplied fields are written.

    Accepted JSON fields:
      date_of_birth           (str)         — ISO date e.g. "1955-03-22"
      gender                  (str)         — male | female | other | prefer_not_to_say
      blood_type              (str)         — A+ | A- | … | O- | unknown
      height_cm               (int/float)
      weight_kg               (int/float)
      allergies               (list[str])
      chronic_conditions      (list[str])
      current_medications     (list[str])
      smoking_status          (str)         — never | former | current | unknown
      emergency_contact_name  (str)
      emergency_contact_phone (str)
      notes                   (str)
    """
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    data = request.get_json()
    if not data:
        return jsonify({'error': 'Missing request body'}), 400

    updates = {}

    if 'date_of_birth' in data:
        updates['date_of_birth'] = str(data['date_of_birth']).strip()

    if 'gender' in data:
        g = str(data['gender']).strip().lower()
        # FIX: empty string means "not set" — ignore it rather than
        # failing the allow-list check with '' not in VALID_GENDERS.
        if g == '':
            pass
        elif g not in VALID_GENDERS:
            return jsonify({'error': f'gender must be one of: {", ".join(sorted(VALID_GENDERS))}'}), 400
        else:
            updates['gender'] = g

    if 'blood_type' in data:
        bt = str(data['blood_type']).strip()
        if bt not in VALID_BLOOD_TYPES:
            return jsonify({'error': f'blood_type must be one of: {", ".join(sorted(VALID_BLOOD_TYPES))}'}), 400
        updates['blood_type'] = bt

    for num_field in ('height_cm', 'weight_kg'):
        if num_field in data:
            # FIX: null explicitly clears the field — float(None) would
            # raise TypeError and return 400, so handle it separately.
            if data[num_field] is None:
                updates[num_field] = None
                continue
            try:
                val = float(data[num_field])
                if val <= 0:
                    raise ValueError
                updates[num_field] = val
            except (TypeError, ValueError):
                return jsonify({'error': f'{num_field} must be a positive number'}), 400

    for list_field in ('allergies', 'chronic_conditions', 'current_medications'):
        if list_field in data:
            raw = data[list_field]
            if not isinstance(raw, list):
                return jsonify({'error': f'{list_field} must be a list of strings'}), 400
            updates[list_field] = [str(item).strip() for item in raw if str(item).strip()]

    if 'smoking_status' in data:
        ss = str(data['smoking_status']).strip().lower()
        if ss not in VALID_SMOKING:
            return jsonify({'error': f'smoking_status must be one of: {", ".join(sorted(VALID_SMOKING))}'}), 400
        updates['smoking_status'] = ss

    for str_field in ('emergency_contact_name', 'emergency_contact_phone', 'notes'):
        if str_field in data:
            updates[str_field] = str(data[str_field]).strip()

    if not updates:
        return jsonify({'error': 'No valid fields provided for update'}), 400

    updates['updated_at'] = datetime.now(timezone.utc).isoformat() + 'Z'
    updates['updated_by'] = str(current_user['_id'])
    updates['patient_id'] = patient_id

    mongo.db.patient_profiles.update_one(
        {'patient_id': patient_id},
        {'$set': updates},
        upsert=True,
    )
    logger.info('Medical profile updated for patient %s by doctor %s', patient_id, current_user['_id'])

    doc = mongo.db.patient_profiles.find_one({'patient_id': patient_id})
    return jsonify(_serialize_profile(doc)), 200


# ─── Messages (ehr_messages) ──────────────────────────────────────────────────
#
# IMPORTANT — route registration order:
#   Static routes (/api/messages/conversations, /api/messages/unread-count)
#   MUST be registered BEFORE the variable route (/api/messages/<other_user_id>).
#   Werkzeug gives static segments higher priority, but defining them first
#   makes the intent explicit and avoids any edge-case ambiguity.

@ehr_routes.route('/api/messages/conversations', methods=['GET'])
@token_required
@api_error_handler
def get_conversations(current_user):
    """GET /api/messages/conversations — list all conversation partners for the current user.

    Returns one entry per unique conversation partner, ordered by most recent
    message first.  Each entry includes the partner's display name, their user
    type, the last message preview, its timestamp, and the number of unread
    messages from that partner.
    """
    current_id = str(current_user['_id'])

    # Fetch all messages involving this user, newest first so we naturally
    # see the most-recent message per thread when we deduplicate.
    all_messages = list(
        mongo.db.ehr_messages
        .find({
            '$or': [
                {'sender_id': current_id},
                {'recipient_id': current_id},
            ]
        })
        .sort('created_at', -1)
    )

    # Deduplicate: keep only the most-recent message per conversation partner.
    seen_partner_ids: dict = {}   # other_user_id → last message doc
    for msg in all_messages:
        other_id = msg['recipient_id'] if msg['sender_id'] == current_id else msg['sender_id']
        if other_id not in seen_partner_ids:
            seen_partner_ids[other_id] = msg

    if not seen_partner_ids:
        return jsonify([]), 200

    # Bulk-fetch partner user records to avoid N+1 DB calls
    try:
        partner_oids = [ObjectId(oid) for oid in seen_partner_ids]
    except Exception:
        partner_oids = []

    partner_docs = {
        str(u['_id']): u
        for u in mongo.db.users.find(
            {'_id': {'$in': partner_oids}},
            {'first_name': 1, 'last_name': 1, 'user_type': 1}
        )
    }

    # Bulk-count unread messages per partner
    unread_pipeline = [
        {
            '$match': {
                'recipient_id': current_id,
                'sender_id': {'$in': list(seen_partner_ids.keys())},
                'read': False,
            }
        },
        {'$group': {'_id': '$sender_id', 'count': {'$sum': 1}}}
    ]
    unread_by_partner = {
        row['_id']: row['count']
        for row in mongo.db.ehr_messages.aggregate(unread_pipeline)
    }

    result = []
    for other_id, last_msg in seen_partner_ids.items():
        partner = partner_docs.get(other_id, {})
        first = partner.get('first_name', '')
        last  = partner.get('last_name', '')
        name  = f'{first} {last}'.strip() or 'Unknown'

        result.append({
            'other_user_id':   other_id,
            'other_user_name': name,
            'other_user_type': partner.get('user_type', ''),
            'last_message':    last_msg.get('body', ''),
            'last_message_at': last_msg.get('created_at', ''),
            'unread_count':    unread_by_partner.get(other_id, 0),
        })

    return jsonify(result), 200


@ehr_routes.route('/api/messages/unread-count', methods=['GET'])
@token_required
@api_error_handler
def get_unread_count(current_user):
    """GET /api/messages/unread-count — count unread messages for the current user."""
    current_id = str(current_user['_id'])
    count = mongo.db.ehr_messages.count_documents({
        'recipient_id': current_id,
        'read': False,
    })
    return jsonify({'count': count}), 200


@ehr_routes.route('/api/messages/<other_user_id>', methods=['GET'])
@token_required
@api_error_handler
def get_messages(current_user, other_user_id):
    """GET /api/messages/<other_user_id> — get message thread between current user and other_user_id."""
    current_id = str(current_user['_id'])

    messages = list(
        mongo.db.ehr_messages
        .find({
            '$or': [
                {'sender_id': current_id, 'recipient_id': other_user_id},
                {'sender_id': other_user_id, 'recipient_id': current_id},
            ]
        })
        .sort('created_at', 1)
    )

    result = []
    for msg in messages:
        result.append({
            'id': str(msg['_id']),
            'sender_id': msg.get('sender_id', ''),
            'recipient_id': msg.get('recipient_id', ''),
            'sender_type': msg.get('sender_type', 'patient'),
            'body': msg.get('body', ''),
            'read': msg.get('read', False),
            'created_at': msg.get('created_at', ''),
        })

    return jsonify(result), 200


@ehr_routes.route('/api/messages/<other_user_id>', methods=['POST'])
@token_required
@api_error_handler
def send_message(current_user, other_user_id):
    """POST /api/messages/<other_user_id> — send a message to another user."""
    data = request.get_json()
    if not data or not data.get('body', '').strip():
        return jsonify({'error': 'Message body is required'}), 400

    current_id = str(current_user['_id'])
    sender_type = current_user.get('user_type', 'patient')
    created_at = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    body = data['body'].strip()

    recipient_doc = mongo.db.users.find_one(
        {'_id': ObjectId(other_user_id)},
        {'user_type': 1}
    )
    recipient_type = recipient_doc.get('user_type', 'patient') if recipient_doc else 'patient'

    sender_ref = f"{'Practitioner' if sender_type == 'doctor' else 'Patient'}/{current_id}"
    recipient_ref = f"{'Practitioner' if recipient_type == 'doctor' else 'Patient'}/{other_user_id}"

    document = {
        'sender_id': current_id,
        'recipient_id': other_user_id,
        'sender_type': sender_type,
        'recipient_type': recipient_type,
        'body': body,
        'read': False,
        'created_at': created_at,
        'resourceType': 'Communication',
        'status': 'completed',
        'sender': {'reference': sender_ref},
        'recipient': [{'reference': recipient_ref}],
        'payload': [{'contentString': body}],
        'sent': created_at,
    }

    result = mongo.db.ehr_messages.insert_one(document)
    logger.info(f'Message sent from {current_id} to {other_user_id}')

    return jsonify({
        'id': str(result.inserted_id),
        'sender_id': current_id,
        'recipient_id': other_user_id,
        'sender_type': sender_type,
        'body': document['body'],
        'read': False,
        'created_at': created_at,
    }), 201


@ehr_routes.route('/api/doctor/patient/<patient_id>/messages', methods=['GET'])
@token_required
@api_error_handler
def get_patient_messages(current_user, patient_id):
    """GET /api/doctor/patient/<patient_id>/messages — doctor views message thread with a patient."""
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    doctor_id = str(current_user['_id'])

    messages = list(
        mongo.db.ehr_messages
        .find({
            '$or': [
                {'sender_id': doctor_id, 'recipient_id': patient_id},
                {'sender_id': patient_id, 'recipient_id': doctor_id},
            ]
        })
        .sort('created_at', 1)
    )

    result = []
    for msg in messages:
        result.append({
            'id': str(msg['_id']),
            'sender_id': msg.get('sender_id', ''),
            'recipient_id': msg.get('recipient_id', ''),
            'sender_type': msg.get('sender_type', 'patient'),
            'body': msg.get('body', ''),
            'read': msg.get('read', False),
            'created_at': msg.get('created_at', ''),
        })

    return jsonify(result), 200


# ─── Documents (ehr_documents) ────────────────────────────────────────────────

# Permitted MIME types for document uploads
DOCUMENT_ALLOWED_MIME_TYPES = {
    'image/jpeg', 'image/png', 'image/webp',
    'application/pdf',
}
DOCUMENT_MAX_FILE_BYTES = 10 * 1024 * 1024  # 10 MB

LOINC_MAP = {
    'lab_report':   ('11502-2', 'Laboratory report'),
    'imaging':      ('18748-4', 'Diagnostic imaging study'),
    'prescription': ('57833-6', 'Prescription for medication'),
    'other':        ('34133-9', 'Summary of episode note'),
}


def _serialize_document(doc):
    """Convert a MongoDB document dict into a JSON-serialisable response."""
    attachment = (doc.get('content') or [{}])[0].get('attachment', {})
    return {
        'id': str(doc['_id']),
        'category': doc.get('category', 'other'),
        'description': doc.get('description', ''),
        'url': attachment.get('url', ''),
        'title': attachment.get('title', ''),
        'created_at': doc.get('created_at', ''),
    }


@ehr_routes.route('/api/patient/documents', methods=['GET'])
@token_required
@api_error_handler
def get_own_documents(current_user):
    """GET /api/patient/documents — patient retrieves their own documents."""
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Unauthorized access'}), 403

    patient_id = str(current_user['_id'])
    docs = list(
        mongo.db.ehr_documents
        .find({'patient_id': patient_id})
        .sort('date', -1)
    )
    return jsonify([_serialize_document(d) for d in docs]), 200


@ehr_routes.route('/api/patient/documents', methods=['POST'])
@token_required
@api_error_handler
def upload_own_document(current_user):
    """POST /api/patient/documents — patient uploads a document (image or PDF).

    Expects a multipart/form-data request with:
      file        — the file to upload (image or PDF, max 10 MB)
      category    — one of: lab_report, imaging, prescription, other
      description — short text description (required)
    """
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Unauthorized access'}), 403

    if 'file' not in request.files:
        return jsonify({'error': 'No file provided. Send the file as the "file" field.'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    if file.mimetype not in DOCUMENT_ALLOWED_MIME_TYPES:
        return jsonify({
            'error': f'Unsupported file type: {file.mimetype}. '
                     'Allowed types: JPEG, PNG, WebP, PDF'
        }), 400

    file_bytes = file.read()
    if len(file_bytes) > DOCUMENT_MAX_FILE_BYTES:
        return jsonify({'error': 'File too large. Maximum allowed size is 10 MB.'}), 400

    category = request.form.get('category', 'other')
    valid_categories = {'lab_report', 'imaging', 'prescription', 'other'}
    if category not in valid_categories:
        category = 'other'

    description = request.form.get('description', '').strip()
    if not description:
        return jsonify({'error': 'Description is required.'}), 400

    encounter_id = request.form.get('encounter_id', '').strip() or None

    patient_id = str(current_user['_id'])
    doc_uuid = str(uuid4())

    resource_type = 'image' if file.mimetype.startswith('image/') else 'raw'
    upload_result = cloudinary.uploader.upload(
        file_bytes,
        folder='morafek/documents',
        public_id=f'patient_{patient_id}_{doc_uuid}',
        overwrite=False,
        resource_type=resource_type,
    )

    cloudinary_url = upload_result.get('secure_url')
    if not cloudinary_url:
        logger.error('Cloudinary document upload succeeded but returned no secure_url')
        return jsonify({'error': 'Upload failed: no URL returned'}), 500

    cloudinary_public_id = upload_result.get('public_id', '')
    loinc_code, loinc_display = LOINC_MAP.get(category, ('34133-9', 'Document'))

    document = {
        'resourceType': 'DocumentReference',
        'id': doc_uuid,
        'patient_id': patient_id,
        'uploaded_by': str(current_user['_id']),
        'author': (
            [{'reference': f"Practitioner/{str(current_user['_id'])}"}]
            if current_user.get('user_type') == 'doctor'
            else [{'reference': f"Patient/{str(current_user['_id'])}"}]
        ),
        'status': 'current',
        'type': {
            'coding': [{
                'system': 'http://loinc.org',
                'code': loinc_code,
                'display': loinc_display,
            }]
        },
        'category': category,
        'subject': {'reference': f'Patient/{patient_id}'},
        'date': datetime.now(timezone.utc).isoformat() + 'Z',
        'description': description,
        'content': [{
            'attachment': {
                'contentType': file.mimetype,
                'url': cloudinary_url,
                'title': file.filename,
                'creation': datetime.now(timezone.utc).isoformat() + 'Z',
            }
        }],
        'context': (
            {'encounter': [{'reference': f'Encounter/{encounter_id}'}]}
            if encounter_id else {}
        ),
        'cloudinary_public_id': cloudinary_public_id,
    }

    result = mongo.db.ehr_documents.insert_one(document)
    logger.info('Document uploaded successfully')

    document['_id'] = result.inserted_id
    return jsonify(_serialize_document(document)), 201


@ehr_routes.route('/api/patient/documents/<document_id>', methods=['DELETE'])
@token_required
@api_error_handler
def delete_own_document(current_user, document_id):
    """DELETE /api/patient/documents/<document_id> — patient deletes one of their documents."""
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Unauthorized access'}), 403

    patient_id = str(current_user['_id'])

    try:
        doc = mongo.db.ehr_documents.find_one({
            '_id': ObjectId(document_id),
            'patient_id': patient_id,
        })
    except Exception:
        return jsonify({'error': 'Invalid document ID'}), 400

    if not doc:
        return jsonify({'error': 'Document not found'}), 404

    # Remove from Cloudinary
    public_id = doc.get('cloudinary_public_id')
    if public_id:
        try:
            attachment = (doc.get('content') or [{}])[0].get('attachment', {})
            url = attachment.get('url', '') or doc.get('url', '')
            ext = url.rsplit('.', 1)[-1].lower()
            resource_type = 'image' if ext in ('jpg', 'jpeg', 'png', 'webp', 'gif') else 'raw'
            cloudinary.uploader.destroy(public_id, resource_type=resource_type)
        except Exception as e:
            logger.warning(f'Cloudinary deletion failed for {public_id}: {e}')

    mongo.db.ehr_documents.delete_one({'_id': ObjectId(document_id)})
    logger.info('Document deleted successfully')
    return jsonify({'message': 'Document deleted'}), 200


@ehr_routes.route('/api/doctor/patient/<patient_id>/documents', methods=['GET'])
@token_required
@api_error_handler
def get_patient_documents(current_user, patient_id):
    """GET /api/doctor/patient/<patient_id>/documents — doctor views a patient's documents."""
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    docs = list(
        mongo.db.ehr_documents
        .find({'patient_id': patient_id})
        .sort('date', -1)
    )
    return jsonify([_serialize_document(d) for d in docs]), 200


# ─── Physical Therapy Exercises (ehr_exercises) ───────────────────────────────

EXERCISE_VALID_CATEGORIES = {'mobility', 'strength', 'balance', 'breathing', 'other'}


def _serialize_exercise(doc):
    """Convert a MongoDB ehr_exercises document into a JSON-serialisable response."""
    return {
        'id': str(doc['_id']),
        'patient_id': doc.get('patient_id', ''),
        'doctor_id': doc.get('doctor_id', ''),
        'title': doc.get('title', ''),
        'description': doc.get('description', ''),
        'category': doc.get('category', 'other'),
        'frequency': doc.get('frequency', ''),
        'duration_minutes': doc.get('duration_minutes'),
        'repetitions': doc.get('repetitions'),
        'sets': doc.get('sets'),
        'video_url': doc.get('video_url', ''),
        'image_url': doc.get('image_url', ''),
        'active': doc.get('active', True),
        'order': doc.get('order', 0),
        'created_at': doc.get('created_at', ''),
        'notes': doc.get('notes', ''),
    }


@ehr_routes.route('/api/doctor/patient/<patient_id>/exercises', methods=['POST'])
@token_required
@api_error_handler
def create_exercise(current_user, patient_id):
    """POST /api/doctor/patient/<patient_id>/exercises — assign a physical therapy exercise.

    Required JSON fields:
      title             (str) — name of the exercise, e.g. "Ankle Circles"
      description       (str) — full instructions
      category          (str) — one of: mobility, strength, balance, breathing, other
      frequency         (str) — e.g. "3 times daily"
      duration_minutes  (int) — e.g. 10
      order             (int) — display order
    Optional JSON fields:
      repetitions (int) — e.g. 15
      sets        (int) — number of sets
      video_url   (str) — YouTube or Cloudinary URL
      image_url   (str) — demonstration image URL
      active      (bool) — defaults to true
      notes       (str)  — clinical notes visible to patient
    """
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    data = request.get_json()
    if not data:
        return jsonify({'error': 'Missing request body'}), 400

    required = ['title', 'description', 'category', 'frequency', 'duration_minutes', 'order']
    for field in required:
        if field not in data:
            return jsonify({'error': f'Missing required field: {field}'}), 400

    category = data['category']
    if category not in EXERCISE_VALID_CATEGORIES:
        return jsonify({
            'error': f'Invalid category: {category}. '
                     f'Must be one of: {", ".join(sorted(EXERCISE_VALID_CATEGORIES))}'
        }), 400

    duration_minutes = data['duration_minutes']
    if not isinstance(duration_minutes, int) or duration_minutes <= 0:
        return jsonify({'error': 'duration_minutes must be a positive integer'}), 400

    order = data['order']
    if not isinstance(order, int):
        return jsonify({'error': 'order must be an integer'}), 400

    repetitions = data.get('repetitions')
    if repetitions is not None and (not isinstance(repetitions, int) or repetitions <= 0):
        return jsonify({'error': 'repetitions must be a positive integer'}), 400

    sets = data.get('sets')
    if sets is not None and (not isinstance(sets, int) or sets <= 0):
        return jsonify({'error': 'sets must be a positive integer'}), 400

    doctor_id = str(current_user['_id'])
    created_at = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    document = {
        'patient_id': patient_id,
        'doctor_id': doctor_id,
        'title': data['title'].strip(),
        'description': data['description'].strip(),
        'category': category,
        'frequency': data['frequency'].strip(),
        'duration_minutes': duration_minutes,
        'repetitions': repetitions,
        'sets': sets,
        'video_url': data.get('video_url', ''),
        'image_url': data.get('image_url', ''),
        'active': data.get('active', True),
        'order': order,
        'created_at': created_at,
        'notes': data.get('notes', ''),
    }

    result = mongo.db.ehr_exercises.insert_one(document)
    logger.info('Exercise created in ehr_exercises')

    document['_id'] = result.inserted_id
    return jsonify(_serialize_exercise(document)), 201


@ehr_routes.route('/api/doctor/patient/<patient_id>/exercises', methods=['GET'])
@token_required
@api_error_handler
def get_exercises(current_user, patient_id):
    """GET /api/doctor/patient/<patient_id>/exercises — list all exercises for a patient."""
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    docs = list(
        mongo.db.ehr_exercises
        .find({'patient_id': patient_id})
        .sort('order', 1)
    )
    return jsonify([_serialize_exercise(d) for d in docs]), 200


@ehr_routes.route('/api/doctor/patient/<patient_id>/exercises/<exercise_id>', methods=['PUT'])
@token_required
@api_error_handler
def update_exercise(current_user, patient_id, exercise_id):
    """PUT /api/doctor/patient/<patient_id>/exercises/<exercise_id> — update an exercise.

    All fields are optional; only provided fields will be updated.
    """
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    data = request.get_json()
    if not data:
        return jsonify({'error': 'Missing request body'}), 400

    try:
        exercise_oid = ObjectId(exercise_id)
    except Exception:
        return jsonify({'error': 'Invalid exercise ID'}), 400

    doc = mongo.db.ehr_exercises.find_one({
        '_id': exercise_oid,
        'patient_id': patient_id,
    })
    if not doc:
        return jsonify({'error': 'Exercise not found'}), 404

    updates = {}

    if 'title' in data:
        updates['title'] = data['title'].strip()
    if 'description' in data:
        updates['description'] = data['description'].strip()
    if 'category' in data:
        if data['category'] not in EXERCISE_VALID_CATEGORIES:
            return jsonify({
                'error': f'Invalid category: {data["category"]}. '
                         f'Must be one of: {", ".join(sorted(EXERCISE_VALID_CATEGORIES))}'
            }), 400
        updates['category'] = data['category']
    if 'frequency' in data:
        updates['frequency'] = data['frequency'].strip()
    if 'duration_minutes' in data:
        if not isinstance(data['duration_minutes'], int) or data['duration_minutes'] <= 0:
            return jsonify({'error': 'duration_minutes must be a positive integer'}), 400
        updates['duration_minutes'] = data['duration_minutes']
    if 'repetitions' in data:
        repetitions = data['repetitions']
        if repetitions is not None and (not isinstance(repetitions, int) or repetitions <= 0):
            return jsonify({'error': 'repetitions must be a positive integer'}), 400
        updates['repetitions'] = repetitions
    if 'sets' in data:
        sets_value = data['sets']
        if sets_value is not None and (not isinstance(sets_value, int) or sets_value <= 0):
            return jsonify({'error': 'sets must be a positive integer'}), 400
        updates['sets'] = sets_value
    if 'video_url' in data:
        updates['video_url'] = data['video_url']
    if 'image_url' in data:
        updates['image_url'] = data['image_url']
    if 'active' in data:
        updates['active'] = bool(data['active'])
    if 'order' in data:
        if not isinstance(data['order'], int):
            return jsonify({'error': 'order must be an integer'}), 400
        updates['order'] = data['order']
    if 'notes' in data:
        updates['notes'] = data['notes']

    if not updates:
        return jsonify({'error': 'No valid fields provided for update'}), 400

    mongo.db.ehr_exercises.update_one({'_id': exercise_oid}, {'$set': updates})
    logger.info('Exercise updated in ehr_exercises')

    updated_doc = mongo.db.ehr_exercises.find_one({'_id': exercise_oid})
    return jsonify(_serialize_exercise(updated_doc)), 200


@ehr_routes.route('/api/doctor/patient/<patient_id>/exercises/<exercise_id>', methods=['DELETE'])
@token_required
@api_error_handler
def delete_exercise(current_user, patient_id, exercise_id):
    """DELETE /api/doctor/patient/<patient_id>/exercises/<exercise_id> — delete an exercise."""
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    try:
        exercise_oid = ObjectId(exercise_id)
    except Exception:
        return jsonify({'error': 'Invalid exercise ID'}), 400

    doc = mongo.db.ehr_exercises.find_one({
        '_id': exercise_oid,
        'patient_id': patient_id,
    })
    if not doc:
        return jsonify({'error': 'Exercise not found'}), 404

    mongo.db.ehr_exercises.delete_one({'_id': exercise_oid})
    logger.info('Exercise deleted from ehr_exercises')
    return jsonify({'message': 'Exercise deleted'}), 200


@ehr_routes.route('/api/patient/exercises', methods=['GET'])
@token_required
@api_error_handler
def get_own_exercises(current_user):
    """GET /api/patient/exercises — patient views their own active exercises."""
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Unauthorized access'}), 403

    patient_id = str(current_user['_id'])
    docs = list(
        mongo.db.ehr_exercises
        .find({'patient_id': patient_id, 'active': True})
        .sort('order', 1)
    )
    return jsonify([_serialize_exercise(d) for d in docs]), 200


@ehr_routes.route('/api/patient/exercises/<exercise_id>/done', methods=['POST'])
@token_required
@api_error_handler
def mark_exercise_done(current_user, exercise_id):
    """POST /api/patient/exercises/<exercise_id>/done — mark an exercise as done or not done.

    Required JSON fields:
      done (bool) — true to mark the exercise completed, false to unmark it
    """
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Unauthorized access'}), 403

    try:
        exercise_oid = ObjectId(exercise_id)
    except Exception:
        return jsonify({'error': 'Invalid exercise ID'}), 400

    patient_id = str(current_user['_id'])
    doc = mongo.db.ehr_exercises.find_one({
        '_id': exercise_oid,
        'patient_id': patient_id,
    })
    if not doc:
        return jsonify({'error': 'Exercise not found'}), 404

    data = request.get_json()
    if not data or 'done' not in data:
        return jsonify({'error': 'Missing required field: done'}), 400

    done = data['done']
    if not isinstance(done, bool):
        return jsonify({'error': 'Field "done" must be a boolean'}), 400

    if done:
        update = {'$set': {'last_done_at': datetime.now(timezone.utc).isoformat()}}
    else:
        update = {'$unset': {'last_done_at': ''}}

    mongo.db.ehr_exercises.update_one({'_id': exercise_oid}, update)
    logger.info('Exercise %s marked done=%s', exercise_id, done)
    return jsonify({'message': 'Exercise updated'}), 200


# ─── ICD-10-GM AI Suggest ────────────────────────────────────────────────────
#
# POST /api/ehr/icd10-suggest
# Doctors only — sends chief_complaint + diagnosis_hint to Gemini 2.5 Flash
# and returns 3-5 ranked ICD-10-GM 2026 codes as structured JSON.
#
# Requires env var: GEMINI_API_KEY
# Package: google-genai>=1.0.0

import os as _os
import re as _re
import json as _json

_GEMINI_API_KEY = _os.environ.get("GEMINI_API_KEY", "")

# Same model used by the working food_scan_service
_ICD10_MODEL = "gemini-2.5-flash"

_ICD10_SYSTEM_PROMPT = """You are a certified medical coder specialising in ICD-10-GM (German Modification).
Given a chief complaint and a diagnosis hint, return the 3-5 most appropriate ICD-10-GM codes.

Return ONLY valid JSON, no markdown, no preamble, no explanation:
[
  {
    "code": "I10",
    "description": "Essentielle (primäre) Hypertonie",
    "rationale": "Primäre Hypertonie ohne Organschaden"
  }
]

Rules:
- Use German ICD-10-GM 2026 codes only.
- Prefer specific (5-character) codes over umbrella codes when the hint is detailed enough.
- Include a short German rationale (max 10 words).
- If the hint is too vague, return the best 3 candidates."""


def _strip_markdown_fences(text: str) -> str:
    """Remove ```json ... ``` or ``` ... ``` wrappers Gemini sometimes adds."""
    match = _re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if match:
        return match.group(1).strip()
    return text.strip()


@ehr_routes.route('/api/ehr/icd10-suggest', methods=['POST'])
@token_required
@api_error_handler
def icd10_suggest(current_user):
    """POST /api/ehr/icd10-suggest — Gemini-powered ICD-10-GM code suggestions (doctors only).

    Required JSON fields (at least one):
      chief_complaint (str) — patient's main reason for the visit
      diagnosis_hint  (str) — free-text diagnosis the doctor is considering

    Returns:
      { "suggestions": [ { "code", "description", "rationale" }, ... ] }
    """
    if current_user.get('user_type') != 'doctor':
        return jsonify({'error': 'Only doctors can use ICD-10 suggest'}), 403

    if not _GEMINI_API_KEY:
        logger.error("GEMINI_API_KEY is not set — ICD-10 suggest unavailable")
        return jsonify({'error': 'AI service is not configured on this server'}), 503

    body = request.get_json(silent=True) or {}
    chief_complaint = (body.get('chief_complaint') or '').strip()
    diagnosis_hint  = (body.get('diagnosis_hint')  or '').strip()

    if not chief_complaint and not diagnosis_hint:
        return jsonify({'error': 'chief_complaint or diagnosis_hint is required'}), 400

    user_text = (
        f"Leitsymptom: {chief_complaint or '(nicht angegeben)'}\n"
        f"Diagnosehinweis: {diagnosis_hint or '(nicht angegeben)'}"
    )

    try:
        # Imported here so a missing package returns a clean 503
        # rather than crashing the entire blueprint at startup.
        from google import genai as _genai          # noqa: PLC0415
        from google.genai import types as _types    # noqa: PLC0415

        client = _genai.Client(api_key=_GEMINI_API_KEY)

        # Mirror food_scan_service: text part + GenerateContentConfig with
        # response_mime_type="application/json" — forces strict JSON output
        # and eliminates markdown fences / single-quoted keys entirely.
        contents = [
            _types.Part.from_text(text=_ICD10_SYSTEM_PROMPT),
            _types.Part.from_text(text=user_text),
        ]
        response = client.models.generate_content(
            model=_ICD10_MODEL,
            contents=contents,
            config=_types.GenerateContentConfig(
                temperature=0.1,
                max_output_tokens=4096,
                response_mime_type="application/json",
            ),
        )

        raw = response.text
        if not raw:
            raise ValueError("Gemini returned an empty/blocked response")
        raw = raw.strip()

    except ImportError:
        logger.error("google-genai package is not installed")
        return jsonify({'error': 'AI service is not configured on this server'}), 503
    except Exception as e:
        logger.error("Gemini API error in icd10_suggest: %s", e)
        # Include the real error detail so it's visible in the app (not just in Render logs)
        return jsonify({'error': 'AI service temporarily unavailable', 'detail': str(e)}), 502

    # Strip fences as a safety net (response_mime_type makes this rare)
    raw = _strip_markdown_fences(raw)

    try:
        suggestions = _json.loads(raw)
    except _json.JSONDecodeError as e:
        logger.error("Failed to parse Gemini ICD-10 response: %s | raw: %s", e, raw)
        return jsonify({'error': 'AI returned an unexpected response format'}), 502

    if not isinstance(suggestions, list):
        logger.error("Gemini ICD-10 response is not a list: %s", raw)
        return jsonify({'error': 'AI returned an unexpected response format'}), 502

    # Sanitise — keep only the expected keys, skip malformed entries
    clean = [
        {
            'code':        str(item['code']).strip(),
            'description': str(item['description']).strip(),
            'rationale':   str(item.get('rationale', '')).strip() or None,
        }
        for item in suggestions
        if isinstance(item, dict) and item.get('code') and item.get('description')
    ]

    logger.info(
        "ICD-10 suggest: %d codes returned for doctor %s",
        len(clean), str(current_user['_id'])
    )
    return jsonify({"suggestions": clean}), 200


# ─── ICD-10 Connectivity Test (no auth — open in browser to diagnose) ────────
#
# GET /api/ehr/icd10-suggest/test
# Returns the real Gemini error message so you can see exactly why it fails
# without needing to dig through Render logs.
# Safe to leave deployed — it only sends a harmless "ping" to Gemini.

@ehr_routes.route('/api/ehr/icd10-suggest/test', methods=['GET'])
def icd10_suggest_test():
    """
    Connectivity test — no auth required.
    Open in a browser:  https://morafek-caremate.onrender.com/api/ehr/icd10-suggest/test

    Returns JSON with status + the real error detail so you can diagnose the 502.
    """
    import os as _os_test
    api_key = _os_test.environ.get("GEMINI_API_KEY")
    if not api_key:
        return jsonify({
            "status": "error",
            "step": "env",
            "detail": "GEMINI_API_KEY is not set in Render environment variables",
        }), 500

    models_to_try = ["gemini-2.5-flash", "gemini-2.0-flash"]
    results = {}

    try:
        from google import genai as _genai_t
        from google.genai import types as _types_t
        client = _genai_t.Client(api_key=api_key)
    except ImportError as e:
        return jsonify({
            "status": "error",
            "step": "import",
            "detail": f"google-genai package not installed or broken: {e}",
        }), 500

    for model in models_to_try:
        try:
            resp = client.models.generate_content(
                model=model,
                contents=[_types_t.Part.from_text(text="ping — reply with one word: ok")],
                config=_types_t.GenerateContentConfig(max_output_tokens=10),
            )
            results[model] = {"ok": True, "response": resp.text.strip() if resp.text else "(empty)"}
        except Exception as exc:
            results[model] = {"ok": False, "error": str(exc)}

    any_ok = any(v["ok"] for v in results.values())
    return jsonify({
        "status": "ok" if any_ok else "error",
        "key_prefix": api_key[:8] + "…",   # show first 8 chars to confirm correct key
        "models": results,
    }), 200 if any_ok else 502


# ─── FHIR R4 Bundle Export ────────────────────────────────────────────────────

def _build_ehr_entries(patient_id: str, default_performer_ref: str) -> list:
    """
    Collect all clinical entries (Observations, Encounters, Conditions,
    DocumentReferences, Medications) for *patient_id*.

    The Patient entry itself is intentionally excluded — each export route
    constructs its own Patient resource (full-PII vs. pseudonymised) and
    prepends it separately.

    Returns a flat list of FHIR entry dicts ready to be appended to a bundle.
    """
    entries: list = []

    # ── Vitals — one Observation per vital sign ───────────────────────────────
    for doc in mongo.db.ehr_vitals.find({'patient_id': patient_id}):
        recorded_by = doc.get('recorded_by')
        if recorded_by:
            doc_user = mongo.db.users.find_one(
                {'_id': ObjectId(recorded_by)}, {'user_type': 1}
            ) or {}
            utype       = doc_user.get('user_type', 'patient')
            performer_r = f"{'Practitioner' if utype == 'doctor' else 'Patient'}/{recorded_by}"
        else:
            performer_r = default_performer_ref

        for obs in build_observations_from_vitals_doc(
            doc, patient_id, performer_ref=performer_r
        ):
            entries.append({'fullUrl': f'urn:uuid:{obs["id"]}', 'resource': obs})

    # ── Visits — Encounter resources ──────────────────────────────────────────
    # Collected separately so we can strip dangling Condition refs after the
    # Conditions pass (below) identifies which condition IDs were skipped.
    bundled_encounter_ids: set[str] = set()
    encounter_entries: list[dict] = []

    for doc in mongo.db.ehr_visits.find({'patient_id': patient_id}):
        resource = {k: v for k, v in doc.items()
                    if k not in ('_id', 'patient_id', 'doctor_id')}
        resource['resourceType'] = 'Encounter'
        resource.setdefault('id', str(doc['_id']))
        # build_isik_encounter_fields() stamps profiles AND adds identifier/type/serviceType
        # (replaces bare add_de_profile call which was missing those required fields)
        build_isik_encounter_fields(resource)
        bundled_encounter_ids.add(resource['id'])
        encounter_entries.append({'fullUrl': f'urn:uuid:{resource["id"]}', 'resource': resource})

    # ── Conditions ────────────────────────────────────────────────────────────
    skipped_condition_ids: set[str] = set()
    condition_entries: list[dict] = []

    for doc in mongo.db.ehr_conditions.find({'patient_id': patient_id}):
        resource = {k: v for k, v in doc.items()
                    if k not in ('_id', 'patient_id', 'encounter_id')}
        resource['resourceType'] = 'Condition'
        resource.setdefault('id', str(doc['_id']))

        coding = resource.get('code', {}).get('coding', [])
        if not coding or not coding[0].get('code'):
            logger.warning(
                'Condition %s skipped in FHIR export: empty code.coding (no ICD code recorded)',
                resource['id'],
            )
            skipped_condition_ids.add(resource['id'])
            continue

        # build_isik_condition_fields() stamps profiles AND adds recordedDate
        build_isik_condition_fields(resource)
        condition_entries.append({'fullUrl': f'urn:uuid:{resource["id"]}', 'resource': resource})

    # ── Clean dangling Encounter.diagnosis refs → skipped Conditions ──────────
    # FHIR R4 §3.3: a document bundle must be self-contained. Any Condition that
    # was skipped (empty ICD code) must be removed from the referring Encounter's
    # diagnosis array, otherwise validators flag a broken reference.
    if skipped_condition_ids:
        for enc_entry in encounter_entries:
            enc_res  = enc_entry['resource']
            orig_diag = enc_res.get('diagnosis', [])
            if not orig_diag:
                continue
            cleaned = [
                d for d in orig_diag
                if d.get('condition', {}).get('reference', '').split('/')[-1]
                   not in skipped_condition_ids
            ]
            if len(cleaned) != len(orig_diag):
                logger.info(
                    'Encounter %s: removed %d dangling diagnosis ref(s) to skipped Condition(s)',
                    enc_res['id'], len(orig_diag) - len(cleaned),
                )
                if cleaned:
                    enc_res['diagnosis'] = cleaned
                else:
                    enc_res.pop('diagnosis', None)

    entries.extend(encounter_entries)
    entries.extend(condition_entries)

    # ── Documents — DocumentReference resources ───────────────────────────────
    for doc in mongo.db.ehr_documents.find({'patient_id': patient_id}):
        resource = {k: v for k, v in doc.items()
                    if k not in ('_id', 'patient_id', 'uploaded_by', 'cloudinary_public_id')}
        resource['resourceType'] = 'DocumentReference'
        resource.setdefault('id', str(doc['_id']))
        entries.append({'fullUrl': f'urn:uuid:{resource["id"]}', 'resource': resource})

    # ── Medications — KBV Medication + MedicationRequest + MedicationStatement ─
    medication_docs = list(mongo.db.medications.find({'patient_id': patient_id, 'is_active': True}))
    medication_ids  = [str(doc['_id']) for doc in medication_docs]
    intake_cutoff   = (
        datetime.now(timezone.utc) - timedelta(days=MEDICATION_INTAKE_LOOKBACK_DAYS)
    ).strftime('%Y-%m-%d')
    intake_docs = list(
        mongo.db.med_intakes.find({
            'patient_id':    patient_id,
            'medication_id': {'$in': medication_ids},
            'date':          {'$gte': intake_cutoff},
        })
    ) if medication_ids else []

    intakes_by_medication: dict[str, list[dict]] = {}
    for intake_doc in intake_docs:
        mid = str(intake_doc.get('medication_id', ''))
        if mid:
            intakes_by_medication.setdefault(mid, []).append(intake_doc)

    for med_doc in medication_docs:
        med_with_patient = dict(med_doc)
        med_with_patient.setdefault('patient_id', patient_id)
        medication_resource = build_medication_resource(med_with_patient)
        medication_request  = build_fhir_medication_request(med_with_patient)
        validate_kbv_medication_resource(medication_resource)
        validate_kbv_medication_request_resource(medication_request)

        enc_ref = medication_request.get('encounter', {}).get('reference', '')
        if enc_ref:
            enc_id = enc_ref.split('/')[-1]
            if enc_id not in bundled_encounter_ids:
                logger.warning(
                    'MedicationRequest %s: dropping encounter reference %s — '
                    'encounter not present in bundle',
                    medication_request['id'], enc_ref,
                )
                medication_request.pop('encounter', None)

        entries.append({'fullUrl': f'urn:uuid:{medication_resource["id"]}', 'resource': medication_resource})
        entries.append({'fullUrl': f'urn:uuid:{medication_request["id"]}',  'resource': medication_request})

        med_id = str(med_doc['_id'])
        for intake_doc in intakes_by_medication.get(med_id, []):
            statement = build_medication_statement(intake_doc, med_doc, patient_id)
            entries.append({'fullUrl': f'urn:uuid:{statement["id"]}', 'resource': statement})

    med_validation = validate_medication_bundle_entries(entries)
    if not med_validation.get('valid', True):
        logger.warning(
            'Medication structural validation failed with %d error(s).',
            len(med_validation.get('errors', [])),
        )

    return entries


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/patient/fhir-export  — full export (personal use, all PII included)
# ─────────────────────────────────────────────────────────────────────────────

@ehr_routes.route('/api/patient/fhir-export', methods=['GET'])
@token_required
@api_error_handler
def fhir_export(current_user):
    """GET /api/patient/fhir-export — export the patient's full EHR as a FHIR R4 Bundle.

    Returns a conformant FHIR R4 document Bundle containing:
      - Composition            (required first entry, FHIR R4 §3.3)
      - Patient                (self-contained — referenced resources must be bundled)
      - Observation resources  (vitals — split into one per vital sign)
      - Encounter resources    (visits)
      - Condition resources    (diagnoses linked to visits)
      - DocumentReference resources (uploaded documents)
      - Medication resources (KBV_PR_ERP_Medication_PZN)
      - MedicationRequest resources (KBV_PR_ERP_Prescription)
      - MedicationStatement resources (patient intake status)

    All personally identifying data (name, address, telecom, etc.) is included.
    For a research-safe pseudonymised version use /api/patient/fhir-export/pseudonymised.

    Conformance fixes applied vs. previous version:
      • Bundle.total removed        (invalid for type=document)
      • Bundle.identifier added     (required by KBV / gematik ePA)
      • Composition added as first entry (FHIR R4 §3.3)
      • Observations split per vital sign (MII / ISiK requirement)
      • Patient resource bundled    (document must be self-contained)
      • performer added to all Observations
      • Conditions with empty code.coding skipped (ISiKDiagnose non-conformant)
      • MedicationRequest.encounter stripped when encounter not in bundle
    """
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Unauthorized access'}), 403

    patient_id = str(current_user['_id'])

    from utils.fhir_de import build_fhir_patient
    from config import mongo as _mongo
    from bson.objectid import ObjectId as _ObjId

    user    = _mongo.db.users.find_one({'_id': _ObjId(patient_id)}, {'password': 0}) or {}
    id_doc  = _mongo.db.patient_fhir_identifiers.find_one({'patient_id': patient_id}) or {}
    medical = _mongo.db.patient_profiles.find_one({'patient_id': patient_id}) or {}

    pseudonym  = id_doc.get('pseudonym')
    # Full PII export always uses the real MongoDB _id as Patient.id.
    # The pseudonym belongs only in the pseudonymised export's identifier list.
    fhir_pid   = patient_id
    author_ref = f'Patient/{fhir_pid}'

    fhir_patient = build_fhir_patient(
        user,
        gkv_kvid    = id_doc.get('gkv_kvid'),
        birthdate   = medical.get('date_of_birth'),
        gender      = medical.get('gender'),
        phone       = id_doc.get('phone'),
        street      = id_doc.get('street'),
        postal_code = id_doc.get('postal_code'),
        city        = id_doc.get('city'),
    )
    # build_fhir_patient() already sets id = str(user["_id"]) == patient_id.
    # No override needed; the line below is intentionally removed.

    entries = [{'fullUrl': f'urn:uuid:{fhir_pid}', 'resource': fhir_patient}]
    entries.extend(_build_ehr_entries(patient_id, default_performer_ref=author_ref))

    # Rewrite any Patient/<mongo_id> references when a pseudonym is in use
    if fhir_pid != patient_id:
        import json as _j
        raw = _j.dumps(entries)
        raw = raw.replace(f'Patient/{patient_id}', f'Patient/{fhir_pid}')
        raw = raw.replace(f'urn:uuid:{patient_id}', f'urn:uuid:{fhir_pid}')
        entries = _j.loads(raw)
        logger.info('FHIR export: rewrote Patient/%s → Patient/%s', patient_id, fhir_pid)

    bundle = build_document_bundle(fhir_pid, entries, author_ref=author_ref)
    logger.info(
        'FHIR R4 document Bundle exported (%d entries, %d observations)',
        len(bundle['entry']),
        sum(1 for e in entries if e['resource'].get('resourceType') == 'Observation'),
    )
    return jsonify(bundle), 200


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/patient/fhir-export/pseudonymised  — research-safe export
# ─────────────────────────────────────────────────────────────────────────────

@ehr_routes.route('/api/patient/fhir-export/pseudonymised', methods=['GET'])
@token_required
@api_error_handler
def fhir_export_pseudonymised(current_user):
    """GET /api/patient/fhir-export/pseudonymised — pseudonymised FHIR R4 Bundle.

    Identical clinical content to /api/patient/fhir-export but all patient-
    identifying data is stripped from the Patient resource before export:

      • Patient.name    — removed
      • Patient.telecom — removed
      • Patient.address — removed
      • Patient.identifier — replaced with pseudonym-only entry
        (system: https://morafek.app/fhir/sid/pseudonym)
      • All Patient/<mongo_id> references rewritten to Patient/<pseudonym>
      • Composition.subject uses pseudonym (build_document_bundle called with
        fhir_pid, not patient_id)

    Clinical fields retained for research utility: gender, birthDate.

    Requires:
      • Authenticated patient (user_type == 'patient')
      • Consent status == 'granted' in patient_consents
      • A gPAS pseudonym stored in patient_fhir_identifiers or patient_consents

    Returns 403 if consent not granted, 503 if pseudonym not yet assigned.
    """
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Unauthorized access'}), 403

    patient_id = str(current_user['_id'])

    from config import mongo as _mongo
    from bson.objectid import ObjectId as _ObjId  # noqa: F401 (kept for id_doc queries)

    # ── Require active consent ─────────────────────────────────────────────────
    consent_record = _mongo.db.patient_consents.find_one({'patient_id': patient_id}) or {}
    if consent_record.get('status') != 'granted':
        return jsonify({
            'error': 'Consent not granted. Enable data-sharing consent before exporting a pseudonymised bundle.'
        }), 403

    # ── Require pseudonym ──────────────────────────────────────────────────────
    id_doc    = _mongo.db.patient_fhir_identifiers.find_one({'patient_id': patient_id}) or {}
    pseudonym = id_doc.get('pseudonym') or consent_record.get('pseudonym')

    if not pseudonym:
        return jsonify({
            'error': 'Pseudonym not yet assigned. Please try again in a moment.'
        }), 503

    medical    = _mongo.db.patient_profiles.find_one({'patient_id': patient_id}) or {}
    fhir_pid   = pseudonym
    author_ref = f'Patient/{fhir_pid}'

    # ── Build pseudonymised Patient resource (allowlist approach) ─────────────
    # Do NOT call build_fhir_patient() and then pop() fields.  The pop() chain
    # is fragile: a stale .pyc, an indentation drift, or a future signature
    # change in build_fhir_patient() can silently leave PII in the bundle.
    # Instead we construct *only* the fields a research bundle may expose:
    #   resourceType · id · meta.profile · identifier (pseudonym only)
    #   active · gender · birthDate
    # Explicitly excluded: name, telecom, address, MongoDB _id in identifier.
    fhir_patient: dict = {
        'resourceType': 'Patient',
        'id': fhir_pid,
        'meta': {
            'profile': [
                'https://morafek.app/fhir/StructureDefinition/PseudonymisedPatient',
            ]
        },
        'identifier': [{
            'system': 'https://morafek.app/fhir/sid/pseudonym',
            'value':  pseudonym,
        }],
        'active': True,
    }

    # GKV-KVID is a statutory identifier, not directly re-identifying on its
    # own — include it when present so researchers can link to GKV records.
    gkv_kvid = id_doc.get('gkv_kvid')
    if gkv_kvid:
        fhir_patient['identifier'].append({
            'type': {'coding': [{
                'system':  'http://fhir.de/CodeSystem/identifier-type-de-basis',
                'code':    'GKV',
                'display': 'Gesetzliche Krankenversicherung',
            }]},
            'system': 'http://fhir.de/sid/gkv/kvid-10',
            'value':  gkv_kvid,
        })

    _gender    = medical.get('gender')
    _birthdate = medical.get('date_of_birth')
    if _gender:
        fhir_patient['gender'] = _gender
    if _birthdate:
        fhir_patient['birthDate'] = _birthdate

    # ── Collect clinical entries (shared helper) ───────────────────────────────
    entries = [{'fullUrl': f'urn:uuid:{fhir_pid}', 'resource': fhir_patient}]
    entries.extend(_build_ehr_entries(patient_id, default_performer_ref=author_ref))

    # ── Rewrite every Patient/<mongo_id> reference → Patient/<pseudonym> ───────
    # This covers subject/performer/author references in Observations, Encounters,
    # Conditions, MedicationRequests and MedicationStatements that were written
    # with the real patient_id at record time.
    import json as _j
    raw = _j.dumps(entries)
    raw = raw.replace(f'Patient/{patient_id}', f'Patient/{fhir_pid}')
    raw = raw.replace(f'urn:uuid:{patient_id}', f'urn:uuid:{fhir_pid}')
    entries = _j.loads(raw)
    logger.info(
        'FHIR pseudonymised export: rewrote Patient/%s → Patient/%s',
        patient_id, fhir_pid,
    )

    # ── Build bundle — pass fhir_pid so Composition.subject uses pseudonym ─────
    bundle = build_document_bundle(fhir_pid, entries, author_ref=author_ref)
    logger.info(
        'FHIR R4 pseudonymised Bundle exported (%d entries, %d observations)',
        len(bundle['entry']),
        sum(1 for e in entries if e['resource'].get('resourceType') == 'Observation'),
    )
    return jsonify(bundle), 200