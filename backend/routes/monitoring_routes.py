from flask import Blueprint, request, jsonify
from datetime import datetime, timezone
from bson.objectid import ObjectId
from utils.auth import token_required
from utils.error_handler import api_error_handler
from routes.doctor_routes import check_doctor_patient_access
from config import mongo
import logging

logger = logging.getLogger(__name__)

monitoring_routes = Blueprint('monitoring_routes', __name__)

THRESHOLDS = {
    "heart_rate":     {"warning": (50, 100),  "critical": (40, 130)},
    "glucose":        {"warning": (70, 180),   "critical": (54, 250)},
    "spo2":           {"warning": (94, 100),   "critical": (90, 100)},
    "blood_pressure": {"warning": (90, 140),   "critical": (80, 180)},
}


def _compute_severity(sensor_type, value):
    """Return 'critical', 'warning', or 'info' based on THRESHOLDS."""
    thresholds = THRESHOLDS.get(sensor_type)
    if not thresholds:
        return "info"

    c_low, c_high = thresholds["critical"]
    if value < c_low or value > c_high:
        return "critical"

    w_low, w_high = thresholds["warning"]
    if value < w_low or value > w_high:
        return "warning"

    return "info"


@monitoring_routes.route('/api/monitoring/alert', methods=['POST'])
@token_required
@api_error_handler
def create_monitoring_alert(current_user):
    """POST /api/monitoring/alert — record a sensor alert."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Missing request body'}), 400

    required = ['patient_id', 'sensor_type', 'value', 'unit']
    for field in required:
        if field not in data:
            return jsonify({'error': f'Missing required field: {field}'}), 400

    patient_id = data['patient_id']
    sensor_type = data['sensor_type']
    value = data['value']
    unit = data['unit']
    message = data.get('message', '')

    # Validate numeric value
    try:
        value = float(value)
    except (TypeError, ValueError):
        return jsonify({'error': 'Field "value" must be numeric'}), 400

    # Determine severity
    severity = data.get('severity')
    if severity not in ('info', 'warning', 'critical'):
        severity = _compute_severity(sensor_type, value)

    now_iso = datetime.now(timezone.utc).isoformat() + "Z"

    alert_doc = {
        'patient_id': patient_id,
        'sensor_type': sensor_type,
        'value': value,
        'unit': unit,
        'severity': severity,
        'message': message,
        'recorded_by': str(current_user['_id']),
        'created_at': now_iso,
    }

    result = mongo.db.monitoring_alerts.insert_one(alert_doc)
    alert_id = str(result.inserted_id)

    # Notify the patient's first authorized doctor when critical
    if severity == 'critical':
        patient = mongo.db.users.find_one({"_id": ObjectId(patient_id)})
        if patient:
            authorized_doctors = patient.get('authorized_doctors', [])
            if authorized_doctors:
                first_doctor_id = authorized_doctors[0]
                mongo.db.ehr_messages.insert_one({
                    'sender_id': 'system',
                    'recipient_id': first_doctor_id,
                    'sender_type': 'system',
                    'recipient_type': 'doctor',
                    'body': (
                        f"\u26a0\ufe0f SENSOR ALERT [{sensor_type.upper()}]: "
                        f"{message} \u2014 Value: {value} {unit}"
                    ),
                    'read': False,
                    'created_at': datetime.now(timezone.utc).isoformat() + "Z",
                })

    return jsonify({'id': alert_id, 'severity': severity, 'message': message}), 201


@monitoring_routes.route('/api/monitoring/alerts/', methods=['GET'])
@token_required
@api_error_handler
def get_monitoring_alerts(current_user):
    """GET /api/monitoring/alerts/ — list sensor alerts.

    Query parameters:
      patient_id (str, optional) — filter by patient; required for doctor/admin callers.

    Access rules:
      - Patients may only retrieve their own alerts.
      - Doctors/admins may retrieve alerts for any patient they have access to
        (access check delegated to check_doctor_patient_access).
    """
    user_type = current_user.get('user_type')
    patient_id = request.args.get('patient_id')

    if user_type == 'patient':
        # Patients always see only their own alerts
        patient_id = str(current_user['_id'])
    elif user_type in ('doctor', 'admin'):
        if not patient_id:
            return jsonify({'error': 'patient_id query parameter is required'}), 400
        has_access, err, code = check_doctor_patient_access(current_user, patient_id)
        if not has_access:
            return jsonify(err), code
    else:
        return jsonify({'error': 'Unauthorized access'}), 403

    query = {'patient_id': patient_id}

    # Optional filters
    sensor_type = request.args.get('sensor_type')
    if sensor_type:
        query['sensor_type'] = sensor_type

    severity = request.args.get('severity')
    if severity:
        query['severity'] = severity

    alerts = list(
        mongo.db.monitoring_alerts.find(query).sort('created_at', -1)
    )

    alert_list = []
    for alert in alerts:
        alert_list.append({
            'id': str(alert['_id']),
            'patient_id': alert.get('patient_id'),
            'sensor_type': alert.get('sensor_type'),
            'value': alert.get('value'),
            'unit': alert.get('unit'),
            'severity': alert.get('severity'),
            'message': alert.get('message', ''),
            'recorded_by': alert.get('recorded_by'),
            'created_at': alert.get('created_at'),
        })

    return jsonify(alert_list), 200
