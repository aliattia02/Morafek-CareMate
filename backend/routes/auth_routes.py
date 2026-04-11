from flask import Blueprint, request, jsonify, current_app
from werkzeug.security import generate_password_hash, check_password_hash
import jwt
import random
from datetime import datetime, timedelta, timezone
from bson.objectid import ObjectId
from utils.auth import token_required, generate_token

auth_routes = Blueprint('auth_routes', __name__)

# Valid user types
VALID_USER_TYPES = ['patient', 'doctor', 'admin']


@auth_routes.route('/login', methods=['POST'])
def login():
    try:
        logger = current_app.logger
        users = current_app.mongo.db.users

        logger.debug("Processing login request")

        data = request.get_json()
        if not data:
            logger.error("No JSON data in request")
            return jsonify({"error": "Missing request data"}), 400

        username  = data.get('username')
        password  = data.get('password')
        user_type = data.get('user_type')

        if not all([username, password, user_type]):
            logger.error("Missing required fields")
            return jsonify({"error": "Missing required fields"}), 400

        if user_type not in VALID_USER_TYPES:
            logger.error(f"Invalid user type: {user_type}")
            return jsonify({"error": f"Invalid user type.  Must be one of: {', '.join(VALID_USER_TYPES)}"}), 400

        user = users.find_one({"username": username, "user_type": user_type})
        logger.debug(f"User lookup completed for username: {username}")

        if user and check_password_hash(user['password'], password):
            token = generate_token(str(user['_id']), user['user_type'])

            response = {
                "message": "Logged in successfully",
                "token": token,
                "user_type": user['user_type'],
                "firstName": user.get('first_name', ''),
                "lastName": user.get('last_name', ''),
                "profile_picture_url": user.get('profile_picture_url', ''),
                "shared_constants": {},
            }

            logger.debug("Login successful")
            return jsonify(response), 200

        logger.warning("Invalid credentials provided")
        return jsonify({"error": "Invalid credentials"}), 401

    except Exception as e:
        logger.error(f"Login error: {str(e)}")
        return jsonify({"error": "Login failed", "details": str(e)}), 500


@auth_routes.route('/register', methods=['POST'])
def register():
    try:
        logger = current_app.logger
        users  = current_app.mongo.db.users

        logger.debug("Processing registration request")

        data = request.get_json()
        if not data:
            logger.error("No JSON data in request")
            return jsonify({"error": "Missing request data"}), 400

        required_fields = ['username', 'email', 'password', 'firstName',
                           'lastName', 'dateOfBirth', 'user_type']

        for field in required_fields:
            if field not in data:
                logger.error(f"Missing required field: {field}")
                return jsonify({"error": f"Missing required field: {field}"}), 400

        if data['user_type'] not in VALID_USER_TYPES:
            logger.error(f"Invalid user type: {data['user_type']}")
            return jsonify({"error": f"Invalid user type. Must be one of: {', '.join(VALID_USER_TYPES)}"}), 400

        if users.find_one({"username": data['username']}):
            logger.warning("Username already exists")
            return jsonify({"error": "Username already exists"}), 400

        if users.find_one({"email": data['email']}):
            logger.warning("Email already exists")
            return jsonify({"error": "Email already exists"}), 400

        user_data = {
            'username':     data['username'],
            'email':        data['email'],
            'password':     generate_password_hash(data['password']),
            'first_name':   data['firstName'],
            'last_name':    data['lastName'],
            'date_of_birth': data['dateOfBirth'],
            'user_type':    data['user_type'],
            'created_at':   datetime.now(timezone.utc),
        }

        if data['user_type'] == 'patient':
            user_data['authorized_doctors'] = []
            user_data['ehr_profile'] = {
                'blood_type': '',
                'allergies': [],
                'chronic_conditions': [],
                'emergency_contact': '',
            }

        # Doctors start with an empty clinic list
        if data['user_type'] == 'doctor':
            user_data['clinic_ids'] = []

        user_id = users.insert_one(user_data).inserted_id
        logger.info(f"User registered successfully: {user_id}")

        return jsonify({
            "message": "User registered successfully",
            "id": str(user_id),
        }), 201

    except Exception as e:
        logger.error(f"Registration error: {str(e)}")
        return jsonify({"error": "Registration failed", "details": str(e)}), 500


