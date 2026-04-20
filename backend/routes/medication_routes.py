from datetime import datetime, timezone

from bson.errors import InvalidId
from bson.objectid import ObjectId
from flask import Blueprint, jsonify, current_app, request
from pymongo import ASCENDING, ReturnDocument
from werkzeug.local import LocalProxy

from routes.doctor_routes import check_doctor_patient_access
from utils.auth import token_required
from utils.error_handler import api_error_handler
from utils.fhir_de import build_medication_request


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


def _serialize_datetime(value):
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return value


def _serialize_medication_doc(doc: dict):
    out = dict(doc)
    out["_id"] = str(out.get("_id"))
    out["created_at"] = _serialize_datetime(out.get("created_at"))
    return out


def _serialize_intake_doc(doc: dict):
    out = dict(doc)
    out["_id"] = str(out.get("_id"))
    out["confirmed_at"] = _serialize_datetime(out.get("confirmed_at"))
    return out


def _require_patient_user(current_user):
    if current_user.get("user_type") != "patient":
        return None, (jsonify({"error": "Unauthorized access"}), 403)
    return str(current_user["_id"]), None


def _dosage_label(med: dict):
    return (
        f"{int(med.get('dosage_morning', 0))}-"
        f"{int(med.get('dosage_noon', 0))}-"
        f"{int(med.get('dosage_evening', 0))}-"
        f"{int(med.get('dosage_night', 0))}"
    )


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
@medication_routes.route("/my", methods=["GET"], strict_slashes=False)
@token_required
@api_error_handler
def list_own_medications(current_user):
    patient_id, err_resp = _require_patient_user(current_user)
    if err_resp:
        return err_resp

    docs = list(
        medications_col.find({"patient_id": patient_id, "is_active": True}).sort("trade_name", ASCENDING)
    )

    result = []
    for doc in docs:
        med = _serialize_medication_doc(doc)
        med["dosage_label"] = _dosage_label(doc)
        result.append(med)

    return jsonify(result), 200


@medication_routes.route("/patient/<medication_id>/intake", methods=["POST"])
@medication_routes.route("/intake/", methods=["POST"], strict_slashes=False)
@token_required
@api_error_handler
def confirm_medication_intake(current_user, medication_id=None):
    patient_id, err_resp = _require_patient_user(current_user)
    if err_resp:
        return err_resp

    data = request.get_json() or {}
    status_raw = data.get("status", "taken")
    status = str(status_raw).strip().lower() if status_raw not in (None, "") else "taken"
    if status not in {"pending", "taken", "skipped"}:
        return jsonify({"error": "status must be one of: pending, taken, skipped"}), 400

    note_raw = data.get("note", "")
    note = str(note_raw).strip() if note_raw not in (None, "") else ""
    now_utc = datetime.now(timezone.utc)

    intake_doc = None
    intake_id_raw = data.get("intake_id", "")
    intake_id = str(intake_id_raw).strip() if intake_id_raw not in (None, "") else ""

    if intake_id:
        try:
            intake_obj_id = ObjectId(intake_id)
        except (InvalidId, TypeError):
            return jsonify({"error": "Invalid intake_id"}), 400

        intake_doc = med_intakes_col.find_one({"_id": intake_obj_id, "patient_id": patient_id})
        if not intake_doc:
            return jsonify({"error": "Intake not found"}), 404
    else:
        med_id_raw = medication_id if medication_id not in (None, "") else data.get("medication_id", "")
        effective_medication_id = str(med_id_raw).strip() if med_id_raw not in (None, "") else ""
        if not effective_medication_id:
            return jsonify({"error": "Provide intake_id or medication_id"}), 400

        slot_raw = data.get("slot", "")
        slot = str(slot_raw).strip().lower() if slot_raw not in (None, "") else ""
        if slot not in {"morning", "noon", "evening", "night"}:
            return jsonify({"error": "slot must be one of: morning, noon, evening, night"}), 400

        date_raw = data.get("date", "")
        date_value = (
            str(date_raw).strip()
            if date_raw not in (None, "")
            else datetime.now(timezone.utc).strftime("%Y-%m-%d")
        )
        date_err = _validate_yyyy_mm_dd(date_value, "date")
        if date_err:
            return date_err

        medication = None
        if ObjectId.is_valid(effective_medication_id):
            try:
                medication_obj_id = ObjectId(effective_medication_id)
            except (InvalidId, TypeError):
                medication_obj_id = None
            if medication_obj_id:
                medication = medications_col.find_one(
                    {"_id": medication_obj_id, "patient_id": patient_id}
                )
        if not medication:
            return jsonify({"error": "Medication not found"}), 404

        intake_doc = med_intakes_col.find_one_and_update(
            {
                "patient_id": patient_id,
                "medication_id": effective_medication_id,
                "date": date_value,
                "slot": slot,
            },
            {
                "$setOnInsert": {
                    "status": "pending",
                    "confirmed_at": None,
                    "note": "",
                }
            },
            upsert=True,
            return_document=ReturnDocument.AFTER,
        )

    updates = {
        "status": status,
        "note": note,
        "confirmed_at": now_utc if status in {"taken", "skipped"} else None,
    }
    med_intakes_col.update_one({"_id": intake_doc["_id"], "patient_id": patient_id}, {"$set": updates})
    updated = med_intakes_col.find_one({"_id": intake_doc["_id"], "patient_id": patient_id})
    return jsonify(_serialize_intake_doc(updated)), 200


