from flask import Blueprint, request, jsonify
from bson.objectid import ObjectId
from datetime import datetime, timezone
from uuid import uuid4
from utils.auth import token_required
from utils.error_handler import api_error_handler
from routes.doctor_routes import check_doctor_patient_access
from config import mongo
import cloudinary.uploader
import logging

logger = logging.getLogger(__name__)

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
      diagnosis_icd10  (str) — ICD-10-GM code (German modification), e.g. "E11.9"
      diagnosis_text   (str) — human-readable diagnosis label
    Optional JSON fields:
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

    required = ['chief_complaint', 'diagnosis_icd10', 'diagnosis_text']
    for field in required:
        if field not in data:
            return jsonify({'error': f'Missing required field: {field}'}), 400

    chief_complaint = data['chief_complaint']
    diagnosis_icd10 = data['diagnosis_icd10']
    diagnosis_text = data['diagnosis_text']
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
        'code': {
            'coding': [{
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

    return jsonify({
        'encounter_id': str(encounter_result.inserted_id),
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


# ─── Documents (ehr_documents) ────────────────────────────────────────────────

# Permitted MIME types for document uploads
DOCUMENT_ALLOWED_MIME_TYPES = {
    'image/jpeg', 'image/png', 'image/webp',
    'application/pdf',
}
DOCUMENT_MAX_FILE_BYTES = 10 * 1024 * 1024  # 10 MB


def _serialize_document(doc):
    """Convert a MongoDB document dict into a JSON-serialisable response."""
    return {
        'id': str(doc['_id']),
        'category': doc.get('category', 'other'),
        'description': doc.get('description', ''),
        'url': doc.get('url', ''),
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
        .sort('created_at', -1)
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

    url = upload_result.get('secure_url')
    if not url:
        logger.error('Cloudinary document upload succeeded but returned no secure_url')
        return jsonify({'error': 'Upload failed: no URL returned'}), 500

    created_at = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    document = {
        'patient_id': patient_id,
        'category': category,
        'description': description,
        'url': url,
        'cloudinary_public_id': upload_result.get('public_id', ''),
        'created_at': created_at,
    }

    result = mongo.db.ehr_documents.insert_one(document)
    logger.info(f'Document uploaded for patient {patient_id}')

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
            ext = doc.get('url', '').rsplit('.', 1)[-1].lower()
            resource_type = 'image' if ext in ('jpg', 'jpeg', 'png', 'webp', 'gif') else 'raw'
            cloudinary.uploader.destroy(public_id, resource_type=resource_type)
        except Exception as e:
            logger.warning(f'Cloudinary deletion failed for {public_id}: {e}')

    mongo.db.ehr_documents.delete_one({'_id': ObjectId(document_id)})
    logger.info(f'Document {document_id} deleted by patient {patient_id}')
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
        .sort('created_at', -1)
    )
    return jsonify([_serialize_document(d) for d in docs]), 200