@auth_routes.route('/api/doctors', methods=['GET'])
@token_required
def get_available_doctors(current_user):
    """
    GET /api/doctors
    Returns all doctors visible to the current patient.

    Optional query parameter:
        clinic_id   — when supplied, only doctors who belong to that clinic
                      are returned.  The patient still authorizes at the
                      doctor level; this is purely a filter for discovery.
    """
    try:
        logger  = current_app.logger
        users   = current_app.mongo.db.users
        clinics = current_app.mongo.db.clinics

        if current_user.get('user_type') != 'patient':
            return jsonify({'message': 'Only patients can view available doctors'}), 403

        clinic_id = request.args.get('clinic_id', '').strip()

        if clinic_id:
            # Validate clinic exists and collect its doctor IDs
            try:
                clinic = clinics.find_one({"_id": ObjectId(clinic_id)})
            except Exception:
                return jsonify({"error": "Invalid clinic_id format"}), 400

            if not clinic:
                return jsonify({"error": "Clinic not found"}), 404

            doctor_ids_in_clinic = clinic.get("doctors", [])
            if not doctor_ids_in_clinic:
                return jsonify([]), 200

            # Fetch only those doctors
            try:
                object_ids = [ObjectId(did) for did in doctor_ids_in_clinic]
            except Exception:
                return jsonify({"error": "Corrupt clinic doctor list"}), 500

            query = {"_id": {"$in": object_ids}, "user_type": "doctor"}
        else:
            query = {"user_type": "doctor"}

        doctors = list(users.find(query, {"password": 0}))

        doctor_list = []
        for doctor in doctors:
            doctor_data = {
                'id':        str(doctor['_id']),
                'firstName': doctor.get('first_name', ''),
                'lastName':  doctor.get('last_name', ''),
                'email':     doctor.get('email', ''),
                'clinic_ids': doctor.get('clinic_ids', []),
            }
            doctor_list.append(doctor_data)

        return jsonify(doctor_list), 200

    except Exception as e:
        logger.error(f"Error fetching doctors: {str(e)}")
        return jsonify({"error": "Failed to fetch doctors"}), 500


@auth_routes.route('/api/patient/authorized-doctors', methods=['GET'])
@token_required
def get_authorized_doctors(current_user):
    """Get list of doctors authorized by the current patient."""
    try:
        logger = current_app.logger
        users  = current_app.mongo.db.users

        if current_user.get('user_type') != 'patient':
            return jsonify({'message': 'Only patients can view their authorized doctors'}), 403

        patient              = users.find_one({"_id": current_user['_id']})
        authorized_doctor_ids = patient.get('authorized_doctors', [])

        authorized_doctors = []
        for doctor_id in authorized_doctor_ids:
            try:
                doctor = users.find_one({"_id": ObjectId(doctor_id)})
                if doctor:
                    authorized_doctors.append({
                        'id':        str(doctor['_id']),
                        'firstName': doctor.get('first_name', ''),
                        'lastName':  doctor.get('last_name', ''),
                        'email':     doctor.get('email', ''),
                    })
            except Exception as e:
                logger.error(f"Error fetching doctor {doctor_id}: {str(e)}")
                continue

        return jsonify(authorized_doctors), 200

    except Exception as e:
        logger.error(f"Error fetching authorized doctors: {str(e)}")
        return jsonify({"error": "Failed to fetch authorized doctors"}), 500


@auth_routes.route('/api/patient/authorize-doctor', methods=['POST'])
@token_required
def authorize_doctor(current_user):
    """Add a doctor to patient's authorized list."""
    try:
        logger = current_app.logger
        users  = current_app.mongo.db.users

        if current_user.get('user_type') != 'patient':
            return jsonify({'message': 'Only patients can authorize doctors'}), 403

        data      = request.get_json()
        doctor_id = data.get('doctor_id')

        if not doctor_id:
            return jsonify({'error': 'Doctor ID is required'}), 400

        doctor = users.find_one({"_id": ObjectId(doctor_id), "user_type": "doctor"})
        if not doctor:
            return jsonify({'error': 'Doctor not found'}), 404

        result = users.update_one(
            {"_id": current_user['_id']},
            {"$addToSet": {"authorized_doctors": doctor_id}},
        )

        if result.modified_count > 0 or result.matched_count > 0:
            logger.info(f"Patient {current_user['_id']} authorized doctor {doctor_id}")
            return jsonify({
                'message': 'Doctor authorized successfully',
                'doctor': {
                    'id':        str(doctor['_id']),
                    'firstName': doctor.get('first_name', ''),
                    'lastName':  doctor.get('last_name', ''),
                },
            }), 200

        return jsonify({'error': 'Failed to authorize doctor'}), 500

    except Exception as e:
        logger.error(f"Error authorizing doctor: {str(e)}")
        return jsonify({"error": "Failed to authorize doctor"}), 500


