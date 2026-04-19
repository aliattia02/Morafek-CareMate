from datetime import datetime

from flask import Blueprint, jsonify, current_app
from pymongo import ASCENDING
from werkzeug.local import LocalProxy

from utils.auth import token_required
from utils.error_handler import api_error_handler


medication_routes = Blueprint("medication_routes", __name__)

# MongoDB collection references (resolved from current_app.mongo / PyMongo)
medications_col = LocalProxy(lambda: current_app.mongo.db.medications)
med_schedules_col = LocalProxy(lambda: current_app.mongo.db.med_schedules)
med_intakes_col = LocalProxy(lambda: current_app.mongo.db.med_intakes)


# Logical schema definitions (MongoDB is schemaless; these are module contracts)
MEDICATIONS_SCHEMA = {
    "_id": "ObjectId (auto)",
    "patient_id": "str",
    "doctor_id": "str",
    "visit_id": "str | None",
    "pzn": "str",
    "trade_name": "str",
    "active_substance": "str",
    "form": "str",
    "strength": "str",
    "norm_size": "str (N1|N2|N3)",
    "aut_idem": "bool",
    "coverage": "str (GKV|PKV|Selbstzahler)",
    "is_chronic": "bool",
    "start_date": "str (YYYY-MM-DD)",
    "end_date": "str | None (YYYY-MM-DD)",
    "duration_days": "int | None",
    "dosage_morning": "int",
    "dosage_noon": "int",
    "dosage_evening": "int",
    "dosage_night": "int",
    "dosage_unit": "str (Tablette|ml|IE|Hub|Tropfen)",
    "dosage_note": "str",
    "is_active": "bool",
    "created_at": "datetime",
}

MED_SCHEDULES_SCHEMA = {
    "_id": "ObjectId (auto)",
    "medication_id": "str",
    "patient_id": "str",
    "date": "str (YYYY-MM-DD)",
    "slots_generated": "bool",
}

MED_INTAKES_SCHEMA = {
    "_id": "ObjectId (auto)",
    "medication_id": "str",
    "patient_id": "str",
    "date": "str (YYYY-MM-DD)",
    "slot": "str (morning|noon|evening|night)",
    "status": "str (pending|taken|skipped)",
    "confirmed_at": "datetime | None",
    "note": "str",
}


def ensure_medication_indexes():
    """
    Startup indexes for medication module.
    Called by backend/main.py during app startup.
    """
    medications_col.create_index([("patient_id", ASCENDING)], name="idx_medications_patient_id")
    medications_col.create_index([("doctor_id", ASCENDING)], name="idx_medications_doctor_id")
    medications_col.create_index([("visit_id", ASCENDING)], name="idx_medications_visit_id")
    med_intakes_col.create_index(
        [("patient_id", ASCENDING), ("date", ASCENDING)],
        name="idx_med_intakes_patient_date",
    )
    med_intakes_col.create_index([("medication_id", ASCENDING)], name="idx_med_intakes_medication_id")


def _not_implemented(route_name: str):
    return (
        jsonify(
            {
                "error": "Not Implemented",
                "route": route_name,
                "timestamp": datetime.utcnow().isoformat() + "Z",
            }
        ),
        501,
    )


@medication_routes.route("/doctor/patient/<patient_id>", methods=["POST"])
@token_required
@api_error_handler
def create_medication(current_user, patient_id):
    return _not_implemented("create_medication")


@medication_routes.route("/doctor/patient/<patient_id>", methods=["GET"])
@token_required
@api_error_handler
def list_patient_medications(current_user, patient_id):
    return _not_implemented("list_patient_medications")


@medication_routes.route("/doctor/patient/<patient_id>/<medication_id>", methods=["PUT"])
@token_required
@api_error_handler
def update_medication(current_user, patient_id, medication_id):
    return _not_implemented("update_medication")


@medication_routes.route("/doctor/patient/<patient_id>/<medication_id>", methods=["DELETE"])
@token_required
@api_error_handler
def deactivate_medication(current_user, patient_id, medication_id):
    return _not_implemented("deactivate_medication")


@medication_routes.route("/patient", methods=["GET"])
@token_required
@api_error_handler
def list_own_medications(current_user):
    return _not_implemented("list_own_medications")


@medication_routes.route("/patient/<medication_id>/intake", methods=["POST"])
@token_required
@api_error_handler
def confirm_medication_intake(current_user, medication_id):
    return _not_implemented("confirm_medication_intake")


@medication_routes.route("/patient/intakes", methods=["GET"])
@token_required
@api_error_handler
def list_own_medication_intakes(current_user):
    return _not_implemented("list_own_medication_intakes")


@medication_routes.route("/doctor/patient/<patient_id>/intakes", methods=["GET"])
@token_required
@api_error_handler
def list_patient_medication_intakes(current_user, patient_id):
    return _not_implemented("list_patient_medication_intakes")
