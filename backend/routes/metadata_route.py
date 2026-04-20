"""
backend/routes/metadata_route.py
─────────────────────────────────────────────────────────────────────────────
FHIR CapabilityStatement endpoint: GET /metadata

Every FHIR server MUST expose this endpoint (FHIR R4 §3.1.0.1).
ISiK Stage 1 mandates that hospitals publish a conformant CapabilityStatement
so the government can programmatically verify compliance.

For Morafek CareMate this serves two purposes:
  1. Demonstrates de.basisprofil.r4 / ISiK awareness to German customers.
  2. Is the first thing any FHIR integration partner (KIS vendor, portal)
     will request before connecting.

Register in main.py:
  from routes.metadata_route import metadata_bp
  app.register_blueprint(metadata_bp)

The statement is assembled once at module load and cached — it does not hit
the database on every call. Update MORAFEK_VERSION and the resource list if
your supported resources change.
"""

from flask import Blueprint, jsonify
from datetime import datetime, timezone

metadata_bp = Blueprint("metadata", __name__)

# ── Bump this whenever you add/remove supported resources or operations ──
MORAFEK_FHIR_VERSION     = "4.0.1"
MORAFEK_SERVER_VERSION   = "1.1.0"
MORAFEK_PUBLISHER        = "Morafek CareMate"
MORAFEK_BASE_URL         = "https://morafek-caremate.onrender.com/fhir"

# ── ISiK Stage 1 Basisdaten profile URLs ─────────────────────────────────────
_ISIK_PATIENT    = "https://gematik.de/fhir/isik/StructureDefinition/ISiKPatient"
_ISIK_ENCOUNTER  = "https://gematik.de/fhir/isik/StructureDefinition/ISiKKontaktGesundheitseinrichtung"
_ISIK_CONDITION  = "https://gematik.de/fhir/isik/StructureDefinition/ISiKDiagnose"
_ISIK_OBS_VITALS = "https://gematik.de/fhir/isik/StructureDefinition/ISiKLebenszeichen"
_ISIK_DOC_REF    = "https://gematik.de/fhir/isik/StructureDefinition/ISiKDokumentenInformationen"
_KBV_ERP_MED     = "https://fhir.kbv.de/StructureDefinition/KBV_PR_ERP_Medication_PZN"
_KBV_ERP_RX      = "https://fhir.kbv.de/StructureDefinition/KBV_PR_ERP_Prescription"

# ── de.basisprofil.r4 ────────────────────────────────────────────────────────
_DE_PATIENT   = "http://fhir.de/StructureDefinition/Patient"
_DE_OBS       = "http://fhir.de/StructureDefinition/Observation-de-vitalsign"
_DE_ENCOUNTER = "http://fhir.de/StructureDefinition/Encounter"
_DE_CONDITION = "http://fhir.de/StructureDefinition/Condition"


