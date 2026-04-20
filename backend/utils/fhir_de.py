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
import re
from typing import Any
import uuid
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

    # ── KBV eRezept ──
    KBV_ERP_MEDICATION_PZN: str = "https://fhir.kbv.de/StructureDefinition/KBV_PR_ERP_Medication_PZN"
    KBV_ERP_PRESCRIPTION:   str = "https://fhir.kbv.de/StructureDefinition/KBV_PR_ERP_Prescription"


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

# ─── FHIR Observation splitting ───────────────────────────────────────────────

def build_observations_from_vitals_doc(
    doc: dict,
    patient_id: str,
    *,
    performer_ref: str | None = None,
    encounter_ref: str | None = None,
) -> list[dict]:
    """
    Convert a single stored vitals document (which may contain mixed components)
    into a list of separate, conformant FHIR Observations — one per vital sign.

    German FHIR profiles (MII, ISiK, KBV baseline) require each vital sign to
    be its own Observation. The only exception is blood pressure: systolic and
    diastolic MAY share one Observation under LOINC 55284-4.

    Returns 1-3 Observation resources depending on which values are present.

    Parameters
    ----------
    doc           : MongoDB vitals document as stored by create_vitals()
    patient_id    : patient's MongoDB ObjectId string
    performer_ref : FHIR reference string for the recorder,
                    e.g. "Practitioner/abc123" or "Patient/abc123".
                    Falls back to the patient reference for self-measurements.
    encounter_ref : Optional Encounter reference (e.g. "Encounter/xyz").
    """
    components = doc.get("component", [])

    # Extract values from stored mixed components
    bp_sys = bp_dia = hr_val = wt_val = None
    for comp in components:
        code_val = (comp.get("code", {}).get("coding") or [{}])[0].get("code")
        qty = comp.get("valueQuantity", {}).get("value")
        if code_val == "8480-6":
            bp_sys = qty
        elif code_val == "8462-4":
            bp_dia = qty
        elif code_val == "8867-4":
            hr_val = qty
        elif code_val == "29463-7":
            wt_val = qty

    effective_dt = doc.get("effectiveDateTime") or _now_iso()
    # performer: use supplied ref, or fall back to the patient (self-measurement)
    performer = [{"reference": performer_ref or f"Patient/{patient_id}"}]

    # Fields shared across all sibling observations
    base: dict = {
        "status": doc.get("status", "final"),
        "category": doc.get("category") or [{
            "coding": [{
                "system":  "http://terminology.hl7.org/CodeSystem/observation-category",
                "code":    "vital-signs",
                "display": "Vital Signs",
            }]
        }],
        "subject":           {"reference": f"Patient/{patient_id}"},
        "effectiveDateTime": effective_dt,
        "performer":         performer,
    }
    if encounter_ref:
        base["encounter"] = {"reference": encounter_ref}

    observations: list[dict] = []

    # ── Blood pressure (systolic + diastolic share one Observation) ───────────
    if bp_sys is not None or bp_dia is not None:
        bp_obs: dict = {
            "resourceType": "Observation",
            "id":           doc.get("id") or str(uuid4()),
            **base,
            "code": {"coding": [{
                "system":  "http://loinc.org",
                "code":    "55284-4",
                "display": "Blood pressure systolic and diastolic",
            }]},
            "component": [],
        }
        if bp_sys is not None:
            bp_obs["component"].append({
                "code": {"coding": [{"system": "http://loinc.org",
                                     "code": "8480-6", "display": "Systolic BP"}]},
                "valueQuantity": {"value": bp_sys, "unit": "mmHg",
                                  "system": "http://unitsofmeasure.org", "code": "mm[Hg]"},
            })
        if bp_dia is not None:
            bp_obs["component"].append({
                "code": {"coding": [{"system": "http://loinc.org",
                                     "code": "8462-4", "display": "Diastolic BP"}]},
                "valueQuantity": {"value": bp_dia, "unit": "mmHg",
                                  "system": "http://unitsofmeasure.org", "code": "mm[Hg]"},
            })
        # Carry over free-text notes and app-specific extensions from the source doc
        if doc.get("note"):
            bp_obs["note"] = doc["note"]
        if doc.get("extension"):
            bp_obs["extension"] = doc["extension"]
        add_de_profile(bp_obs, PROFILE.OBSERVATION_DE, PROFILE.ISIK_OBSERVATION_VITALS)
        observations.append(bp_obs)

    # ── Heart rate ────────────────────────────────────────────────────────────
    if hr_val is not None:
        hr_obs: dict = {
            "resourceType": "Observation",
            "id":           str(uuid4()),
            **base,
            "code": {"coding": [{"system": "http://loinc.org",
                                 "code": "8867-4", "display": "Heart rate"}]},
            "valueQuantity": {"value": hr_val, "unit": "/min",
                              "system": "http://unitsofmeasure.org", "code": "/min"},
        }
        add_de_profile(hr_obs, PROFILE.OBSERVATION_DE, PROFILE.ISIK_OBSERVATION_VITALS)
        observations.append(hr_obs)

    # ── Body weight ───────────────────────────────────────────────────────────
    if wt_val is not None:
        wt_obs: dict = {
            "resourceType": "Observation",
            "id":           str(uuid4()),
            **base,
            "code": {"coding": [{"system": "http://loinc.org",
                                 "code": "29463-7", "display": "Body weight"}]},
            "valueQuantity": {"value": wt_val, "unit": "kg",
                              "system": "http://unitsofmeasure.org", "code": "kg"},
        }
        add_de_profile(wt_obs, PROFILE.OBSERVATION_DE, PROFILE.ISIK_OBSERVATION_VITALS)
        observations.append(wt_obs)

    return observations


