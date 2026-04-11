"""
clinic_routes.py
----------------
Endpoints for clinic management and doctor membership.

Collections used
~~~~~~~~~~~~~~~~
- clinics   : { name, address, phone, description, created_by, created_at,
                doctors: [doctor_id_str, ...] }
- users     : doctors get a   clinic_ids: [clinic_id_str, ...]   field

Access rules
~~~~~~~~~~~~
- Any authenticated user  : read clinics / list doctors in a clinic
- Doctor or Admin         : create a clinic
- Clinic creator or Admin : update / delete a clinic
- Doctor only             : join / leave a clinic
"""

from datetime import datetime, timezone

from bson.objectid import ObjectId
from flask import Blueprint, current_app, jsonify, request

from config import mongo
from utils.auth import token_required
from utils.error_handler import api_error_handler

clinic_routes = Blueprint("clinic_routes", __name__)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _serialize_clinic(doc: dict, include_doctors: bool = False) -> dict:
    """Convert a MongoDB clinic document to a JSON-safe dict."""
    out = {
        "id":          str(doc["_id"]),
        "name":        doc.get("name", ""),
        "address":     doc.get("address", ""),
        "phone":       doc.get("phone", ""),
        "description": doc.get("description", ""),
        "created_by":  doc.get("created_by", ""),
        "created_at":  doc.get("created_at", "").isoformat()
                       if isinstance(doc.get("created_at"), datetime) else "",
        "doctor_count": len(doc.get("doctors", [])),
    }
    if include_doctors:
        out["doctor_ids"] = doc.get("doctors", [])
    return out


def _serialize_doctor(user: dict) -> dict:
    return {
        "id":        str(user["_id"]),
        "firstName": user.get("first_name", ""),
        "lastName":  user.get("last_name", ""),
        "email":     user.get("email", ""),
    }


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/clinics  — list all clinics
# ─────────────────────────────────────────────────────────────────────────────

@clinic_routes.route("/api/clinics", methods=["GET"])
@token_required
@api_error_handler
def list_clinics(current_user):
    """Return all clinics, sorted by name."""
    clinics = list(mongo.db.clinics.find({}).sort("name", 1))
    return jsonify([_serialize_clinic(c) for c in clinics]), 200


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/clinics  — create a clinic  (doctor or admin)
# ─────────────────────────────────────────────────────────────────────────────

@clinic_routes.route("/api/clinics", methods=["POST"])
@token_required
@api_error_handler
def create_clinic(current_user):
    user_type = current_user.get("user_type")
    if user_type not in ("doctor", "admin"):
        return jsonify({"error": "Only doctors or admins can create clinics"}), 403

    data = request.get_json() or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Clinic name is required"}), 400

    # Prevent duplicate names (case-insensitive)
    if mongo.db.clinics.find_one({"name": {"$regex": f"^{name}$", "$options": "i"}}):
        return jsonify({"error": "A clinic with that name already exists"}), 409

    doc = {
        "name":        name,
        "address":     (data.get("address") or "").strip(),
        "phone":       (data.get("phone") or "").strip(),
        "description": (data.get("description") or "").strip(),
        "created_by":  str(current_user["_id"]),
        "created_at":  datetime.now(timezone.utc),
        "doctors":     [],
    }

    # If a doctor creates the clinic, auto-add them as the first member
    if user_type == "doctor":
        doctor_id = str(current_user["_id"])
        doc["doctors"].append(doctor_id)

    clinic_id = mongo.db.clinics.insert_one(doc).inserted_id

    # Keep doctor's clinic_ids in sync
    if user_type == "doctor":
        mongo.db.users.update_one(
            {"_id": current_user["_id"]},
            {"$addToSet": {"clinic_ids": str(clinic_id)}},
        )

    created = mongo.db.clinics.find_one({"_id": clinic_id})
    return jsonify(_serialize_clinic(created)), 201


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/clinics/<clinic_id>  — clinic detail + doctors
# ─────────────────────────────────────────────────────────────────────────────

@clinic_routes.route("/api/clinics/<clinic_id>", methods=["GET"])
@token_required
@api_error_handler
def get_clinic(current_user, clinic_id):
    clinic = mongo.db.clinics.find_one({"_id": ObjectId(clinic_id)})
    if not clinic:
        return jsonify({"error": "Clinic not found"}), 404

    serialized = _serialize_clinic(clinic, include_doctors=True)

    # Hydrate doctor details
    doctor_ids = clinic.get("doctors", [])
    doctors = []
    for did in doctor_ids:
        try:
            user = mongo.db.users.find_one(
                {"_id": ObjectId(did), "user_type": "doctor"},
                {"password": 0},
            )
            if user:
                doctors.append(_serialize_doctor(user))
        except Exception:
            continue

    serialized["doctors"] = doctors
    return jsonify(serialized), 200


# ─────────────────────────────────────────────────────────────────────────────
# PUT /api/clinics/<clinic_id>  — update clinic  (creator or admin)
# ─────────────────────────────────────────────────────────────────────────────

