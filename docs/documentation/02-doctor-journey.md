# Part 2 — Doctor Journey

> Morafek CareMate · Doctor-facing features: patient management, visits, prescribing, and clinics
> Part of a 3-part documentation set — see [`README.md`](README.md) for the other parts.

---

## Table of Contents

1. [Patient Authorization Model](#1-patient-authorization-model)
2. [Doctor Dashboard](#2-doctor-dashboard)
3. [Recording a Visit](#3-recording-a-visit)
4. [ICD-10-GM AI Suggest](#4-icd-10-gm-ai-suggest)
5. [Prescribing Medications](#5-prescribing-medications)
6. [Sensor Monitoring Alerts](#6-sensor-monitoring-alerts)
7. [Assigning Exercises](#7-assigning-exercises)
8. [Viewing Patient Data](#8-viewing-patient-data)
9. [Clinic Management](#9-clinic-management)
10. [Admin: Facility Reactivation](#10-admin-facility-reactivation)
11. [Registration & German Professional ID](#11-registration--german-professional-id)
12. [Doctor API Reference](#12-doctor-api-reference)

---

## 1. Patient Authorization Model

A doctor cannot see any patient's data by default. Every read is gated by **two independent checks**, both of which must pass:

```
doctor_can_read(doctor, patient) =
    doctor_id in patient.authorized_doctors        ← patient explicitly authorized this doctor
    AND patient_identifiers[patient].doctor_sharing == true   ← patient's master sharing switch is on
```

**Gate 1 — explicit authorization.** The patient adds/removes doctors from their own side (see [Part 1 §10](01-patient-journey.md#10-managing-authorized-doctors--data-sharing)); `authorized_doctors` is an array of doctor ID strings on the patient's user document. `check_doctor_patient_access()` in `doctor_routes.py` enforces this on every doctor-facing route.

**Gate 2 — doctor-sharing toggle.** A second, patient-controlled flag that can *remove* access on top of gate 1, but never grant access gate 1 doesn't already allow. Defaults to `true` for every patient who hasn't touched it, so it never silently cuts off access for the existing patient base. This gate applies uniformly — including to the FHIR `Patient` read/search endpoints, which used to have their own inline authorization check with no doctor-sharing gate at all.

**Admins bypass both gates entirely** — `check_doctor_patient_access()` and the FHIR endpoints all special-case `user_type == "admin"`.

The doctor's own patient list (`GET /api/doctor/patients`) only ever returns patients who've authorized that doctor in the first place — the doctor-sharing flag doesn't need to be checked there since a patient who has turned it off is still "authorized," just not currently readable; the UI is expected to reflect that per-endpoint, not by hiding the patient from the list.

---

## 2. Doctor Dashboard

**Screen:** `(tabs)/doctor-dashboard.tsx` · **Endpoint:** `GET /api/doctor/patients`

On mount, loads the patient list — each card shows name, active conditions, active medications, and an `fhir_identifiers` summary indicating whether a GKV number is on file (`gkv_kvid_stored: bool`, masked preview `gkv_kvid_masked: "A123••••••"`).

Tapping a patient opens `PatientDataView` **inline** — no navigation away from the dashboard. The dashboard also links out to clinic management (`settings/clinics.tsx`).

**Admin view:** admins see every patient (`user_type: "patient"`), not filtered by `authorized_doctors` — this is the same bypass described in §1.

---

## 3. Recording a Visit

**Screen:** `ehr/visit-form.tsx`, opened from `PatientDataView` → "New Visit" (params: `patient_id`, `patient_name`) · **Endpoint:** `POST /api/doctor/patient/<patient_id>/visits`

**Required:** `chief_complaint`, `diagnosis_text`
**Optional:** `diagnosis_icd10` (ICD-10-GM code, ≥3 characters if provided), `notes`, `visit_date` (ISO 8601, defaults to now)

**Two FHIR documents are created atomically:**
1. An `Encounter` in `ehr_visits` — ISiK-profiled, status `finished`, class `AMB` (ambulatory), with an Aufnahmenummer identifier.
2. A `Condition` in `ehr_conditions` — ICD-10-GM coded, ISiK-profiled, stamped with `recordedDate`.

The response includes `id` / `_id` / `encounter_id` (all the same Mongo ObjectId string) — the form reads `visitRes.data?.id ?? visitRes.data?._id` to pass a `visitId` straight into the medication panel below, so a prescription written right after a visit is linked to it.

**Duplicate-submission guard:** the Save button disables itself the instant the first save succeeds (`isVisitSaved = Boolean(successMsg)`), preventing a double-tap from creating two visit records.

---

## 4. ICD-10-GM AI Suggest

Available from the diagnosis field on the visit form: `POST /api/ehr/icd10-suggest`.

Sends `chief_complaint` + an optional `diagnosis_hint` to **Gemini 2.5 Flash** and returns 3–5 ranked ICD-10-GM 2026 suggestions with a German rationale for each. Requires `GEMINI_API_KEY`; returns **503** if the key isn't configured (the form should fall back to manual entry), or **502** with the underlying error `detail` if the Gemini call itself fails. `GET /api/ehr/icd10-suggest/test` is an unauthenticated connectivity check for this integration.

---

## 5. Prescribing Medications

**Component:** `MedicationPrescriptionPanel` · **Endpoint:** `POST /api/medications/patient/`

| Field | Type | Notes |
|---|---|---|
| `patient_id` | string | Must be a valid, authorized patient |
| `pzn` | string | Exactly 8 digits |
| `trade_name`, `active_substance` | string | Required, non-empty |
| `form` | string | Must match the KBV Darreichungsform map (`tablette`, `kapsel`, `tropfen`, …) |
| `strength` | string | e.g. `"500 mg"` |
| `norm_size` | string | `N1` \| `N2` \| `N3` |
| `aut_idem` | bool | Whether generic substitution is allowed |
| `coverage` | string | `GKV` \| `PKV` \| `Selbstzahler` |
| `is_chronic` | bool | Chronic medications carry no `end_date` |
| `start_date` / `end_date` | string | `YYYY-MM-DD`; `end_date` required unless `is_chronic` |
| `dosage_morning/noon/evening/night` | int | Each ≥ 0 |
| `dosage_unit` | string | `Tablette` \| `Kapsel` \| `ml` \| `IE` \| `Hub` \| `Tropfen` |

**Optional:** `dosage_note`, `duration_days`, `visit_id` (validated against `ehr_visits` if supplied — this is how a prescription links back to the visit that generated it).

**Period tracking:** each medication carries a `periods: [{start_date, end_date}]` array. The currently-open period has `end_date: null`.

**Medications are never hard-deleted.** `DELETE /api/medications/doctor/patient/<pid>/<mid>` **deactivates**: sets `is_active: false` and closes the open period with today's date. `PATCH .../reactivate` opens a fresh period and reactivates.

**FHIR export:** active medications become three linked resources — `Medication` (`KBV_PR_ERP_Medication_PZN`), `MedicationRequest` (`KBV_PR_ERP_Prescription`), and one `MedicationStatement` per intake record from the last 90 days.

---

## 6. Sensor Monitoring Alerts

**Endpoint:** `POST /api/monitoring/alert`

**Required:** `patient_id`, `sensor_type`, `value`, `unit`. `message` is optional; `severity` is auto-computed if omitted.

| Sensor type | Warning range | Critical range |
|---|---|---|
| `heart_rate` | 50–100 bpm | 40–130 bpm |
| `glucose` | 70–180 mg/dL | 54–250 mg/dL |
| `spo2` | 94–100% | 90–100% |
| `blood_pressure` | 90–140 mmHg | 80–180 mmHg |

When severity resolves to `critical`, a system-generated message is sent automatically to the **first** doctor in the patient's `authorized_doctors` list (`sender_id: "system"` in `ehr_messages` — the same thread the doctor already reads in [Part 1 §6](01-patient-journey.md#6-messaging-your-doctor)).

`GET /api/monitoring/alerts/?patient_id=<id>` lists alerts — patients see only their own; doctors/admins must supply `patient_id` and must pass the same authorization check as every other patient read.

---

## 7. Assigning Exercises

**Screen:** `ehr/exercise-form.tsx` · **Create:** `POST /api/doctor/patient/<patient_id>/exercises`

**Required:** `title`, `description`, `category` (mobility / strength / balance / breathing / other), `frequency`, `duration_minutes` (positive int), `order` (display ordering).
**Optional:** `repetitions`, `sets`, `video_url`, `image_url`, `active` (default `true`), `notes`.

**Update:** `PUT /api/doctor/patient/<patient_id>/exercises/<exercise_id>` — any subset of fields.
**Delete:** `DELETE /api/doctor/patient/<patient_id>/exercises/<exercise_id>`.

The patient marks these done from their own screen — see [Part 1 §8](01-patient-journey.md#8-exercises).

---

## 8. Viewing Patient Data

All routes below run the same `check_doctor_patient_access()` gate described in §1 (admins bypass it).

| Feature | Endpoint |
|---|---|
| Vitals history | `GET /api/doctor/patient/<id>/vitals` |
| Visit history | `GET /api/doctor/patient/<id>/visits` |
| Medications | `GET /api/medications/doctor/patient/<id>` |
| Medical profile | `GET` / `PUT /api/doctor/patient/<id>/profile` |
| Documents | `GET /api/doctor/patient/<id>/documents` |
| Exercises | `GET /api/doctor/patient/<id>/exercises` |
| Messages | `GET /api/doctor/patient/<id>/messages` |
| Consent status (read-only) | `GET /api/doctor/patient/<id>/consent` |
| FHIR Patient resource | `GET /fhir/Patient/<id>` |

---

## 9. Clinic Management

**Screen:** `settings/clinics.tsx`

Doctors manage their own clinic affiliations — a clinic aggregates a set of doctors and makes them discoverable to patients browsing by clinic (`GET /api/doctors?clinic_id=<id>`, used from the patient's "add a doctor" flow in [Part 1 §10](01-patient-journey.md#10-managing-authorized-doctors--data-sharing)).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/clinics` | List clinics |
| POST | `/api/clinics` | Create a clinic (doctor/admin) |
| GET | `/api/clinics/:id` | Clinic details + member doctors |
| PUT | `/api/clinics/:id` | Update clinic |
| DELETE | `/api/clinics/:id` | Delete clinic (admin) |
| POST | `/api/clinics/:id/join` / `/leave` | Doctor joins/leaves a clinic |
| GET | `/api/clinics/:id/doctors` | Doctors in a clinic |
| GET | `/api/doctor/clinics` | Clinics the current doctor belongs to |

---

## 10. Admin: Facility Reactivation

**Endpoint:** `POST /api/consent/admin/reactivate/<patient_id>` — doctor **or** admin (reversible, non-destructive action, unlike the erasure-approval flow in [Part 3](03-research-admin-consent.md), which is admin-only for exactly that reason).

This is the **only** flow that issues a brand-new research pseudonym for a patient:

```
1. Delete the old pseudonym from gPAS         (hard failure)
2. Create a fresh pseudonym in gPAS           (hard failure)
3. Re-accept consent in gICS under the new one (hard failure; duplicate treated as success)
4. Update users, patient_fhir_identifiers, patient_consents
5. Return { pseudonymSuffix: "XXXX" }
```

Use this when a facility re-enrolls a patient under a genuinely new research cohort that requires a fresh pseudonym. A patient's own self-reactivation (re-granting consent via `POST /api/consent/accept` after revoking) instead returns the **same** pseudonym, since gPAS's create call is idempotent — see [Part 1 §11](01-patient-journey.md#11-research-consent) and [Part 3 §3](03-research-admin-consent.md#3-pseudonym-lifecycle).

This whole flow is skipped when `GPAS_ENABLED=false` (local dev without the full TTP stack) — there is no gPAS pseudonym to delete or recreate.

---

## 11. Registration & German Professional ID

Doctors register the same way patients do (`POST /register`, `user_type: "doctor"`), with one doctor-specific optional field:

**LANR** (Lebenslange Arztnummer) — 9 digits exactly. Stored on the doctor's user document and included as a FHIR `Practitioner` reference inside `MedicationRequest.requester` and `Encounter.participant` — this is what lets a prescription or visit be traced to a specific German practitioner identity in the FHIR export, without a separate `Practitioner` resource lookup.

An invalid LANR returns a 400 with a German validation message.

---

## 12. Doctor API Reference

All routes require `Authorization: Bearer <token>`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/doctor/patients` | Authorized patient list + FHIR ID summary |
| GET/POST | `/api/doctor/patient/<id>/vitals` | Patient vitals history / doctor-recorded reading |
| GET/POST | `/api/doctor/patient/<id>/visits` | Visit history / record a visit (Encounter + Condition) |
| GET/PUT | `/api/doctor/patient/<id>/profile` | Medical profile |
| GET | `/api/doctor/patient/<id>/documents` | Patient documents |
| GET/POST/PUT/DELETE | `/api/doctor/patient/<id>/exercises[/<eid>]` | Exercise CRUD |
| GET | `/api/doctor/patient/<id>/messages` | Doctor–patient thread |
| GET | `/api/doctor/patient/<id>/consent` | Consent status (read-only) |
| POST | `/api/ehr/icd10-suggest` | Gemini ICD-10-GM AI suggestions |
| GET | `/api/ehr/icd10-suggest/test` | AI connectivity test *(no auth)* |
| POST | `/api/medications/patient/` | Prescribe medication |
| GET | `/api/medications/doctor/patient/<id>` | Patient medications |
| PUT/DELETE/PATCH | `/api/medications/doctor/patient/<pid>/<mid>[/reactivate]` | Update / deactivate / reactivate |
| POST | `/api/monitoring/alert` | Record sensor alert |
| GET | `/api/monitoring/alerts/` | List alerts (must supply `patient_id`) |
| GET/POST | `/api/clinics`, `/api/clinics/:id[/join|/leave]`, `/api/doctor/clinics` | Clinic management |
| GET | `/fhir/Patient/<id>` | FHIR Patient read |
| GET | `/fhir/Patient?name=&birthdate=&gender=&identifier=` | FHIR Patient search (ISiK Stage 1, doctor/admin) |
| POST | `/api/consent/admin/reactivate/<id>` | Facility reactivation (new pseudonym) — doctor or admin |

For the patient-side counterparts (`/api/patient/...`), see [Part 1 §16](01-patient-journey.md#16-patient-api-reference). For researcher and admin routes (`/api/research/*`, `/api/admin/*`), see [Part 3](03-research-admin-consent.md).