def _build_capability_statement() -> dict:
    """
    Assembles the CapabilityStatement resource.

    Interaction codes follow FHIR R4 §8.1 (read, search-type, create, update).
    Search parameters are the minimal ISiK Stage 1 Basisdaten required set.
    """
    return {
        "resourceType": "CapabilityStatement",
        "id": "morafek-caremate-capability",
        "meta": {
            "profile": [
                "https://gematik.de/fhir/isik/StructureDefinition/ISiKCapabilityStatementBasisServer"
            ]
        },
        "url": f"{MORAFEK_BASE_URL}/metadata",
        "version": MORAFEK_SERVER_VERSION,
        "name": "MorafekCareMateCapabilityStatement",
        "title": "Morafek CareMate — FHIR Server Capability Statement",
        "status": "active",
        "experimental": False,
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "publisher": MORAFEK_PUBLISHER,
        "description": (
            "Morafek CareMate FHIR R4 server. Implements de.basisprofil.r4 and "
            "targets ISiK Stage 1 (Basisdaten) compliance. "
            "Supported resources: Patient, Observation (vital signs), Encounter, "
            "Condition, DocumentReference, Medication, MedicationRequest, "
            "MedicationStatement, Bundle."
        ),
        "kind": "instance",
        "software": {
            "name": "Morafek CareMate",
            "version": MORAFEK_SERVER_VERSION,
        },
        "fhirVersion": MORAFEK_FHIR_VERSION,
        "format": ["application/fhir+json", "application/json"],

        # ── Security: SMART on FHIR (declared; not yet enforced — roadmap) ──
        "rest": [{
            "mode": "server",
            "security": {
                "cors": True,
                "description": (
                    "JWT bearer tokens issued by the Morafek auth service. "
                    "SMART on FHIR scopes planned for ePA integration."
                ),
            },
            "resource": [

                # ── Patient ─────────────────────────────────────────────────
                {
                    "type": "Patient",
                    "profile": _DE_PATIENT,
                    "supportedProfile": [_ISIK_PATIENT],
                    "documentation": (
                        "Read and search patient demographics. de.basisprofil.r4 "
                        "Patient profile with GKV-Krankenversichertennummer support."
                    ),
                    "interaction": [
                        {"code": "read"},
                        {"code": "search-type"},
                    ],
                    "searchParam": [
                        {"name": "_id",        "type": "token",  "documentation": "Logical id of the resource"},
                        {"name": "name",       "type": "string", "documentation": "Patient name (family or given)"},
                        {"name": "birthdate",  "type": "date",   "documentation": "The patient's date of birth"},
                        {"name": "gender",     "type": "token",  "documentation": "Gender of the patient"},
                        {"name": "identifier", "type": "token",  "documentation": "A patient identifier (GKV, internal)"},
                    ],
                },

                # ── Observation (vital signs) ────────────────────────────────
                {
                    "type": "Observation",
                    "profile": _DE_OBS,
                    "supportedProfile": [_ISIK_OBS_VITALS],
                    "documentation": (
                        "Blood pressure (LOINC 55284-4), heart rate (8867-4), "
                        "body weight (29463-7). UCUM units. Patient-submitted "
                        "and doctor-recorded."
                    ),
                    "interaction": [
                        {"code": "read"},
                        {"code": "search-type"},
                        {"code": "create"},
                    ],
                    "searchParam": [
                        {"name": "patient",  "type": "reference", "documentation": "The subject of the observation"},
                        {"name": "category", "type": "token",     "documentation": "Classification of the observation (vital-signs)"},
                        {"name": "code",     "type": "token",     "documentation": "The LOINC code of the observation"},
                        {"name": "date",     "type": "date",      "documentation": "Date of the observation (effectiveDateTime)"},
                        {"name": "status",   "type": "token",     "documentation": "Observation status"},
                    ],
                },

                # ── Encounter ────────────────────────────────────────────────
                {
                    "type": "Encounter",
                    "profile": _DE_ENCOUNTER,
                    "supportedProfile": [_ISIK_ENCOUNTER],
                    "documentation": (
                        "Clinical visits recorded by doctors. ISiK Encounter with "
                        "Aufnahmenummer identifier and SNOMED encounter type."
                    ),
                    "interaction": [
                        {"code": "read"},
                        {"code": "search-type"},
                        {"code": "create"},
                    ],
                    "searchParam": [
                        {"name": "patient",    "type": "reference", "documentation": "The patient the encounter is about"},
                        {"name": "status",     "type": "token",     "documentation": "Encounter status (planned, in-progress, finished)"},
                        {"name": "date",       "type": "date",      "documentation": "A date within the period the encounter lasted"},
                        {"name": "identifier", "type": "token",     "documentation": "Aufnahmenummer or other encounter identifier"},
                    ],
                },

                # ── Condition ────────────────────────────────────────────────
                {
                    "type": "Condition",
                    "profile": _DE_CONDITION,
                    "supportedProfile": [_ISIK_CONDITION],
                    "documentation": (
                        "Diagnoses coded with ICD-10-GM (BfArM). "
                        "Linked to Encounter via reference."
                    ),
                    "interaction": [
                        {"code": "read"},
                        {"code": "search-type"},
                        {"code": "create"},
                    ],
                    "searchParam": [
                        {"name": "patient",          "type": "reference", "documentation": "Who has the condition"},
                        {"name": "code",             "type": "token",     "documentation": "Code for the condition (ICD-10-GM)"},
                        {"name": "clinical-status",  "type": "token",     "documentation": "active | recurrence | relapse | inactive | remission | resolved"},
                        {"name": "encounter",        "type": "reference", "documentation": "Encounter when the condition was first asserted"},
                    ],
                },

                # ── DocumentReference ────────────────────────────────────────
                {
                    "type": "DocumentReference",
                    "supportedProfile": [_ISIK_DOC_REF],
                    "documentation": (
                        "Clinical documents: lab reports (LOINC 11502-2), "
                        "imaging reports (18748-4), prescriptions, other. "
                        "Binary content stored on Cloudinary."
                    ),
                    "interaction": [
                        {"code": "read"},
                        {"code": "search-type"},
                        {"code": "create"},
                        {"code": "delete"},
                    ],
                    "searchParam": [
                        {"name": "patient",   "type": "reference", "documentation": "Who the document is about"},
                        {"name": "type",      "type": "token",     "documentation": "Document type (LOINC)"},
                        {"name": "category",  "type": "token",     "documentation": "Categorization of document"},
                        {"name": "date",      "type": "date",      "documentation": "When the document was created"},
                        {"name": "status",    "type": "token",     "documentation": "current | superseded | entered-in-error"},
                    ],
                },

                # ── Medication ────────────────────────────────────────────────
                {
                    "type": "Medication",
                    "profile": _KBV_ERP_MED,
                    "interaction": [
                        {"code": "read"},
                    ],
                    "versioning": "no-version",
                },

                # ── MedicationRequest ─────────────────────────────────────────
                {
                    "type": "MedicationRequest",
                    "profile": _KBV_ERP_RX,
                    "interaction": [
                        {"code": "read"},
                        {"code": "search-type"},
                    ],
                    "searchParam": [
                        {"name": "patient", "type": "reference"},
                        {"name": "status", "type": "token"},
                    ],
                    "versioning": "no-version",
                },

                # ── MedicationStatement ───────────────────────────────────────
                {
                    "type": "MedicationStatement",
                    "profile": "http://hl7.org/fhir/StructureDefinition/MedicationStatement",
                    "interaction": [
                        {"code": "read"},
                        {"code": "search-type"},
                    ],
                    "searchParam": [
                        {"name": "patient", "type": "reference"},
                        {"name": "status", "type": "token"},
                    ],
                    "versioning": "no-version",
                },

                # ── Bundle ───────────────────────────────────────────────────
                {
                    "type": "Bundle",
                    "documentation": (
                        "Full-patient FHIR R4 Bundle export available at "
                        "GET /api/patient/fhir-export. Returns all Observations, "
                        "Encounters, Conditions, DocumentReferences, Medications, "
                        "MedicationRequests, and MedicationStatements."
                    ),
                    "interaction": [
                        {"code": "read"},
                    ],
                },
            ],

            # ── Global search parameters ─────────────────────────────────────
            "searchParam": [
                {"name": "_format", "type": "token",  "documentation": "Specify the response format (application/fhir+json)"},
                {"name": "_count",  "type": "number", "documentation": "Limit the number of results per page"},
            ],
        }],
    }


# Cache the statement at import time — it is static between deployments
_CACHED_CAPABILITY_STATEMENT = _build_capability_statement()


@metadata_bp.route("/metadata", methods=["GET"])
def capability_statement():
    """
    GET /metadata — FHIR CapabilityStatement (no auth required).

    Per FHIR R4 §3.1.0.1, this endpoint MUST be publicly accessible without
    authentication so integration partners can discover server capabilities.

    ISiK auditors (gematik Referenzvalidator) will query this endpoint first
    before testing any other operation.
    """
    return jsonify(_CACHED_CAPABILITY_STATEMENT), 200
