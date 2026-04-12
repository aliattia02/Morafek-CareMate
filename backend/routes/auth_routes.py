from flask import Blueprint, request, jsonify, current_app
from werkzeug.security import generate_password_hash, check_password_hash
import jwt
import re
import random
from datetime import datetime, timedelta, timezone
from bson.objectid import ObjectId
from utils.auth import token_required, generate_token

auth_routes = Blueprint('auth_routes', __name__)

VALID_USER_TYPES = ['patient', 'doctor', 'admin']

# GKV KVID-10 format: 1 uppercase letter + 9 digits (de.basisprofil.r4 spec)
_GKV_RE   = re.compile(r'^[A-Z]\d{9}$')
# LANR: exactly 9 digits (Kassenärztliche Bundesvereinigung spec)
_LANR_RE  = re.compile(r'^\d{9}$')


# ─── Login ────────────────────────────────────────────────────────────────────

@auth_routes.route('/login', methods=['POST'])
def login():
    try:
        logger = current_app.logger
        users  = current_app.mongo.db.users

        data = request.get_json()
        if not data:
            return jsonify({"error": "Missing request data"}), 400

        username  = data.get('username')
        password  = data.get('password')
        user_type = data.get('user_type')

        if not all([username, password, user_type]):
            return jsonify({"error": "Missing required fields"}), 400

        if user_type not in VALID_USER_TYPES:
            return jsonify({"error": f"Invalid user type. Must be one of: {', '.join(VALID_USER_TYPES)}"}), 400

        user = users.find_one({"username": username, "user_type": user_type})

        if user and check_password_hash(user['password'], password):
            token = generate_token(str(user['_id']), user['user_type'])
            return jsonify({
                "message":              "Logged in successfully",
                "token":                token,
                "user_type":            user['user_type'],
                "firstName":            user.get('first_name', ''),
                "lastName":             user.get('last_name', ''),
                "profile_picture_url":  user.get('profile_picture_url', ''),
                "shared_constants":     {},
            }), 200

        return jsonify({"error": "Invalid credentials"}), 401

    except Exception as e:
        current_app.logger.error(f"Login error: {str(e)}")
        return jsonify({"error": "Login failed", "details": str(e)}), 500


# ─── Register ─────────────────────────────────────────────────────────────────

@auth_routes.route('/register', methods=['POST'])
def register():
    """POST /register — create a new user account.

    Changes vs. previous version
    ─────────────────────────────
    • Doctors may optionally supply `lanr` (9-digit Lebenslange Arztnummer).
      When provided, it is validated against the LANR format and stored in
      the user document so it can appear in FHIR Practitioner resources.
    • Patients may optionally supply `gkv_kvid` (GKV Versichertennummer).
      When provided, it is validated and stored in patient_fhir_identifiers
      so GET /fhir/Patient/{id} can include the GKV identifier immediately.
    • All existing required fields and behavior are unchanged.
    """
    try:
        logger = current_app.logger
        users  = current_app.mongo.db.users

        data = request.get_json()
        if not data:
            return jsonify({"error": "Missing request data"}), 400

        required_fields = ['username', 'email', 'password', 'firstName',
                           'lastName', 'dateOfBirth', 'user_type']
        for field in required_fields:
            if field not in data:
                return jsonify({"error": f"Missing required field: {field}"}), 400

        if data['user_type'] not in VALID_USER_TYPES:
            return jsonify({"error": f"Invalid user type. Must be one of: {', '.join(VALID_USER_TYPES)}"}), 400

        if users.find_one({"username": data['username']}):
            return jsonify({"error": "Username already exists"}), 400

        if users.find_one({"email": data['email']}):
            return jsonify({"error": "Email already exists"}), 400

        # ── Optional German identifiers ───────────────────────────────────────
        lanr    = (data.get('lanr',     '') or '').strip()
        gkv_raw = (data.get('gkv_kvid', '') or '').strip().upper()

        if lanr and not _LANR_RE.match(lanr):
            return jsonify({
                "error": "Ungültige LANR. Format: 9 Ziffern (z.B. 123456789)"
            }), 400

        if gkv_raw and not _GKV_RE.match(gkv_raw):
            return jsonify({
                "error": "Ungültige GKV-Versichertennummer. Format: 1 Buchstabe + 9 Ziffern (z.B. A123456789)"
            }), 400

        # ── Assemble user document ────────────────────────────────────────────
        user_data = {
            'username':      data['username'],
            'email':         data['email'],
            'password':      generate_password_hash(data['password']),
            'first_name':    data['firstName'],
            'last_name':     data['lastName'],
            'date_of_birth': data['dateOfBirth'],
            'user_type':     data['user_type'],
            'created_at':    datetime.now(timezone.utc),
        }

        if data['user_type'] == 'patient':
            user_data['authorized_doctors'] = []
            user_data['ehr_profile'] = {
                'blood_type':         '',
                'allergies':          [],
                'chronic_conditions': [],
                'emergency_contact':  '',
            }

        if data['user_type'] == 'doctor':
            user_data['clinic_ids'] = []
            # Store LANR directly on the user document for FHIR Practitioner use
            if lanr:
                user_data['lanr'] = lanr

        user_id     = users.insert_one(user_data).inserted_id
        user_id_str = str(user_id)

        # ── Store GKV identifier for patients ─────────────────────────────────
        # Stored in a separate collection (patient_fhir_identifiers) rather
        # than on the user document so it can grow to include address, phone,
        # PKV number, etc. without touching the core user schema.
        if data['user_type'] == 'patient' and gkv_raw:
            current_app.mongo.db.patient_fhir_identifiers.update_one(
                {"patient_id": user_id_str},
                {"$set": {"patient_id": user_id_str, "gkv_kvid": gkv_raw}},
                upsert=True,
            )
            logger.info(f"GKV identifier stored for new patient {user_id_str}")

        logger.info(f"User registered: {user_id_str}")
        return jsonify({
            "message": "User registered successfully",
            "id":      user_id_str,
        }), 201

    except Exception as e:
        current_app.logger.error(f"Registration error: {str(e)}")
        return jsonify({"error": "Registration failed", "details": str(e)}), 500


