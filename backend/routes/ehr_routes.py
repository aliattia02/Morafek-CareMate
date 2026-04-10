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

    document = {
        'sender_id': current_id,
        'recipient_id': other_user_id,
        'sender_type': sender_type,
        'body': data['body'].strip(),
        'read': False,
        'created_at': created_at,
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
        'date': doc.get('date', ''),
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