from datetime import datetime, timezone

from bson.errors import InvalidId
from bson.objectid import ObjectId
from flask import Blueprint, jsonify, current_app, request
from pymongo import ASCENDING
from werkzeug.local import LocalProxy

from routes.doctor_routes import check_doctor_patient_access
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
                "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            }
        ),
        501,
    )


def _parse_required_string(data: dict, field: str):
    value = data.get(field)
    if value is None or str(value).strip() == "":
        return None
    return str(value).strip()


def _parse_required_bool(data: dict, field: str):
    value = data.get(field)
    if not isinstance(value, bool):
        return None
    return value


def _parse_required_int(data: dict, field: str):
    if field not in data:
        return None
    try:
        value = int(data.get(field))
    except (TypeError, ValueError):
        return None
    if value < 0:
        return None
    return value


def _validate_yyyy_mm_dd(value: str, field: str):
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except (ValueError, TypeError):
        return jsonify({"error": f"Invalid {field} format. Use YYYY-MM-DD"}), 400
    return None


@medication_routes.route("/patient/", methods=["POST"], strict_slashes=False)
@token_required
@api_error_handler
def create_medication(current_user):
    if current_user.get("user_type") != "doctor":
        return jsonify({"message": "Unauthorized access"}), 403

    data = request.get_json()
    if not data:
        return jsonify({"error": "Missing request body"}), 400

    patient_id = _parse_required_string(data, "patient_id")
    if patient_id is None:
        return jsonify({"error": "Missing required field: patient_id"}), 400

    try:
        ObjectId(patient_id)
    except (InvalidId, TypeError):
        return jsonify({"error": "Invalid patient_id"}), 400

    has_access, err, code = check_doctor_patient_access(current_user, patient_id)
    if not has_access:
        if isinstance(err, dict):
            return jsonify(err), code
        if isinstance(err, str):
            return jsonify({"message": err}), code
        return jsonify({"message": "Unauthorized access"}), (code or 403)

    pzn = _parse_required_string(data, "pzn")
    if pzn is None:
        return jsonify({"error": "Missing required field: pzn"}), 400
    if not (len(pzn) == 8 and pzn.isdigit()):
        return jsonify({"error": "pzn must be an 8-digit string"}), 400

    trade_name = _parse_required_string(data, "trade_name")
    if trade_name is None:
        return jsonify({"error": "Missing required field: trade_name"}), 400
    active_substance = _parse_required_string(data, "active_substance")
    if active_substance is None:
        return jsonify({"error": "Missing required field: active_substance"}), 400
    form = _parse_required_string(data, "form")
    if form is None:
        return jsonify({"error": "Missing required field: form"}), 400
    strength = _parse_required_string(data, "strength")
    if strength is None:
        return jsonify({"error": "Missing required field: strength"}), 400
    norm_size = _parse_required_string(data, "norm_size")
    if norm_size is None:
        return jsonify({"error": "Missing required field: norm_size"}), 400
    if norm_size not in {"N1", "N2", "N3"}:
        return jsonify({"error": "norm_size must be one of: N1, N2, N3"}), 400

    aut_idem = _parse_required_bool(data, "aut_idem")
    if aut_idem is None:
        return jsonify({"error": "aut_idem must be boolean"}), 400
    coverage = _parse_required_string(data, "coverage")
    if coverage is None:
        return jsonify({"error": "Missing required field: coverage"}), 400
    if coverage not in {"GKV", "PKV", "Selbstzahler"}:
        return jsonify({"error": "coverage must be one of: GKV, PKV, Selbstzahler"}), 400

    is_chronic = _parse_required_bool(data, "is_chronic")
    if is_chronic is None:
        return jsonify({"error": "is_chronic must be boolean"}), 400
    start_date = _parse_required_string(data, "start_date")
    if start_date is None:
        return jsonify({"error": "Missing required field: start_date"}), 400
    date_err = _validate_yyyy_mm_dd(start_date, "start_date")
    if date_err:
        return date_err

    end_date_raw = data.get("end_date")
    end_date = str(end_date_raw).strip() if end_date_raw not in (None, "") else None
    if end_date:
        if is_chronic:
            return jsonify({"error": "end_date must be null when is_chronic is true"}), 400
        date_err = _validate_yyyy_mm_dd(end_date, "end_date")
        if date_err:
            return date_err
    elif not is_chronic:
        return jsonify({"error": "end_date is required when is_chronic is false"}), 400

    dosage_morning = _parse_required_int(data, "dosage_morning")
    if dosage_morning is None:
        return jsonify({"error": "dosage_morning must be an integer >= 0"}), 400
    dosage_noon = _parse_required_int(data, "dosage_noon")
    if dosage_noon is None:
        return jsonify({"error": "dosage_noon must be an integer >= 0"}), 400
    dosage_evening = _parse_required_int(data, "dosage_evening")
    if dosage_evening is None:
        return jsonify({"error": "dosage_evening must be an integer >= 0"}), 400
    dosage_night = _parse_required_int(data, "dosage_night")
    if dosage_night is None:
        return jsonify({"error": "dosage_night must be an integer >= 0"}), 400

    dosage_unit = _parse_required_string(data, "dosage_unit")
    if dosage_unit is None:
        return jsonify({"error": "Missing required field: dosage_unit"}), 400
    if dosage_unit not in {"Tablette", "ml", "IE", "Hub", "Tropfen"}:
        return jsonify({"error": "dosage_unit must be one of: Tablette, ml, IE, Hub, Tropfen"}), 400

    duration_days = data.get("duration_days")
    if duration_days is not None:
        try:
            duration_days = int(duration_days)
        except (TypeError, ValueError):
            return jsonify({"error": "duration_days must be an integer or null"}), 400
        if duration_days < 0:
            return jsonify({"error": "duration_days must be >= 0"}), 400

    visit_id_raw = data.get("visit_id")
    visit_id = str(visit_id_raw).strip() if visit_id_raw not in (None, "") else None
    if visit_id:
        try:
            ObjectId(visit_id)
        except (InvalidId, TypeError):
            return jsonify({"error": "Invalid visit_id"}), 400
        visit = current_app.mongo.db.ehr_visits.find_one({"_id": ObjectId(visit_id), "patient_id": patient_id})
        if not visit:
            return jsonify({"error": "Visit not found for patient"}), 404
        if visit.get("doctor_id") and visit.get("doctor_id") != str(current_user["_id"]):
            return jsonify({"error": "Unauthorized visit reference"}), 403

    doc = {
        "patient_id": patient_id,
        "doctor_id": str(current_user["_id"]),
        "visit_id": visit_id,
        "pzn": pzn,
        "trade_name": trade_name,
        "active_substance": active_substance,
        "form": form,
        "strength": strength,
        "norm_size": norm_size,
        "aut_idem": aut_idem,
        "coverage": coverage,
        "is_chronic": is_chronic,
        "start_date": start_date,
        "end_date": end_date,
        "duration_days": duration_days,
        "dosage_morning": dosage_morning,
        "dosage_noon": dosage_noon,
        "dosage_evening": dosage_evening,
        "dosage_night": dosage_night,
        "dosage_unit": dosage_unit,
        "dosage_note": str(data.get("dosage_note", "")).strip(),
        "is_active": bool(data.get("is_active", True)),
        "created_at": datetime.now(timezone.utc),
    }

    result = medications_col.insert_one(doc)

    response_doc = dict(doc)
    response_doc["_id"] = str(result.inserted_id)
    response_doc["created_at"] = doc["created_at"].isoformat().replace("+00:00", "Z")
    return jsonify(response_doc), 201


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