# ─── Doctors listing (unchanged) ─────────────────────────────────────────────

@auth_routes.route('/api/doctors', methods=['GET'])
@token_required
def get_available_doctors(current_user):
    """GET /api/doctors — doctors visible to the current patient.

    Changes vs. previous version
    ─────────────────────────────
    • Doctor records now include `lanr` if stored, so the frontend can
      display the doctor's professional identifier.
    """
    try:
        logger  = current_app.logger
        users   = current_app.mongo.db.users
        clinics = current_app.mongo.db.clinics

        if current_user.get('user_type') != 'patient':
            return jsonify({'message': 'Only patients can view available doctors'}), 403

        clinic_id = request.args.get('clinic_id', '').strip()

        if clinic_id:
            try:
                clinic = clinics.find_one({"_id": ObjectId(clinic_id)})
            except Exception:
                return jsonify({"error": "Invalid clinic_id format"}), 400
            if not clinic:
                return jsonify({"error": "Clinic not found"}), 404

            doctor_ids_in_clinic = clinic.get("doctors", [])
            if not doctor_ids_in_clinic:
                return jsonify([]), 200

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
                'id':         str(doctor['_id']),
                'firstName':  doctor.get('first_name', ''),
                'lastName':   doctor.get('last_name', ''),
                'email':      doctor.get('email', ''),
                'clinic_ids': doctor.get('clinic_ids', []),
                # German professional identifier — present if doctor supplied
                # it at registration or via a future profile update endpoint.
                'lanr':       doctor.get('lanr', ''),
            }
            doctor_list.append(doctor_data)

        return jsonify(doctor_list), 200

    except Exception as e:
        current_app.logger.error(f"Error fetching doctors: {str(e)}")
        return jsonify({"error": "Failed to fetch doctors"}), 500


# ─── Authorized doctors (unchanged) ──────────────────────────────────────────

@auth_routes.route('/api/patient/authorized-doctors', methods=['GET'])
@token_required
def get_authorized_doctors(current_user):
    """Get list of doctors authorized by the current patient."""
    try:
        logger = current_app.logger
        users  = current_app.mongo.db.users

        if current_user.get('user_type') != 'patient':
            return jsonify({'message': 'Only patients can view authorized doctors'}), 403

        patient = users.find_one(
            {"_id": current_user['_id']},
            {"authorized_doctors": 1}
        )
        if not patient:
            return jsonify({'error': 'Patient not found'}), 404

        authorized_ids  = patient.get('authorized_doctors', [])
        authorized_list = []

        for doctor_id in authorized_ids:
            try:
                doctor = users.find_one(
                    {"_id": ObjectId(doctor_id), "user_type": "doctor"},
                    {"password": 0}
                )
                if doctor:
                    authorized_list.append({
                        'id':         str(doctor['_id']),
                        'firstName':  doctor.get('first_name', ''),
                        'lastName':   doctor.get('last_name', ''),
                        'email':      doctor.get('email', ''),
                        'lanr':       doctor.get('lanr', ''),
                    })
            except Exception:
                continue

        return jsonify(authorized_list), 200

    except Exception as e:
        current_app.logger.error(f"Error fetching authorized doctors: {str(e)}")
        return jsonify({"error": "Failed to fetch authorized doctors"}), 500