# ─── FHIR Composition ──────────────────────────────────────────────────────────

_SECTION_META: dict[str, tuple[str, str, str]] = {
    # resourceType → (section title, LOINC code, display)
    "Observation":       ("Vitalzeichen",   "8716-3",  "Vital signs"),
    "Encounter":         ("Besuche",        "46240-8", "History of encounters"),
    "Condition":         ("Diagnosen",      "11450-4", "Problem list"),
    "DocumentReference": ("Dokumente",      "46209-3", "Provider orders"),
    "Medication":        ("Medikationen",   "10160-0", "History of medication use"),
    "MedicationRequest": ("Verordnungen",   "57833-6", "Prescription for medication"),
    "MedicationStatement": ("Einnahmen",    "10160-0", "History of medication use"),
}


def build_composition(
    patient_id: str,
    *,
    author_ref: str,
    title: str = "Morafek CareMate — Patientenakte",
    section_entries: list[dict] | None = None,
) -> dict:
    """
    Build a FHIR R4 Composition resource.

    FHIR R4 §3.3 requires a Composition as the *first* entry in every
    document Bundle. Without it the server is non-conformant — validators
    (gematik Referenzvalidator, HAPI) will reject the Bundle.

    Parameters
    ----------
    patient_id      : patient MongoDB ObjectId string
    author_ref      : FHIR reference for the document author,
                      e.g. "Practitioner/abc" or "Patient/abc".
    title           : human-readable document title
    section_entries : the other Bundle entries (used to auto-build sections)
    """
    from collections import defaultdict

    comp_id = str(uuid4())

    # Auto-group entries by resourceType → Composition sections
    by_type: dict[str, list[dict]] = defaultdict(list)
    for entry in (section_entries or []):
        rt = entry.get("resource", {}).get("resourceType", "Unknown")
        by_type[rt].append({"reference": entry.get("fullUrl", "")})

    sections = []
    for rt, refs in by_type.items():
        title_str, loinc_code, loinc_display = _SECTION_META.get(
            rt, (rt, "11450-4", "Problem list")
        )
        sections.append({
            "title": title_str,
            "code": {"coding": [{"system": "http://loinc.org",
                                 "code": loinc_code, "display": loinc_display}]},
            "entry": refs,
        })

    return {
        "resourceType": "Composition",
        "id":           comp_id,
        "status":       "final",
        "type": {"coding": [{
            "system":  "http://loinc.org",
            "code":    "60591-5",
            "display": "Patient summary Document",
        }]},
        "subject": {"reference": f"Patient/{patient_id}"},
        "date":    _now_iso(),
        "author":  [{"reference": author_ref}],
        "title":   title,
        "section": sections,
    }


