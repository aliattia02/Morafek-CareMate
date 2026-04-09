from flask import Blueprint, jsonify
from bson.objectid import ObjectId
from utils.auth import token_required
from utils.error_handler import api_error_handler
from config import mongo
import logging

logger = logging.getLogger(__name__)

patient_routes = Blueprint('patient_routes', __name__)


@patient_routes.route('/api/patient/profile', methods=['GET'])
@token_required
@api_error_handler
def get_patient_profile(current_user):
    """GET /api/patient/profile — returns the current patient's profile."""
    user = mongo.db.users.find_one(
        {"_id": ObjectId(str(current_user['_id']))},
        {"password": 0}
    )
    if not user:
        return jsonify({'error': 'User not found'}), 404

    return jsonify({
        'first_name': user.get('first_name', ''),
        'last_name': user.get('last_name', ''),
        'email': user.get('email', ''),
        'ehr_profile': user.get('ehr_profile', {
            'blood_type': '',
            'allergies': [],
            'chronic_conditions': [],
            'emergency_contact': ''
        }),
    }), 200