# ─── Authorize / revoke doctor (unchanged) ────────────────────────────────────

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

        doctor = users.find_one(
            {"_id": ObjectId(doctor_id), "user_type": "doctor"},
            {"password": 0}
        )
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
        current_app.logger.error(f"Error authorizing doctor: {str(e)}")
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
        current_app.logger.error(f"Error revoking doctor access: {str(e)}")
        return jsonify({"error": "Failed to revoke doctor access"}), 500


# ─── Forgot / reset password (unchanged) ─────────────────────────────────────

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


# ─── DSGVO Art. 17 — Right to Erasure ────────────────────────────────────────

@auth_routes.route('/api/auth/delete-account', methods=['DELETE'])
@token_required
def delete_account(current_user):
    """DELETE /api/auth/delete-account — DSGVO Art. 17 Right to Erasure.

    Changes vs. previous version
    ─────────────────────────────
    • Patient deletion now also wipes `patient_fhir_identifiers` — the
      collection that stores GKV Versichertennummer, address, and phone.
      Previously this collection was NOT cleaned up, which was a DSGVO
      violation: personal health-system identifiers (GKV number) would
      survive account deletion.
    • The EHR collections are now listed explicitly and include
      `patient_fhir_identifiers` and the correct collection names
      (`ehr_vitals`, `ehr_visits`, `ehr_conditions`, `ehr_documents`)
      rather than the generic names that did not match actual collection
      names (`vitals`, `visits`, `documents`, `exercises`).
    """
    try:
        logger = current_app.logger
        db     = current_app.mongo.db

        data = request.get_json()
        if not data or not data.get('password'):
            return jsonify({"error": "Password confirmation is required"}), 400

        user = db.users.find_one({"_id": current_user['_id']})
        if not user or not check_password_hash(user['password'], data['password']):
            logger.warning(f"delete-account: wrong password for user {current_user['_id']}")
            return jsonify({"error": "Incorrect password"}), 401

        user_id     = current_user['_id']
        user_id_str = str(user_id)
        user_type   = user.get('user_type', '')
        deleted     = {}

        # ── Patient: wipe all personal clinical data ──────────────────────────
        if user_type == 'patient':
            # EHR clinical collections (actual collection names used by ehr_routes.py)
            ehr_collections = [
                'ehr_vitals',
                'ehr_visits',
                'ehr_conditions',
                'ehr_documents',
                'ehr_messages',
                'ehr_exercises',
                'patient_profiles',
                # FHIR identity data — GKV number, address, phone.
                # DSGVO Art. 17 explicitly covers health-system identifiers.
                'patient_fhir_identifiers',
            ]
            for col_name in ehr_collections:
                res = db[col_name].delete_many({"patient_id": user_id_str})
                if res.deleted_count:
                    deleted[col_name] = res.deleted_count

            # Remove from every doctor's authorized list
            db.users.update_many(
                {"authorized_doctors": user_id_str},
                {"$pull": {"authorized_doctors": user_id_str}},
            )
            deleted['doctor_authorizations_removed'] = True

        # ── Doctor: remove from clinics and patient authorized lists ──────────
        if user_type == 'doctor':
            db.clinics.update_many(
                {"doctors": user_id_str},
                {"$pull": {"doctors": user_id_str}},
            )
            db.users.update_many(
                {"authorized_doctors": user_id_str},
                {"$pull": {"authorized_doctors": user_id_str}},
            )
            deleted['clinic_memberships_removed'] = True
            deleted['patient_authorizations_removed'] = True

        # ── Delete user document ──────────────────────────────────────────────
        db.users.delete_one({"_id": user_id})
        deleted['user'] = 1

        logger.info(
            f"DSGVO Art.17 erasure complete | user={user_id_str} "
            f"type={user_type} | {deleted}"
        )

        return jsonify({
            "message": "Your account and all personal data have been permanently deleted.",
            "deleted": deleted,
        }), 200

    except Exception as e:
        current_app.logger.error(f"delete-account error: {str(e)}")
        return jsonify({"error": "Account deletion failed. Please try again."}), 500