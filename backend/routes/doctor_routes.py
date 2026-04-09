from flask import Blueprint, jsonify
from bson.objectid import ObjectId
from utils.auth import token_required
from utils.error_handler import api_error_handler
from config import mongo
import logging

logger = logging.getLogger(__name__)
doctor_routes = Blueprint('doctor_routes', __name__)


def check_doctor_patient_access(current_user, patient_id):
    """
    Check if the current user has access to the patient's data.
    Returns (has_access, error_response, status_code)
    """
    user_type = current_user.get('user_type')

    # Admins have access to all patients
    if user_type == 'admin':
        return True, None, None

    # Must be a doctor
    if user_type != 'doctor':
        return False, {'message': 'Unauthorized access'}, 403

    # Check if doctor is authorized by this patient
    doctor_id = str(current_user['_id'])
    patient = mongo.db.users.find_one({"_id": ObjectId(patient_id)})

    if not patient:
        return False, {'message': 'Patient not found'}, 404

    authorized_doctors = patient.get('authorized_doctors', [])

    if doctor_id not in authorized_doctors:
        return False, {'message': 'You are not authorized to view this patient\'s data'}, 403

    return True, None, None


@doctor_routes.route('/api/doctor/patients', methods=['GET'])
@token_required
@api_error_handler
def get_doctor_patients(current_user):
    """
    Get list of patients.
    - Admins see all patients
    - Doctors only see patients who have authorized them
    """
    user_type = current_user.get('user_type')
    logger.debug(f"Attempting to fetch patients for user: {current_user.get('_id')} (type: {user_type})")

    # Check user type
    if user_type not in ['doctor', 'admin']:
        logger.warning(f"Unauthorized access attempt by user: {current_user.get('_id')}")
        return jsonify({'message': 'Unauthorized access'}), 403

    doctor_id = str(current_user['_id'])

    # Build query based on user type
    if user_type == 'admin':
        query = {"user_type": "patient"}
    else:
        query = {
            "user_type": "patient",
            "authorized_doctors": doctor_id
        }

    patients = list(mongo.db.users.find(query, {"password": 0}))

    patient_list = []
    for patient in patients:
        try:
            patient_data = {
                'id': str(patient['_id']),
                'firstName': patient.get('first_name', ''),
                'lastName': patient.get('last_name', ''),
                'email': patient.get('email', ''),
                'activeConditions': patient.get('active_conditions', []),
                'activeMedications': patient.get('active_medications', [])
            }
            patient_list.append(patient_data)
        except Exception as e:
            logger.error(f"Error processing patient data: {str(e)}")
            continue

    return jsonify(patient_list), 200

