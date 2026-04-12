"""
backend/utils/fhir_de.py
─────────────────────────────────────────────────────────────────────────────
German FHIR profile helpers for Morafek CareMate.

Provides:
  • Profile URL constants for de.basisprofil.r4, ISiK Stage 1, KBV
  • add_de_profile()  — stamps meta.profile onto any FHIR resource dict
  • build_fhir_patient() — constructs a de.basisprofil.r4-compliant Patient
  • build_isik_encounter_fields() — adds ISiK-required Encounter fields
  • build_isik_condition_fields() — adds ISiK-required Condition fields
  • GKV_IDENTIFIER / LANR_IDENTIFIER helpers

Usage in ehr_routes.py
  from utils.fhir_de import (
      add_de_profile, PROFILE, build_fhir_patient,
      build_isik_encounter_fields, build_isik_condition_fields,
  )

  # Stamp a stored Observation
  doc = add_de_profile(doc, PROFILE.OBSERVATION_DE)

  # Build a Patient resource from your user dict
  fhir_pt = build_fhir_patient(user)

References
  de.basisprofil.r4:  https://simplifier.net/basisprofil-de-r4
  ISiK Stage 3:       https://simplifier.net/isik-basismodul-stufe3
"""

from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4


# ─── Profile URL constants ─────────────────────────────────────────────────────

@dataclass(frozen=True)
class _Profiles:
    # ── de.basisprofil.r4 ── (foundation for all German implementations)
    PATIENT_DE:      str = "http://fhir.de/StructureDefinition/Patient"
    OBSERVATION_DE:  str = "http://fhir.de/StructureDefinition/Observation-de-vitalsign"
    ENCOUNTER_DE:    str = "http://fhir.de/StructureDefinition/Encounter"
    CONDITION_DE:    str = "http://fhir.de/StructureDefinition/Condition"
    HUMANNAME_DE:    str = "http://fhir.de/StructureDefinition/humanname-de-basis"
    ADDRESS_DE:      str = "http://fhir.de/StructureDefinition/address-de-basis"

    # ── ISiK Stage 1 (Basisdaten) ── mandatory for KHZG-funded hospitals
    ISIK_PATIENT:    str = "https://gematik.de/fhir/isik/StructureDefinition/ISiKPatient"
    ISIK_ENCOUNTER:  str = "https://gematik.de/fhir/isik/StructureDefinition/ISiKKontaktGesundheitseinrichtung"
    ISIK_CONDITION:  str = "https://gematik.de/fhir/isik/StructureDefinition/ISiKDiagnose"
    ISIK_OBSERVATION_VITALS: str = "https://gematik.de/fhir/isik/StructureDefinition/ISiKLebenszeichen"
    ISIK_DOCUMENT_REFERENCE: str = "https://gematik.de/fhir/isik/StructureDefinition/ISiKDokumentenInformationen"


PROFILE = _Profiles()


# ─── Identifier system URIs ────────────────────────────────────────────────────

class IdentifierSystem:
    """Well-known German identifier system URIs used in de.basisprofil.r4."""

    # GKV statutory health insurance patient number (10-digit alpha-numeric)
    GKV_KVID   = "http://fhir.de/sid/gkv/kvid-10"

    # Private health insurance (PKV) — insurer-specific URIs exist but this
    # is the canonical placeholder for PKV identifiers.
    PKV        = "http://fhir.de/sid/pkv/kvid-10"

    # Lifelong doctor number issued by Kassenärztliche Vereinigung
    LANR       = "http://fhir.de/sid/kbv/lanr"

    # Betriebsstättennummer — KBV practice number
    BSNR       = "http://fhir.de/sid/kbv/bsnr"

    # Institutionskennzeichen — for hospitals / organisations
    IK_NR      = "http://fhir.de/sid/arge-ik/iknr"

    # Internal hospital patient number (KH-intern) — use your own domain
    KH_INTERN  = "https://morafek.app/fhir/sid/patient-id"


# ─── Helpers ──────────────────────────────────────────────────────────────────