@auth_routes.route('/api/patient/revoke-doctor', methods=['POST'])
@token_required
def revoke_doctor(current_user):
    """Remove a doctor from patient's authorized list."""
    try:
        logger = current_app.logger
        users  = current_app.mongo.db.users

        if current_user.get('user_type') != 'patient':
            return jsonify({'message': 'Only patients can revoke doctor access'}), 403

        data      = request.get_json()
        doctor_id = data.get('doctor_id')

        if not doctor_id:
            return jsonify({'error': 'Doctor ID is required'}), 400

        result = users.update_one(
            {"_id": current_user['_id']},
            {"$pull": {"authorized_doctors": doctor_id}},
        )

        if result.modified_count > 0:
            logger.info(f"Patient {current_user['_id']} revoked access for doctor {doctor_id}")
            return jsonify({'message': 'Doctor access revoked successfully'}), 200

        return jsonify({'message': 'Doctor was not in authorized list'}), 200

    except Exception as e:
        logger.error(f"Error revoking doctor access: {str(e)}")
        return jsonify({"error": "Failed to revoke doctor access"}), 500


@auth_routes.route('/api/auth/forgot-password', methods=['POST'])
def forgot_password():
    """POST /api/auth/forgot-password — request a password-reset code."""
    try:
        logger = current_app.logger
        users  = current_app.mongo.db.users

        data = request.get_json()
        if not data:
            return jsonify({"error": "Missing request data"}), 400

        email = data.get('email', '').strip().lower()
        if not email:
            return jsonify({"error": "Email is required"}), 400

        user = users.find_one({"email": email})

        if user:
            code    = str(random.randint(100000, 999999))
            expires = datetime.now(timezone.utc) + timedelta(minutes=15)
            users.update_one(
                {"_id": user['_id']},
                {"$set": {"reset_code": code, "reset_code_expires": expires}},
            )
            logger.info(f"Password reset code for {email}: {code}")

        return jsonify({"message": "If this email is registered, a reset link has been sent."}), 200

    except Exception as e:
        current_app.logger.error(f"Forgot-password error: {str(e)}")
        return jsonify({"error": "Request failed"}), 500


@auth_routes.route('/api/auth/reset-password', methods=['POST'])
def reset_password():
    """POST /api/auth/reset-password — verify code and set a new password."""
    try:
        logger = current_app.logger
        users  = current_app.mongo.db.users

        data = request.get_json()
        if not data:
            return jsonify({"error": "Missing request data"}), 400

        email        = data.get('email', '').strip().lower()
        code         = data.get('code', '').strip()
        new_password = data.get('new_password', '')

        if not all([email, code, new_password]):
            return jsonify({"error": "email, code, and new_password are required"}), 400

        user = users.find_one({"email": email})
        if not user:
            return jsonify({"error": "Invalid or expired code"}), 400

        stored_code    = user.get('reset_code')
        stored_expires = user.get('reset_code_expires')

        if (
            not stored_code
            or stored_code != code
            or not stored_expires
            or stored_expires < datetime.now(timezone.utc)
        ):
            return jsonify({"error": "Invalid or expired code"}), 400

        users.update_one(
            {"_id": user['_id']},
            {
                "$set":   {"password": generate_password_hash(new_password)},
                "$unset": {"reset_code": "", "reset_code_expires": ""},
            },
        )

        logger.info(f"Password reset successfully for {email}")
        return jsonify({"message": "Password updated successfully"}), 200

    except Exception as e:
        current_app.logger.error(f"Reset-password error: {str(e)}")
        return jsonify({"error": "Request failed"}), 500