# ─── Conformant document Bundle ────────────────────────────────────────────────

def build_document_bundle(
    patient_id: str,
    entries: list[dict],
    *,
    author_ref: str,
) -> dict:
    """
    Wrap a list of FHIR entries into a conformant R4 document Bundle.

    Fixes vs. the previous implementation
    ──────────────────────────────────────
    • Adds    Bundle.identifier   — required by KBV and gematik ePA profiles
    • Removes Bundle.total        — invalid for type=document (only for searchset)
    • Prepends Composition entry  — FHIR R4 §3.3 hard requirement

    Parameters
    ----------
    patient_id : patient MongoDB ObjectId string
    entries    : FHIR Bundle entries (each a dict with 'fullUrl' + 'resource')
    author_ref : passed through to build_composition()
    """
    bundle_id   = str(uuid4())
    composition = build_composition(
        patient_id,
        author_ref=author_ref,
        section_entries=entries,
    )

    return {
        "resourceType": "Bundle",
        "id":           bundle_id,
        "meta": {
            "profile": ["http://hl7.org/fhir/StructureDefinition/Bundle"],
        },
        # Bundle.identifier — persistent, globally unique ID for this document
        "identifier": {
            "system": "https://morafek.app/fhir/sid/bundle-id",
            "value":  bundle_id,
        },
        "type":      "document",
        "timestamp": _now_iso(),
        # Composition MUST be first (FHIR R4 §3.3)
        "entry": [
            {"fullUrl": f"urn:uuid:{composition['id']}", "resource": composition},
            *entries,
        ],
    }


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


def _normalize_fhir_date(value: Any) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).strftime("%Y-%m-%d")
    return str(value).strip() or None


def _build_dosage_text(medication_doc: dict) -> str:
    dosage_values = [
        int(medication_doc.get(f"dosage_{slot}") or 0)
        for slot in ("morning", "noon", "evening", "night")
    ]
    dosage_pattern = "-".join(str(value) for value in dosage_values)
    dosage_unit = str(medication_doc.get("dosage_unit", "") or "").strip()
    dosage_note = str(medication_doc.get("dosage_note", "") or "").strip()
    if not any(dosage_values) and not dosage_unit and not dosage_note:
        return ""
    text = f"{dosage_pattern} {dosage_unit}".strip()
    if dosage_note:
        text = f"{text} ({dosage_note})" if text else dosage_note
    return text


_KBV_DARREICHUNGSFORM_SYSTEM = "https://fhir.kbv.de/CodeSystem/KBV_CS_SFHIR_KBV_DARREICHUNGSFORM"
_KBV_DARREICHUNGSFORM_MAP = {
    "tablette": "TAB",
    "kapsel": "KAP",
    "retardtablette": "RET",
    "pflaster": "PFL",
    "creme": "CRE",
    "salbe": "SAL",
    "gel": "GEL",
    "lotion": "LOT",
    "aerosol": "AER",
    "spray": "SPR",
    "tropfen": "TRO",
    "lyophilisat": "LIO",
    "sirup": "SIR",
    "suspension": "SUS",
    "emulsion": "EMU",
    "lösung": "SOL",
    "loesung": "SOL",
    "injektion": "INJ",
    "infusion": "INF",
    "pulver": "PUL",
    "granulat": "GRA",
    "suppositorium": "SUP",
    "zäpfchen": "ZAE",
    "zaepfchen": "ZAE",
    "vaginaltablette": "VAG",
    "konzentrat": "KTR",
}
_SLOT_TIMING_WHEN = {
    "morning": "MORN",
    "noon": "NOON",
    "evening": "EVE",
    "night": "NIGHT",
}
_SLOT_DEFAULT_TIME = {
    "morning": "08:00:00",
    "noon": "12:00:00",
    "evening": "18:00:00",
    "night": "22:00:00",
}
_KBV_MEDICATION_CATEGORY_CODE = "00"
_KBV_STATUS_CO_PAYMENT_CODE_MAP = {
    "GKV": "0",
    "PKV": "3",
    "Selbstzahler": "2",
}