@clinic_routes.route("/api/clinics/<clinic_id>", methods=["PUT"])
@token_required
@api_error_handler
def update_clinic(current_user, clinic_id):
    clinic = mongo.db.clinics.find_one({"_id": ObjectId(clinic_id)})
    if not clinic:
        return jsonify({"error": "Clinic not found"}), 404

    user_type  = current_user.get("user_type")
    is_creator = clinic.get("created_by") == str(current_user["_id"])
    if user_type != "admin" and not is_creator:
        return jsonify({"error": "Only the clinic creator or an admin can update this clinic"}), 403

    data = request.get_json() or {}
    updates: dict = {}

    if "name" in data:
        name = data["name"].strip()
        if not name:
            return jsonify({"error": "Clinic name cannot be empty"}), 400
        # Duplicate check (excluding current doc)
        conflict = mongo.db.clinics.find_one(
            {"name": {"$regex": f"^{name}$", "$options": "i"},
             "_id":  {"$ne": ObjectId(clinic_id)}}
        )
        if conflict:
            return jsonify({"error": "Another clinic already has that name"}), 409
        updates["name"] = name

    for field in ("address", "phone", "description"):
        if field in data:
            updates[field] = (data[field] or "").strip()

    if not updates:
        return jsonify({"error": "No valid fields provided for update"}), 400

    mongo.db.clinics.update_one({"_id": ObjectId(clinic_id)}, {"$set": updates})
    updated = mongo.db.clinics.find_one({"_id": ObjectId(clinic_id)})
    return jsonify(_serialize_clinic(updated)), 200


# ─────────────────────────────────────────────────────────────────────────────
# DELETE /api/clinics/<clinic_id>  — admin only
# ─────────────────────────────────────────────────────────────────────────────

@clinic_routes.route("/api/clinics/<clinic_id>", methods=["DELETE"])
@token_required
@api_error_handler
def delete_clinic(current_user, clinic_id):
    if current_user.get("user_type") != "admin":
        return jsonify({"error": "Only admins can delete clinics"}), 403

    clinic = mongo.db.clinics.find_one({"_id": ObjectId(clinic_id)})
    if not clinic:
        return jsonify({"error": "Clinic not found"}), 404

    # Remove clinic reference from all member doctors
    for did in clinic.get("doctors", []):
        try:
            mongo.db.users.update_one(
                {"_id": ObjectId(did)},
                {"$pull": {"clinic_ids": clinic_id}},
            )
        except Exception:
            continue

    mongo.db.clinics.delete_one({"_id": ObjectId(clinic_id)})
    return jsonify({"message": "Clinic deleted successfully"}), 200


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/clinics/<clinic_id>/join  — doctor joins clinic
# ─────────────────────────────────────────────────────────────────────────────

@clinic_routes.route("/api/clinics/<clinic_id>/join", methods=["POST"])
@token_required
@api_error_handler
def join_clinic(current_user, clinic_id):
    if current_user.get("user_type") != "doctor":
        return jsonify({"error": "Only doctors can join clinics"}), 403

    clinic = mongo.db.clinics.find_one({"_id": ObjectId(clinic_id)})
    if not clinic:
        return jsonify({"error": "Clinic not found"}), 404

    doctor_id = str(current_user["_id"])

    mongo.db.clinics.update_one(
        {"_id": ObjectId(clinic_id)},
        {"$addToSet": {"doctors": doctor_id}},
    )
    mongo.db.users.update_one(
        {"_id": current_user["_id"]},
        {"$addToSet": {"clinic_ids": clinic_id}},
    )
    return jsonify({"message": "Joined clinic successfully"}), 200


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/clinics/<clinic_id>/leave  — doctor leaves clinic
# ─────────────────────────────────────────────────────────────────────────────

@clinic_routes.route("/api/clinics/<clinic_id>/leave", methods=["POST"])
@token_required
@api_error_handler
def leave_clinic(current_user, clinic_id):
    if current_user.get("user_type") != "doctor":
        return jsonify({"error": "Only doctors can leave clinics"}), 403

    clinic = mongo.db.clinics.find_one({"_id": ObjectId(clinic_id)})
    if not clinic:
        return jsonify({"error": "Clinic not found"}), 404

    doctor_id = str(current_user["_id"])

    mongo.db.clinics.update_one(
        {"_id": ObjectId(clinic_id)},
        {"$pull": {"doctors": doctor_id}},
    )
    mongo.db.users.update_one(
        {"_id": current_user["_id"]},
        {"$pull": {"clinic_ids": clinic_id}},
    )
    return jsonify({"message": "Left clinic successfully"}), 200


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/clinics/<clinic_id>/doctors  — doctors in a specific clinic
# ─────────────────────────────────────────────────────────────────────────────

@clinic_routes.route("/api/clinics/<clinic_id>/doctors", methods=["GET"])
@token_required
@api_error_handler
def get_clinic_doctors(current_user, clinic_id):
    clinic = mongo.db.clinics.find_one({"_id": ObjectId(clinic_id)})
    if not clinic:
        return jsonify({"error": "Clinic not found"}), 404

    doctor_ids = clinic.get("doctors", [])
    doctors = []
    for did in doctor_ids:
        try:
            user = mongo.db.users.find_one(
                {"_id": ObjectId(did), "user_type": "doctor"},
                {"password": 0},
            )
            if user:
                doctors.append(_serialize_doctor(user))
        except Exception:
            continue

    return jsonify(doctors), 200


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/doctor/clinics  — clinics the current doctor belongs to
# ─────────────────────────────────────────────────────────────────────────────

@clinic_routes.route("/api/doctor/clinics", methods=["GET"])
@token_required
@api_error_handler
def get_my_clinics(current_user):
    if current_user.get("user_type") not in ("doctor", "admin"):
        return jsonify({"error": "Doctors and admins only"}), 403

    doctor_id = str(current_user["_id"])
    clinics = list(mongo.db.clinics.find({"doctors": doctor_id}).sort("name", 1))
    return jsonify([_serialize_clinic(c) for c in clinics]), 200