@medication_routes.route("/patient/intakes", methods=["GET"])
@medication_routes.route("/today", methods=["GET"], strict_slashes=False)
@token_required
@api_error_handler
def list_own_medication_intakes(current_user):
    patient_id, err_resp = _require_patient_user(current_user)
    if err_resp:
        return err_resp

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    meds = list(
        medications_col.find(
            {
                "patient_id": patient_id,
                "is_active": True,
                "start_date": {"$lte": today},
                "$or": [{"is_chronic": True}, {"end_date": {"$gte": today}}],
            }
        ).sort("trade_name", ASCENDING)
    )

    slots = {"morning": [], "noon": [], "evening": [], "night": []}

    for med in meds:
        medication_id = str(med["_id"])
        for slot in ("morning", "noon", "evening", "night"):
            dosage = int(med.get(f"dosage_{slot}", 0) or 0)
            if dosage <= 0:
                continue

            intake = med_intakes_col.find_one_and_update(
                {
                    "medication_id": medication_id,
                    "patient_id": patient_id,
                    "date": today,
                    "slot": slot,
                },
                {
                    "$setOnInsert": {
                        "status": "pending",
                        "confirmed_at": None,
                        "note": "",
                    }
                },
                upsert=True,
                return_document=ReturnDocument.AFTER,
            )

            slots[slot].append(
                {
                    "medication": {
                        "id": medication_id,
                        "trade_name": med.get("trade_name", ""),
                        "active_substance": med.get("active_substance", ""),
                        "dosage_label": _dosage_label(med),
                    },
                    "intake_id": str(intake["_id"]),
                    "status": intake.get("status", "pending"),
                    "dosage": dosage,
                    "unit": med.get("dosage_unit", ""),
                }
            )

    all_items = [item for slot_items in slots.values() for item in slot_items]
    summary = {
        "total": len(all_items),
        "taken": sum(1 for item in all_items if item.get("status") == "taken"),
        "pending": sum(1 for item in all_items if item.get("status") == "pending"),
        "skipped": sum(1 for item in all_items if item.get("status") == "skipped"),
    }

    return jsonify({"date": today, "slots": slots, "summary": summary}), 200


@medication_routes.route("/doctor/patient/<patient_id>/intakes", methods=["GET"])
@token_required
@api_error_handler
def list_patient_medication_intakes(current_user, patient_id):
    return _not_implemented("list_patient_medication_intakes")


@medication_routes.route("/fhir/MedicationRequest/", methods=["GET"], strict_slashes=False)
@token_required
@api_error_handler
def read_fhir_medication_requests(current_user):
    patient_id, err_resp = _require_patient_user(current_user)
    if err_resp:
        return err_resp

    patient_param = str(request.args.get("patient", "") or "").strip()
    if patient_param and patient_param not in {patient_id, f"Patient/{patient_id}"}:
        return jsonify({"error": "patient search parameter does not match authenticated user"}), 403

    status_filter = str(request.args.get("status", "") or "").strip().lower()
    is_active_filter = None
    if status_filter == "active":
        is_active_filter = True
    elif status_filter in {"completed", "stopped"}:
        is_active_filter = False

    query: dict = {"patient_id": patient_id}
    if is_active_filter is not None:
        query["is_active"] = is_active_filter

    medication_docs = list(medications_col.find(query))
    resources = [build_medication_request(dict(doc, patient_id=patient_id)) for doc in medication_docs]

    bundle_entries = [
        {
            "fullUrl": f"urn:uuid:{resource['id']}",
            "resource": resource,
        }
        for resource in resources
    ]
    bundle = {
        "resourceType": "Bundle",
        "type": "searchset",
        "total": len(bundle_entries),
        "entry": bundle_entries,
    }
    return jsonify(bundle), 200
