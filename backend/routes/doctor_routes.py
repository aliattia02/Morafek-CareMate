from flask import Blueprint, jsonify
from bson.objectid import ObjectId
from utils.auth import token_required
from utils.error_handler import api_error_handler
from config import mongo
import logging

logger = logging.getLogger(__name__)
doctor_routes = Blueprint('doctor_routes', __name__)


def check_doctor_patient_access(current_user, patient_id):
    """Check if the current user has access to the patient's data.
    Returns (has_access, error_response, status_code).
    Unchanged from previous version.
    """
    user_type = current_user.get('user_type')

    if user_type == 'admin':
        return True, None, None

    if user_type != 'doctor':
        return False, {'message': 'Unauthorized access'}, 403

    doctor_id = str(current_user['_id'])
    patient   = mongo.db.users.find_one({"_id": ObjectId(patient_id)})

    if not patient:
        return False, {'message': 'Patient not found'}, 404

    if doctor_id not in patient.get('authorized_doctors', []):
        return False, {'message': 'You are not authorized to view this patient\'s data'}, 403

    return True, None, None


@doctor_routes.route('/api/doctor/patients', methods=['GET'])
@token_required
@api_error_handler
def get_doctor_patients(current_user):
    """GET /api/doctor/patients — list patients the doctor can access.

    Changes vs. previous version
    ─────────────────────────────
    • Each patient record now includes a `fhir_identifiers` block with:
        - `gkv_kvid_stored` (bool) — whether the patient has entered their
          GKV number. Lets the doctor's UI indicate data completeness.
        - `gkv_kvid_masked` — first 4 chars + bullets, e.g. "A123••••••".
          Sufficient for confirmation without exposing the full number.
    • `active_conditions` and `active_medications` fields are unchanged.
    • Doctor's own LANR is available via the token's user document if needed.
    """
    user_type = current_user.get('user_type')

    if user_type not in ['doctor', 'admin']:
        return jsonify({'message': 'Unauthorized access'}), 403

    doctor_id = str(current_user['_id'])

    query = (
        {"user_type": "patient"}
        if user_type == 'admin'
        else {"user_type": "patient", "authorized_doctors": doctor_id}
    )

    patients = list(mongo.db.users.find(query, {"password": 0}))

    # Pre-fetch FHIR identifier docs for all patients in one query (avoid N+1)
    patient_ids = [str(p['_id']) for p in patients]
    id_docs_raw = list(
        mongo.db.patient_fhir_identifiers.find(
            {"patient_id": {"$in": patient_ids}}
        )
    )
    id_docs_by_patient = {d['patient_id']: d for d in id_docs_raw}

    patient_list = []
    for patient in patients:
        pid    = str(patient['_id'])
        id_doc = id_docs_by_patient.get(pid, {})
        gkv    = id_doc.get('gkv_kvid', '')

        try:
            patient_list.append({
                'id':               pid,
                'firstName':        patient.get('first_name', ''),
                'lastName':         patient.get('last_name', ''),
                'email':            patient.get('email', ''),
                'activeConditions': patient.get('active_conditions', []),
                'activeMedications': patient.get('active_medications', []),
                # German FHIR identifier summary — helps the doctor's UI
                # signal whether the patient's record is complete.
                'fhir_identifiers': {
                    'gkv_kvid_stored': bool(gkv),
                    'gkv_kvid_masked': (gkv[:4] + '••••••') if len(gkv) >= 4 else '',
                },
            })
        except Exception as e:
            logger.error(f"Error processing patient {pid}: {str(e)}")
            continue

    return jsonify(patient_list), 200