def add_de_profile(resource: dict, *profile_urls: str) -> dict:
    """
    Stamp one or more German profile URLs onto a FHIR resource's meta.profile.

    Idempotent — existing profile URLs are preserved; duplicates are skipped.

    Example
    -------
    doc = add_de_profile(encounter_doc,
                         PROFILE.ENCOUNTER_DE,
                         PROFILE.ISIK_ENCOUNTER)
    """
    meta = resource.setdefault("meta", {})
    existing: list[str] = meta.setdefault("profile", [])
    for url in profile_urls:
        if url not in existing:
            existing.append(url)
    return resource


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ─── FHIR Patient resource ─────────────────────────────────────────────────────

def build_fhir_patient(
    user: dict,
    *,
    gkv_kvid:    str | None = None,
    lanr:        str | None = None,
    birthdate:   str | None = None,
    gender:      str | None = None,
    phone:       str | None = None,
    street:      str | None = None,
    postal_code: str | None = None,
    city:        str | None = None,
) -> dict:
    """
    Build a de.basisprofil.r4 + ISiK-compliant FHIR Patient resource
    from your internal user document.

    Parameters
    ----------
    user         : MongoDB user dict (must have _id, first_name, last_name, email)
    gkv_kvid     : GKV Krankenversichertennummer (10 chars, e.g. "A123456789")
    birthdate    : ISO date string "YYYY-MM-DD"
    gender       : "male" | "female" | "other" | "unknown"
    phone / street / postal_code / city : contact/address fields

    Returns
    -------
    A FHIR R4 Patient resource dict ready to store or return.

    Notes
    -----
    ISiK Stage 1 requires:
      • id, meta.profile, identifier (≥1), active, name (official/family),
        gender, birthDate

    de.basisprofil.r4 additionally structures:
      • name with use = "official" + HumanName-de-basis extension
      • address with Address-de-basis extension
    """
    patient_id  = str(user["_id"])
    first_name  = user.get("first_name", "")
    last_name   = user.get("last_name",  "")
    email       = user.get("email",      "")

    # ── identifiers ──────────────────────────────────────────────────────────
    identifiers = [
        {
            "system": IdentifierSystem.KH_INTERN,
            "value":  patient_id,
        }
    ]
    if gkv_kvid:
        identifiers.append({
            "type": {
                "coding": [{
                    "system":  "http://fhir.de/CodeSystem/identifier-type-de-basis",
                    "code":    "GKV",
                    "display": "Gesetzliche Krankenversicherung",
                }]
            },
            "system": IdentifierSystem.GKV_KVID,
            "value":  gkv_kvid,
        })

    # ── name (de.basisprofil.r4 HumanName structure) ─────────────────────────
    name_entry: dict[str, Any] = {
        "use":    "official",
        "family": last_name,
        "given":  [first_name] if first_name else [],
        # The extension maps to the Nachname (family name) element
        # required by the German base profile.
        "_family": {
            "extension": [{
                "url":         "http://hl7.org/fhir/StructureDefinition/humanname-own-name",
                "valueString": last_name,
            }]
        },
    }

    # ── address (de.basisprofil.r4 Address-de-basis structure) ───────────────
    address_list = []
    if any([street, postal_code, city]):
        address_entry: dict[str, Any] = {
            "type":       "both",
            "use":        "home",
            "country":    "DE",
        }
        if street:
            address_entry["line"] = [street]
            address_entry["_line"] = [{
                "extension": [{
                    "url":         "http://hl7.org/fhir/StructureDefinition/iso21090-ADXP-streetName",
                    "valueString": street,
                }]
            }]
        if postal_code:
            address_entry["postalCode"] = postal_code
        if city:
            address_entry["city"] = city
        address_list.append(address_entry)

    # ── telecom ──────────────────────────────────────────────────────────────
    telecom = [{"system": "email", "value": email, "use": "home"}]
    if phone:
        telecom.append({"system": "phone", "value": phone, "use": "home"})

    # ── assemble ─────────────────────────────────────────────────────────────
    resource: dict[str, Any] = {
        "resourceType": "Patient",
        "id":           patient_id,
        "meta": {
            "profile": [
                PROFILE.PATIENT_DE,
                PROFILE.ISIK_PATIENT,
            ],
            "lastUpdated": _now_iso(),
        },
        "identifier": identifiers,
        "active":      True,
        "name":        [name_entry],
        "telecom":     telecom,
    }

    if gender:
        resource["gender"] = gender
    if birthdate:
        resource["birthDate"] = birthdate
    if address_list:
        resource["address"] = address_list

    return resource


# ─── ISiK Encounter additions ─────────────────────────────────────────────────