def _build_dosage_label(medication_doc: dict) -> str:
    dosage_values = [
        int(medication_doc.get(f"dosage_{slot}") or 0)
        for slot in ("morning", "noon", "evening", "night")
    ]
    return "-".join(str(value) for value in dosage_values)


def _build_timing_when(medication_doc: dict) -> list[str]:
    when_codes: list[str] = []
    for slot, code in _SLOT_TIMING_WHEN.items():
        if int(medication_doc.get(f"dosage_{slot}") or 0) > 0:
            when_codes.append(code)
    return when_codes


def _derive_effective_datetime_from_intake(intake: dict) -> str | None:
    confirmed_at = _normalize_iso_datetime(intake.get("confirmed_at"))
    if confirmed_at:
        return confirmed_at
    date_value = str(intake.get("date", "") or "").strip()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_value):
        return (
            _normalize_iso_datetime(intake.get("taken_at"))
            or _normalize_iso_datetime(intake.get("created_at"))
        )
    slot = str(intake.get("slot", "") or "").strip().lower()
    slot_time = _SLOT_DEFAULT_TIME.get(slot, "00:00:00")
    return f"{date_value}T{slot_time}Z"


def _parse_strength_text(strength_text: str) -> tuple[float, str] | None:
    match = re.match(r"^\s*(\d+(?:[.,]\d+)?)\s*(.+?)\s*$", strength_text or "")
    if not match:
        return None
    numeric_part = match.group(1).replace(",", ".")
    unit_part = match.group(2).strip()
    if not unit_part:
        return None
    try:
        value = float(numeric_part)
    except ValueError:
        return None
    return value, unit_part


def _stable_fhir_uuid(mongo_id: Any) -> str:
    if mongo_id in (None, ""):
        raise ValueError("MongoDB _id is required to build stable FHIR UUID.")
    source = str(mongo_id).strip()
    if not source:
        raise ValueError("MongoDB _id is required to build stable FHIR UUID.")
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, source))


def _normalize_iso_datetime(value: Any) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    raw = str(value).strip()
    if not raw:
        return None
    if re.match(r"^\d{4}-\d{2}-\d{2}$", raw):
        return f"{raw}T00:00:00Z"
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return raw


