from flask import Blueprint, request, jsonify
from bson.objectid import ObjectId
from bson.errors import InvalidId
from datetime import datetime, timezone
from utils.auth import token_required
from utils.error_handler import api_error_handler
from routes.doctor_routes import check_doctor_patient_access
from config import mongo
import logging
import html

logger = logging.getLogger(__name__)

medication_routes = Blueprint('medication_routes', __name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _validate_iso_date(value: str, field: str):
    try:
        datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except (ValueError, TypeError):
        return jsonify({'error': f'Invalid {field} format. Use ISO 8601 date or datetime.'}), 400
    return None


def _sanitize_text(value) -> str:
    return html.escape(str(value).strip(), quote=True)


def _normalize_iso_to_ymd(value: str, field: str):
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return parsed.date().isoformat(), None, None
    except (ValueError, TypeError):
        return None, jsonify({'error': f'Invalid {field} format. Use ISO 8601 date or datetime.'}), 400


def _serialize_medication(doc: dict, plan: dict | None = None) -> dict:
    return {
        'id': str(doc.get('_id', '')),
        'patient_id': doc.get('patient_id', ''),
        'doctor_id': doc.get('doctor_id', ''),
        'visit_id': doc.get('visit_id', ''),
        'visit_fhir_id': doc.get('visit_fhir_id', ''),
        'medication_name': doc.get('medication_name', ''),
        'dose': doc.get('dose'),
        'unit': doc.get('unit', ''),
        'route': doc.get('route', ''),
        'frequency': doc.get('frequency', ''),
        'start_date': doc.get('start_date', ''),
        'end_date': doc.get('end_date'),
        'instructions': doc.get('instructions', ''),
        'as_needed': doc.get('as_needed', False),
        'active': doc.get('active', True),
        'created_at': doc.get('created_at', ''),
        'updated_at': doc.get('updated_at', ''),
        'schedule': {
            'intake_times': (plan or {}).get('intake_times', []),
            'timezone': (plan or {}).get('timezone', 'UTC'),
            'reminders_enabled': (plan or {}).get('reminders_enabled', True),
        },
    }


def _serialize_intake(doc: dict) -> dict:
    return {
        'id': str(doc.get('_id')),
        'medication_id': doc.get('medication_id', ''),
        'patient_id': doc.get('patient_id', ''),
        'doctor_id': doc.get('doctor_id', ''),
        'taken': doc.get('taken', False),
        'status': doc.get('status', 'skipped'),
        'intake_date': doc.get('intake_date', ''),
        'time_slot': doc.get('time_slot', ''),
        'notes': doc.get('notes', ''),
        'confirmed_at': doc.get('confirmed_at', ''),
    }


def _apply_intake_date_range_filter(query: dict, date_from: str | None, date_to: str | None):
    if not date_from and not date_to:
        return None

    intake_range = {}

    if date_from:
        normalized_from, error_response, status = _normalize_iso_to_ymd(date_from, 'date_from')
        if error_response:
            return error_response, status
        intake_range['$gte'] = normalized_from

    if date_to:
        normalized_to, error_response, status = _normalize_iso_to_ymd(date_to, 'date_to')
        if error_response:
            return error_response, status
        intake_range['$lte'] = normalized_to

    query['intake_date'] = intake_range
    return None


def _validate_intake_times(intake_times):
    if intake_times is None:
        return [], None
    if not isinstance(intake_times, list) or any(not isinstance(x, str) for x in intake_times):
        return None, (jsonify({'error': 'intake_times must be a string array'}), 400)
    return [x.strip() for x in intake_times if x.strip()], None


def _resolve_visit(patient_id: str, visit_id):
    visit_id = str(visit_id).strip() if visit_id is not None else ''
    if not visit_id:
        return None

    visit_doc = None
    try:
        visit_doc = mongo.db.ehr_visits.find_one({
            '_id': ObjectId(visit_id),
            'patient_id': patient_id,
        })
    except (InvalidId, TypeError):
        visit_doc = None

    if not visit_doc:
        visit_doc = mongo.db.ehr_visits.find_one({
            'id': visit_id,
            'patient_id': patient_id,
        })

    return visit_doc


@medication_routes.route('/api/doctor/patient/<patient_id>/medications', methods=['POST'])
@token_required
@api_error_handler
def create_medication(current_user, patient_id):
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    data = request.get_json()
    if not data:
        return jsonify({'error': 'Missing request body'}), 400

    required = ['visit_id', 'medication_name', 'dose', 'unit', 'frequency', 'start_date']
    for field in required:
        if field not in data or str(data[field]).strip() == '':
            return jsonify({'error': f'Missing required field: {field}'}), 400

    visit_doc = _resolve_visit(patient_id, data['visit_id'])
    if not visit_doc:
        return jsonify({'error': 'Visit not found for patient'}), 404

    try:
        dose = float(data['dose'])
    except (TypeError, ValueError):
        return jsonify({'error': 'dose must be numeric'}), 400
    if dose <= 0:
        return jsonify({'error': 'dose must be greater than zero'}), 400

    date_error = _validate_iso_date(str(data['start_date']).strip(), 'start_date')
    if date_error:
        return date_error

    end_date = data.get('end_date')
    if end_date:
        date_error = _validate_iso_date(str(end_date).strip(), 'end_date')
        if date_error:
            return date_error

    intake_times, intake_times_error = _validate_intake_times(data.get('intake_times', []))
    if intake_times_error:
        return intake_times_error

    doctor_id = str(current_user['_id'])
    now_iso = _now_iso()

    medication_doc = {
        'patient_id': patient_id,
        'doctor_id': doctor_id,
        'visit_id': str(visit_doc['_id']),
        'visit_fhir_id': visit_doc.get('id', ''),
        'medication_name': _sanitize_text(data['medication_name']),
        'dose': dose,
        'unit': _sanitize_text(data['unit']),
        'route': _sanitize_text(data.get('route', 'oral')),
        'frequency': _sanitize_text(data['frequency']),
        'start_date': str(data['start_date']).strip(),
        'end_date': str(end_date).strip() if end_date else None,
        'instructions': _sanitize_text(data.get('instructions', '')),
        'as_needed': bool(data.get('as_needed', False)),
        'active': bool(data.get('active', True)),
        'created_at': now_iso,
        'updated_at': now_iso,
    }
    result = mongo.db.ehr_medications.insert_one(medication_doc)

    plan_doc = {
        'medication_id': str(result.inserted_id),
        'patient_id': patient_id,
        'intake_times': intake_times,
        'timezone': _sanitize_text(data.get('timezone', 'UTC')) or 'UTC',
        'reminders_enabled': bool(data.get('reminders_enabled', True)),
        'created_at': now_iso,
        'updated_at': now_iso,
    }
    mongo.db.ehr_medication_plans.insert_one(plan_doc)

    medication_doc['_id'] = result.inserted_id
    logger.info('Medication prescription created')
    return jsonify(_serialize_medication(medication_doc, plan_doc)), 201


@medication_routes.route('/api/doctor/patient/<patient_id>/medications', methods=['GET'])
@token_required
@api_error_handler
def get_patient_medications(current_user, patient_id):
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    include_inactive = request.args.get('include_inactive', 'false').lower() == 'true'
    query = {'patient_id': patient_id}
    if not include_inactive:
        query['active'] = True

    meds = list(mongo.db.ehr_medications.find(query).sort('created_at', -1))
    plan_map = {
        p['medication_id']: p
        for p in mongo.db.ehr_medication_plans.find({'patient_id': patient_id})
    }
    return jsonify([_serialize_medication(m, plan_map.get(str(m['_id']))) for m in meds]), 200


@medication_routes.route('/api/doctor/patient/<patient_id>/medications/<medication_id>', methods=['PUT'])
@token_required
@api_error_handler
def update_medication(current_user, patient_id, medication_id):
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    data = request.get_json()
    if not data:
        return jsonify({'error': 'Missing request body'}), 400

    try:
        med_oid = ObjectId(medication_id)
    except (InvalidId, TypeError):
        return jsonify({'error': 'Invalid medication ID'}), 400

    existing = mongo.db.ehr_medications.find_one({
        '_id': med_oid,
        'patient_id': patient_id,
    })
    if not existing:
        return jsonify({'error': 'Medication not found'}), 404

    updates = {'updated_at': _now_iso()}

    if 'visit_id' in data:
        visit_doc = _resolve_visit(patient_id, data['visit_id'])
        if not visit_doc:
            return jsonify({'error': 'Visit not found for patient'}), 404
        updates['visit_id'] = str(visit_doc['_id'])
        updates['visit_fhir_id'] = visit_doc.get('id', '')
    if 'medication_name' in data:
        updates['medication_name'] = _sanitize_text(data['medication_name'])
    if 'dose' in data:
        try:
            dose = float(data['dose'])
        except (TypeError, ValueError):
            return jsonify({'error': 'dose must be numeric'}), 400
        if dose <= 0:
            return jsonify({'error': 'dose must be greater than zero'}), 400
        updates['dose'] = dose
    if 'unit' in data:
        updates['unit'] = _sanitize_text(data['unit'])
    if 'route' in data:
        updates['route'] = _sanitize_text(data['route'])
    if 'frequency' in data:
        updates['frequency'] = _sanitize_text(data['frequency'])
    if 'start_date' in data:
        date_error = _validate_iso_date(str(data['start_date']).strip(), 'start_date')
        if date_error:
            return date_error
        updates['start_date'] = str(data['start_date']).strip()
    if 'end_date' in data:
        if data['end_date']:
            date_error = _validate_iso_date(str(data['end_date']).strip(), 'end_date')
            if date_error:
                return date_error
            updates['end_date'] = str(data['end_date']).strip()
        else:
            updates['end_date'] = None
    if 'instructions' in data:
        updates['instructions'] = _sanitize_text(data['instructions'])
    if 'as_needed' in data:
        updates['as_needed'] = bool(data['as_needed'])
    if 'active' in data:
        updates['active'] = bool(data['active'])

    mongo.db.ehr_medications.update_one({'_id': med_oid}, {'$set': updates})

    plan_updates = {}
    if 'intake_times' in data:
        intake_times, intake_times_error = _validate_intake_times(data.get('intake_times', []))
        if intake_times_error:
            return intake_times_error
        plan_updates['intake_times'] = intake_times
    if 'timezone' in data:
        plan_updates['timezone'] = _sanitize_text(data['timezone']) or 'UTC'
    if 'reminders_enabled' in data:
        plan_updates['reminders_enabled'] = bool(data['reminders_enabled'])
    if plan_updates:
        plan_updates['updated_at'] = updates['updated_at']
        mongo.db.ehr_medication_plans.update_one(
            {'medication_id': medication_id, 'patient_id': patient_id},
            {'$set': plan_updates, '$setOnInsert': {'created_at': updates['updated_at']}},
            upsert=True,
        )

    doc = mongo.db.ehr_medications.find_one({'_id': med_oid})
    plan = mongo.db.ehr_medication_plans.find_one({'medication_id': medication_id, 'patient_id': patient_id})
    logger.info('Medication prescription updated')
    return jsonify(_serialize_medication(doc, plan)), 200


@medication_routes.route('/api/doctor/patient/<patient_id>/medications/<medication_id>', methods=['DELETE'])
@token_required
@api_error_handler
def deactivate_medication(current_user, patient_id, medication_id):
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    try:
        med_oid = ObjectId(medication_id)
    except (InvalidId, TypeError):
        return jsonify({'error': 'Invalid medication ID'}), 400

    existing = mongo.db.ehr_medications.find_one({
        '_id': med_oid,
        'patient_id': patient_id,
    })
    if not existing:
        return jsonify({'error': 'Medication not found'}), 404

    mongo.db.ehr_medications.update_one(
        {'_id': med_oid},
        {'$set': {'active': False, 'updated_at': _now_iso()}},
    )
    logger.info('Medication prescription deactivated')
    return jsonify({'message': 'Medication deactivated'}), 200


@medication_routes.route('/api/patient/medications', methods=['GET'])
@token_required
@api_error_handler
def get_own_medications(current_user):
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Unauthorized access'}), 403

    patient_id = str(current_user['_id'])
    include_inactive = request.args.get('include_inactive', 'false').lower() == 'true'
    query = {'patient_id': patient_id}
    if not include_inactive:
        query['active'] = True

    meds = list(mongo.db.ehr_medications.find(query).sort('created_at', -1))
    plan_map = {
        p['medication_id']: p
        for p in mongo.db.ehr_medication_plans.find({'patient_id': patient_id})
    }
    return jsonify([_serialize_medication(m, plan_map.get(str(m['_id']))) for m in meds]), 200


@medication_routes.route('/api/patient/medications/<medication_id>/intake', methods=['POST'])
@token_required
@api_error_handler
def confirm_medication_intake(current_user, medication_id):
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Unauthorized access'}), 403

    patient_id = str(current_user['_id'])

    try:
        med_oid = ObjectId(medication_id)
    except (InvalidId, TypeError):
        return jsonify({'error': 'Invalid medication ID'}), 400

    medication = mongo.db.ehr_medications.find_one({
        '_id': med_oid,
        'patient_id': patient_id,
        'active': True,
    })
    if not medication:
        return jsonify({'error': 'Medication not found'}), 404

    data = request.get_json() or {}
    if 'taken' not in data or not isinstance(data['taken'], bool):
        return jsonify({'error': 'Missing required field: taken (boolean)'}), 400

    raw_intake_date = str(data.get('intake_date', datetime.now(timezone.utc).strftime('%Y-%m-%d'))).strip()
    intake_date, error_response, status = _normalize_iso_to_ymd(raw_intake_date, 'intake_date')
    if error_response:
        return error_response, status

    time_slot = str(data.get('time_slot', '')).strip()

    plan = mongo.db.ehr_medication_plans.find_one({
        'medication_id': medication_id,
        'patient_id': patient_id,
    }) or {}
    planned_slots = plan.get('intake_times', [])
    if time_slot and planned_slots and time_slot not in planned_slots:
        return jsonify({'error': 'time_slot is not part of this medication schedule'}), 400

    now_iso = _now_iso()
    intake_doc = {
        'medication_id': medication_id,
        'patient_id': patient_id,
        'doctor_id': medication.get('doctor_id', ''),
        'taken': data['taken'],
        'status': 'taken' if data['taken'] else 'skipped',
        'intake_date': intake_date,
        'time_slot': time_slot,
        'notes': _sanitize_text(data.get('notes', '')),
        'confirmed_by': patient_id,
        'confirmed_at': now_iso,
        'updated_at': now_iso,
    }

    mongo.db.ehr_medication_intakes.update_one(
        {
            'medication_id': medication_id,
            'patient_id': patient_id,
            'intake_date': intake_doc['intake_date'],
            'time_slot': intake_doc['time_slot'],
        },
        {'$set': intake_doc, '$setOnInsert': {'created_at': now_iso}},
        upsert=True,
    )

    logger.info('Medication intake confirmed')
    return jsonify({'message': 'Medication intake recorded', 'intake': intake_doc}), 200


@medication_routes.route('/api/patient/medications/intakes', methods=['GET'])
@token_required
@api_error_handler
def get_own_medication_intakes(current_user):
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Unauthorized access'}), 403

    patient_id = str(current_user['_id'])
    query = {'patient_id': patient_id}

    medication_id = request.args.get('medication_id')
    if medication_id:
        query['medication_id'] = medication_id

    date_from = request.args.get('date_from')
    date_to = request.args.get('date_to')
    range_error = _apply_intake_date_range_filter(query, date_from, date_to)
    if range_error:
        return range_error

    docs = list(mongo.db.ehr_medication_intakes.find(query).sort('confirmed_at', -1))
    return jsonify([_serialize_intake(d) for d in docs]), 200


@medication_routes.route('/api/doctor/patient/<patient_id>/medications/intakes', methods=['GET'])
@token_required
@api_error_handler
def get_patient_medication_intakes(current_user, patient_id):
    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        return jsonify(err), code

    query = {'patient_id': patient_id}

    medication_id = request.args.get('medication_id')
    if medication_id:
        query['medication_id'] = medication_id

    date_from = request.args.get('date_from')
    date_to = request.args.get('date_to')
    range_error = _apply_intake_date_range_filter(query, date_from, date_to)
    if range_error:
        return range_error

    docs = list(mongo.db.ehr_medication_intakes.find(query).sort('confirmed_at', -1))
    return jsonify([_serialize_intake(d) for d in docs]), 200