def build_isik_encounter_fields(
    encounter_doc: dict,
    *,
    aufnahmenummer: str | None = None,
) -> dict:
    """
    Add ISiK Stage 1 required fields to an existing Encounter document.

    ISiK mandates:
      • meta.profile → ISiKKontaktGesundheitseinrichtung
      • identifier   → at least one (Aufnahmenummer)
      • type         → CodeableConcept from ISiK value set
      • serviceType  → recommended (e.g. general practice)

    This is additive — call it on your encounter_doc before insert.

    Example
    -------
    encounter_doc = build_isik_encounter_fields(
        encounter_doc,
        aufnahmenummer=str(uuid4()),
    )
    """
    # Profile declaration
    add_de_profile(encounter_doc, PROFILE.ENCOUNTER_DE, PROFILE.ISIK_ENCOUNTER)

    # Aufnahmenummer — ISiK Stage 1 requires at least one identifier
    num = aufnahmenummer or str(uuid4())
    encounter_doc.setdefault("identifier", []).append({
        "type": {
            "coding": [{
                "system":  "http://terminology.hl7.org/CodeSystem/v2-0203",
                "code":    "VN",
                "display": "Visit number",
            }]
        },
        "system": "https://morafek.app/fhir/sid/aufnahmenummer",
        "value":  num,
    })

    # Encounter.type — ISiK requires at least one, bound to a German value set.
    # Using the SNOMED code for ambulatory consultation (most common outpatient type).
    if "type" not in encounter_doc:
        encounter_doc["type"] = [{
            "coding": [{
                "system":  "http://snomed.info/sct",
                "code":    "11429006",
                "display": "Consultation",
            }]
        }]

    # serviceType — recommended by ISiK; general medical practice by default.
    # Adjust per specialty using the ISiK Fachrichtung value set if needed.
    if "serviceType" not in encounter_doc:
        encounter_doc["serviceType"] = {
            "coding": [{
                "system":  "https://www.medizininformatik-initiative.de/fhir/core/modul-fall/CodeSystem/Fachabteilungsschluessel",
                "code":    "0100",
                "display": "Innere Medizin",
            }]
        }

    return encounter_doc


# ─── ISiK Condition additions ─────────────────────────────────────────────────

def build_isik_condition_fields(condition_doc: dict) -> dict:
    """
    Add ISiK Stage 1 required fields to an existing Condition document.

    ISiK ISiKDiagnose requires:
      • meta.profile → ISiKDiagnose
      • clinicalStatus (already present in your code)
      • verificationStatus (already present in your code)
      • code with ICD-10-GM (already present in your code)
      • subject reference (already present in your code)
      • recordedDate

    This only adds the profile stamp and recordedDate — your existing
    condition_doc construction already satisfies the other requirements.
    """
    add_de_profile(condition_doc, PROFILE.CONDITION_DE, PROFILE.ISIK_CONDITION)

    # recordedDate — ISiK requires it; add if not present
    if "recordedDate" not in condition_doc:
        condition_doc["recordedDate"] = _now_iso()

    return condition_doc


# ─── ISiK Observation (Lebenszeichen / vital signs) additions ─────────────────

def build_isik_observation_vitals_fields(observation_doc: dict) -> dict:
    """
    Add ISiK ISiKLebenszeichen profile stamp to a vital-signs Observation.

    ISiK requires:
      • meta.profile → ISiKLebenszeichen
      • status, category, code, subject, effectiveDateTime (all already present)

    Your existing Observation construction already satisfies all field
    requirements. This function adds only the profile declaration.
    """
    add_de_profile(
        observation_doc,
        PROFILE.OBSERVATION_DE,
        PROFILE.ISIK_OBSERVATION_VITALS,
    )
    return observation_doc


# ─── Practitioner LANR identifier helper ──────────────────────────────────────

def build_lanr_identifier(lanr_value: str) -> dict:
    """
    Build a de.basisprofil.r4-compliant LANR identifier entry.

    Usage (in a Practitioner resource):
        "identifier": [build_lanr_identifier("123456789")]
    """
    return {
        "type": {
            "coding": [{
                "system":  "http://terminology.hl7.org/CodeSystem/v2-0203",
                "code":    "DN",
                "display": "Doctor number",
            }]
        },
        "system": IdentifierSystem.LANR,
        "value":  lanr_value,
    }