def build_medication_resource(med: dict) -> dict:
    mongo_id = med.get("_id") or med.get("id")
    medication_id = _stable_fhir_uuid(mongo_id)
    pzn = str(med.get("pzn", "") or "").strip()
    if not pzn:
        raise ValueError(f"Medication PZN is required for KBV medication export (mongo_id={mongo_id}).")
    if len(pzn) != 8 or not pzn.isdigit():
        raise ValueError(f"Medication PZN must be an 8-digit string (mongo_id={mongo_id}).")
    trade_name = str(med.get("trade_name", "") or "").strip()
    active_substance = str(med.get("active_substance", "") or "").strip()
    form = str(med.get("form", "") or "").strip()
    if not form:
        raise ValueError(f"Medication form is required for KBV mapping (mongo_id={mongo_id}).")
    form_code = _KBV_DARREICHUNGSFORM_MAP.get(form.lower())
    strength = str(med.get("strength", "") or "").strip()
    norm_size = str(med.get("norm_size", "") or "").strip()
    if not norm_size:
        raise ValueError(f"Medication norm_size is required for KBV medication export (mongo_id={mongo_id}).")

    resource: dict[str, Any] = {
        "resourceType": "Medication",
        "id": medication_id,
        "meta": {"profile": [PROFILE.KBV_ERP_MEDICATION_PZN]},
        "status": "active" if med.get("is_active", True) else "inactive",
        "code": {
            "coding": [{
                "system": "http://fhir.de/CodeSystem/ifa/pzn",
                "code": pzn,
                "display": trade_name or pzn,
            }],
            "text": trade_name or pzn,
        },
    }

    if form:
        form_coding: dict[str, Any] = {"text": form}
        if not form_code:
            raise ValueError(f"Unsupported medication form for KBV mapping: '{form}' (mongo_id={mongo_id}).")
        form_coding["coding"] = [{
            "system": _KBV_DARREICHUNGSFORM_SYSTEM,
            "code": form_code,
            "display": form,
        }]
        resource["form"] = form_coding
    if active_substance:
        ingredient: dict[str, Any] = {"itemCodeableConcept": {"text": active_substance}}
        if strength:
            parsed_strength = _parse_strength_text(strength)
            if parsed_strength:
                amount_value, amount_unit = parsed_strength
                ingredient["strength"] = {"numerator": {"value": amount_value, "unit": amount_unit}}
        resource["ingredient"] = [ingredient]

    extensions: list[dict[str, Any]] = []
    extensions.append({
        "url": "https://fhir.kbv.de/StructureDefinition/KBV_EX_ERP_Medication_Category",
        "valueCoding": {
            "system": "https://fhir.kbv.de/CodeSystem/KBV_CS_ERP_Medication_Category",
            "code": _KBV_MEDICATION_CATEGORY_CODE,
        },
    })
    extensions.append({
        "url": "https://fhir.kbv.de/StructureDefinition/KBV_EX_ERP_Medication_Vaccine",
        "valueBoolean": bool(med.get("is_vaccine", False)),
    })
    extensions.append({
        "url": "https://fhir.kbv.de/StructureDefinition/KBV_EX_ERP_Medication_Normgroesse",
        "valueCode": norm_size,
    })
    if extensions:
        resource["extension"] = extensions
    return resource


