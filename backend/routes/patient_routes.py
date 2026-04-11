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
    if current_user.get('user_type') not in ['patient']:
        return jsonify({'error': 'Patients only'}), 403
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
        'profile_picture_url': user.get('profile_picture_url', ''),
        'ehr_profile': user.get('ehr_profile', {
            'blood_type': '',
            'allergies': [],
            'chronic_conditions': [],
            'emergency_contact': ''
        }),
    }), 200


@patient_routes.route('/api/patient/medical-profile', methods=['GET'])
@token_required
@api_error_handler
def get_patient_medical_profile(current_user):
    """GET /api/patient/medical-profile — returns the patient's full medical
    profile as saved by their doctor in the patient_profiles collection.

    Returns an empty profile shell (all fields present but blank/null) when
    no doctor has filled in the profile yet, so the frontend always gets a
    consistent shape without needing null-guards.
    """
    if current_user.get('user_type') != 'patient':
        return jsonify({'error': 'Patients only'}), 403

    patient_id = str(current_user['_id'])

    # Also fetch basic identity fields from the users collection so the
    # screen can show the patient's name without a second request.
    user = mongo.db.users.find_one(
        {"_id": ObjectId(patient_id)},
        {"first_name": 1, "last_name": 1, "email": 1}
    )

    doc = mongo.db.patient_profiles.find_one({'patient_id': patient_id})

    profile = {
        # Identity (from users collection)
        'first_name': user.get('first_name', '') if user else '',
        'last_name':  user.get('last_name',  '') if user else '',
        'email':      user.get('email',       '') if user else '',

        # Medical profile (from patient_profiles collection)
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