def build_medication_request(med: dict) -> dict:
    mongo_id = med.get("_id") or med.get("id")
    medication_id = _stable_fhir_uuid(mongo_id)
    request_id = _stable_fhir_uuid(f"MedicationRequest:{mongo_id}")
    patient_id = str(med.get("patient_id", "") or "").strip()
    start_date = _normalize_iso_datetime(med.get("start_date"))
    end_date = _normalize_iso_datetime(med.get("end_date"))

    dosage_label = _build_dosage_label(med)
    dosage_note = str(med.get("dosage_note", "") or "").strip()
    timing_when = _build_timing_when(med)
    coverage = str(med.get("coverage", "") or "").strip()
    co_payment_code = _KBV_STATUS_CO_PAYMENT_CODE_MAP.get(coverage, "2")
    is_chronic = bool(med.get("is_chronic", False))
    resource: dict[str, Any] = {
        "resourceType": "MedicationRequest",
        "id": request_id,
        "meta": {"profile": [PROFILE.KBV_ERP_PRESCRIPTION]},
        "status": "active" if med.get("is_active", True) else "completed",
        "intent": "order",
        "medicationReference": {"reference": f"Medication/{medication_id}"},
        "extension": [
            {
                "url": "https://fhir.kbv.de/StructureDefinition/KBV_EX_ERP_StatusCoPayment",
                "valueCoding": {
                    "system": "https://fhir.kbv.de/CodeSystem/KBV_CS_ERP_StatusCoPayment",
                    "code": co_payment_code,
                },
            },
            {
                "url": "https://fhir.kbv.de/StructureDefinition/KBV_EX_ERP_EmergencyServicesFee",
                "valueBoolean": bool(med.get("emergency_services_fee", False)),
            },
            {
                "url": "https://fhir.kbv.de/StructureDefinition/KBV_EX_ERP_BVG",
                "valueBoolean": bool(med.get("bvg", False)),
            },
            {
                "url": "https://fhir.kbv.de/StructureDefinition/KBV_EX_ERP_Multiple_Prescription",
                "valueBoolean": bool(med.get("multiple_prescription", False)),
            },
        ],
        "substitution": {
            "allowedBoolean": bool(med.get("aut_idem", False)),
        },
    }
    if patient_id:
        resource["subject"] = {"reference": f"Patient/{patient_id}"}
    if dosage_label:
        dosage_instruction: dict[str, Any] = {"text": dosage_label}
        repeat: dict[str, Any] = {}
        if timing_when:
            repeat["when"] = timing_when
        bounds_period: dict[str, str] = {}
        if start_date:
            bounds_period["start"] = start_date
        if end_date and not is_chronic:
            bounds_period["end"] = end_date
        if bounds_period:
            repeat["boundsPeriod"] = bounds_period
        if repeat:
            dosage_instruction["timing"] = {"repeat": repeat}
        resource["dosageInstruction"] = [dosage_instruction]
    if dosage_note:
        resource["note"] = [{"text": dosage_note}]

    authored_on = _normalize_iso_datetime(med.get("created_at")) or start_date
    if authored_on:
        resource["authoredOn"] = authored_on
    if med.get("doctor_id"):
        resource["requester"] = {"reference": f"Practitioner/{med['doctor_id']}"}
    if med.get("visit_id"):
        resource["encounter"] = {"reference": f"Encounter/{med['visit_id']}"}
    if start_date or (end_date and not is_chronic):
        validity_period: dict[str, str] = {}
        if start_date:
            validity_period["start"] = start_date
        if end_date and not is_chronic:
            validity_period["end"] = end_date
        resource["dispenseRequest"] = {"validityPeriod": validity_period}
    return resource


def build_kbv_medication_resource(medication_doc: dict) -> dict:
    return build_medication_resource(medication_doc)


def build_kbv_medication_request_resource(
    medication_doc: dict,
    *,
    patient_id: str,
) -> dict:
    med = dict(medication_doc)
    if patient_id:
        med["patient_id"] = patient_id
    return build_medication_request(med)


def build_medication_statement(
    intake: dict,
    med: dict,
    patient_fhir_id: str,
) -> dict:
    status_map = {"taken": "completed", "skipped": "not-taken", "pending": "intended"}
    intake_status = str(intake.get("status", "pending") or "pending").lower()
    slot = str(intake.get("slot", "") or "").strip().lower()
    intake_id = _stable_fhir_uuid(intake.get("_id") or intake.get("id"))
    medication_fhir_id = str(med.get("fhir_id", "") or "").strip()
    medication_id = medication_fhir_id or _stable_fhir_uuid(med.get("_id") or med.get("id"))
    effective_date = _derive_effective_datetime_from_intake(intake)
    dose_value = int(med.get(f"dosage_{slot}", 0) or 0) if slot else 0

    resource: dict[str, Any] = {
        "resourceType": "MedicationStatement",
        "id": intake_id,
        "status": status_map.get(intake_status, "intended"),
        "subject": {"reference": f"Patient/{patient_fhir_id}"},
        "medicationReference": {"reference": f"Medication/{medication_id}"},
        "informationSource": {"reference": f"Patient/{patient_fhir_id}"},
        "extension": [{
            "url": "https://morafek.app/fhir/StructureDefinition/medication-intake-slot",
            "valueCode": slot or "unknown",
        }],
    }
    if effective_date:
        resource["effectiveDateTime"] = effective_date
        resource["dateAsserted"] = effective_date
    if dose_value > 0:
        resource["dosage"] = [{
            "doseQuantity": {
                "value": dose_value,
            }
        }]
    note = str(intake.get("note", "") or "").strip()
    if note:
        resource["note"] = [{"text": note}]
    return resource


def build_medication_statement_resource(
    intake_doc: dict,
    *,
    patient_id: str,
    medication_id: str,
) -> dict:
    medication_stub = {"fhir_id": medication_id}
    return build_medication_statement(intake_doc, medication_stub, patient_id)


def validate_kbv_medication_resource(resource: dict) -> None:
    if resource.get("resourceType") != "Medication":
        raise ValueError("Medication resourceType is required.")
    profiles = resource.get("meta", {}).get("profile", [])
    if PROFILE.KBV_ERP_MEDICATION_PZN not in profiles:
        raise ValueError("KBV medication profile URL is missing.")
    code = resource.get("code", {})
    coding_list = code.get("coding")
    if not isinstance(coding_list, list) or not coding_list:
        raise ValueError("Medication.code.coding is required.")
    coding = coding_list[0]
    if coding.get("system") != "http://fhir.de/CodeSystem/ifa/pzn":
        raise ValueError("Medication must use the IFA PZN coding system.")
    if not coding.get("code"):
        raise ValueError("Medication PZN code is required.")


def validate_kbv_medication_request_resource(resource: dict) -> None:
    if resource.get("resourceType") != "MedicationRequest":
        raise ValueError("MedicationRequest resourceType is required.")
    profiles = resource.get("meta", {}).get("profile", [])
    if PROFILE.KBV_ERP_PRESCRIPTION not in profiles:
        raise ValueError("KBV prescription profile URL is missing.")
    if not resource.get("status"):
        raise ValueError("MedicationRequest.status is required.")
    if resource.get("intent") != "order":
        raise ValueError("MedicationRequest.intent must be 'order'.")
    if not resource.get("subject", {}).get("reference"):
        raise ValueError("MedicationRequest.subject reference is required.")
    if not resource.get("medicationReference", {}).get("reference"):
        raise ValueError("MedicationRequest.medicationReference is required.")


_KNOWN_DARREICHUNGSFORM_CODES = {
    "TAB", "KAP", "RET", "PFL", "CRE", "SAL", "GEL", "LOT",
    "AER", "SPR", "TRO", "LIO", "SIR", "SUS", "EMU", "SOL",
    "INJ", "INF", "PUL", "GRA", "SUP", "ZAE", "VAG", "KTR",
}


def _is_valid_iso8601(value: Any, *, date_only_allowed: bool) -> bool:
    if value in (None, ""):
        return False
    raw = str(value).strip()
    if not raw:
        return False
    is_date_only = bool(re.match(r"^\d{4}-\d{2}-\d{2}$", raw))
    if date_only_allowed and is_date_only:
        return True
    if not date_only_allowed and is_date_only:
        return False
    try:
        datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def validate_medication_bundle_entries(entries: list) -> dict:
    errors: list[dict[str, str]] = []
    counts = {"Medication": 0, "MedicationRequest": 0, "MedicationStatement": 0}

    def add_error(resource: dict, field: str, issue: str) -> None:
        errors.append({
            "resource_id": str(resource.get("id") or "unknown"),
            "field": field,
            "issue": issue,
        })

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        resource = entry.get("resource", {})
        if not isinstance(resource, dict):
            continue
        resource_type = resource.get("resourceType")

        if resource_type == "Medication":
            counts["Medication"] += 1
            if resource.get("resourceType") != "Medication":
                add_error(resource, "resourceType", "must be Medication")

            profiles = resource.get("meta", {}).get("profile", [])
            if not isinstance(profiles, list) or not profiles or PROFILE.KBV_ERP_MEDICATION_PZN not in profiles:
                add_error(resource, "meta.profile[0]", "must contain KBV_PR_ERP_Medication_PZN")

            coding = ((resource.get("code", {}) or {}).get("coding", []) or [{}])[0]
            if coding.get("system") != "http://fhir.de/CodeSystem/ifa/pzn":
                add_error(resource, "code.coding[0].system", "must be http://fhir.de/CodeSystem/ifa/pzn")
            pzn_code = coding.get("code")
            if not isinstance(pzn_code, str) or len(pzn_code) != 8 or not pzn_code.isdigit():
                add_error(resource, "code.coding[0].code", "must be an 8-character numeric string")

            form_coding = ((resource.get("form", {}) or {}).get("coding", []) or [{}])[0]
            form_code = form_coding.get("code")
            if form_code not in _KNOWN_DARREICHUNGSFORM_CODES:
                add_error(resource, "form.coding[0].code", "must be in known Darreichungsform code set")

            extensions = resource.get("extension", [])
            extension_urls = [
                str(ext.get("url", "")).lower()
                for ext in extensions
                if isinstance(ext, dict)
            ]
            if not any("normgroesse" in url or "norm-size" in url for url in extension_urls):
                add_error(resource, "extension", "must contain normgroesse extension")
            if not any("category" in url for url in extension_urls):
                add_error(resource, "extension", "must contain Category extension")
            if not any("vaccine" in url for url in extension_urls):
                add_error(resource, "extension", "must contain Vaccine extension")

        if resource_type == "MedicationRequest":
            counts["MedicationRequest"] += 1
            if resource.get("resourceType") != "MedicationRequest":
                add_error(resource, "resourceType", "must be MedicationRequest")
            if resource.get("status") not in {"active", "completed", "stopped"}:
                add_error(resource, "status", "must be one of active/completed/stopped")
            if resource.get("intent") != "order":
                add_error(resource, "intent", "must be order")
            if not str((resource.get("medicationReference", {}) or {}).get("reference", "")).startswith("Medication/"):
                add_error(resource, "medicationReference.reference", "must start with Medication/")
            if not str((resource.get("subject", {}) or {}).get("reference", "")).startswith("Patient/"):
                add_error(resource, "subject.reference", "must start with Patient/")
            if not _is_valid_iso8601(resource.get("authoredOn"), date_only_allowed=True):
                add_error(resource, "authoredOn", "must be valid ISO 8601 date string")
            dosage_instruction = resource.get("dosageInstruction")
            if not isinstance(dosage_instruction, list) or not dosage_instruction:
                add_error(resource, "dosageInstruction", "must be a non-empty list")
            substitution_allowed = ((resource.get("substitution", {}) or {}).get("allowedBoolean", None))
            if not isinstance(substitution_allowed, bool):
                add_error(resource, "substitution.allowedBoolean", "must be a boolean")

        if resource_type == "MedicationStatement":
            counts["MedicationStatement"] += 1
            if resource.get("resourceType") != "MedicationStatement":
                add_error(resource, "resourceType", "must be MedicationStatement")
            if resource.get("status") not in {"completed", "not-taken", "intended", "in-progress"}:
                add_error(resource, "status", "must be one of completed/not-taken/intended/in-progress")
            if not str((resource.get("medicationReference", {}) or {}).get("reference", "")).startswith("Medication/"):
                add_error(resource, "medicationReference.reference", "must start with Medication/")
            if not str((resource.get("subject", {}) or {}).get("reference", "")).startswith("Patient/"):
                add_error(resource, "subject.reference", "must start with Patient/")
            if not _is_valid_iso8601(resource.get("effectiveDateTime"), date_only_allowed=False):
                add_error(resource, "effectiveDateTime", "must be valid ISO 8601 datetime string")

    return {"valid": len(errors) == 0, "errors": errors, "counts": counts}
