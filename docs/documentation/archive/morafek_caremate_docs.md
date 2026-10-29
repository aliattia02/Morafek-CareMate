# Morafek CareMate — 3‑Part Project Overview

---

## Project Structure

```
Morafek-CareMate/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md
│   │   └── feature_request.md
│   ├── workflows/
│   │   └── ci.yml
│   ├── CODEOWNERS
│   └── pull_request_template.md
├── backend/
│   ├── routes/
│   │   ├── auth_routes.py
│   │   ├── clinic_routes.py
│   │   ├── doctor_routes.py
│   │   ├── ehr_routes.py
│   │   ├── medication_routes.py
│   │   ├── metadata_route.py
│   │   ├── monitoring_routes.py
│   │   ├── patient_routes.py
│   │   └── upload_routes.py
│   ├── utils/
│   │   ├── auth.py
│   │   ├── error_handler.py
│   │   └── fhir_de.py
│   ├── config.py
│   ├── main.py
│   └── requirements.txt
├── docs/
│   └── screenshots/
├── mobile/
│   ├── app/
│   │   ├── (app)/
│   │   │   ├── (tabs)/
│   │   │   │   ├── doctor-dashboard.tsx
│   │   │   │   ├── index.tsx
│   │   │   │   └── profile.tsx
│   │   │   ├── ehr/
│   │   │   │   ├── documents.tsx
│   │   │   │   ├── exercise-form.tsx
│   │   │   │   ├── exercises.tsx
│   │   │   │   ├── medications.tsx
│   │   │   │   ├── messages.tsx
│   │   │   │   ├── patient-profile.tsx
│   │   │   │   ├── visit-form.tsx
│   │   │   │   └── visits.tsx
│   │   │   ├── log/
│   │   │   │   └── vitals.tsx
│   │   │   └── settings/
│   │   │       ├── clinics.tsx
│   │   │       └── doctors.tsx
│   │   └── (auth)/
│   │       ├── forgot-password.tsx
│   │       ├── login.tsx
│   │       └── register.tsx
│   ├── components/
│   │   ├── doctor/
│   │   │   ├── ClinicCard.tsx
│   │   │   ├── DoctorList.tsx
│   │   │   ├── PatientDataView.tsx
│   │   │   └── PatientList.tsx
│   │   ├── ehr/
│   │   │   ├── AdherenceHeatmap.tsx
│   │   │   ├── DailySlotCard.tsx
│   │   │   ├── DosageBuilder.tsx
│   │   │   ├── ERezeptFields.tsx
│   │   │   ├── ICD10SearchInput.tsx
│   │   │   ├── MedicationDetailModal.tsx
│   │   │   ├── MedicationPrescriptionPanel.tsx
│   │   │   ├── PZNSearchInput.tsx
│   │   │   └── VisitDetailModal.tsx
│   │   └── ui/
│   │       ├── Button.tsx
│   │       ├── Card.tsx
│   │       ├── Input.tsx
│   │       └── Loading.tsx
│   ├── hooks/
│   │   ├── useApi.ts
│   │   └── useAuth.ts
│   ├── services/
│   │   ├── api/
│   │   │   ├── auth.ts
│   │   │   ├── client.ts
│   │   │   ├── clinics.ts
│   │   │   ├── doctor.ts
│   │   │   ├── ehr.ts
│   │   │   ├── endpoints.ts
│   │   │   ├── icd10.ts
│   │   │   ├── medications.ts
│   │   │   └── profile.ts
│   │   └── offline/
│   │       └── db.ts
│   ├── store/
│   │   └── auth.store.ts
│   ├── types/
│   │   ├── api.ts
│   │   ├── navigation.ts
│   │   └── user.types.ts
│   ├── utils/
│   │   ├── storage.ts
│   │   └── validation.ts
│   ├── constants/
│   │   ├── icd10gm.ts
│   │   ├── pzn_data.ts
│   │   └── theme.ts
│   └── app.json
├── CLA.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE
├── README.md
└── SECURITY.md
```

---

## Part 1: Technical Architecture & Developer Documentation

### 1) Tech Stack & Environment

| Layer | Technology | Version / Notes |
|---|---|---|
| Mobile/Web Frontend | React Native (Expo) | Expo ~54.0.0, React 19.1.0, RN 0.81.5, Expo Router ~6.0.15 |
| State | Zustand | ^5.0.0 |
| API Client | Axios | ^1.15.0 |
| Offline/Storage | Expo SQLite, Expo SecureStore, AsyncStorage | SQLite ~16.0.10, SecureStore ~15.0.7, AsyncStorage 2.2.0 |
| Notifications | Expo Notifications | ~0.32.13 |
| Backend | Flask | 3.1.1 |
| DB Driver | Flask‑PyMongo / PyMongo | 3.0.1 / 4.13.2 |
| Auth | PyJWT | 2.10.1 (HS256) |
| File Storage | Cloudinary | 1.44.1 |
| AI | Google Gemini | google-genai>=1.0.0 (ICD‑10‑GM assist) |
| Hosting | Vercel (web), Render (API) | Render free-tier cold starts handled in client |
| DB | MongoDB Atlas | Primary persistence layer |
| Runtime Requirements | Node.js ≥18, Python ≥3.11 | from project setup |

---

### 2) Architecture Pattern

- **Layered flow:** React Native (Expo) → REST API (Flask) → MongoDB Atlas.
- **Blueprint-based Flask backend:** each domain (auth, EHR, medications, monitoring, clinics, uploads, FHIR metadata) is isolated in a Blueprint and registered in `main.py`.
- **FHIR namespace separation:** `/fhir/*` and `/metadata` are not routed through `/api/*` to ensure FHIR R4 compatibility; `/api/v1/*` is a compatibility proxy to `/api/*`.
- **Storage integration:** Cloudinary holds binary document data; MongoDB stores metadata + FHIR resource bodies.

---

### 3) Data Schema & Entities (MongoDB)

| Collection | Key Fields (type) | Relationships / Notes |
|---|---|---|
| users | _id, username, email, password(hash), first_name, last_name, date_of_birth, user_type (`patient` / `doctor` / `admin`), lanr, avatar_url | Root identity; user_type gates RBAC. |
| ehr_vitals | resourceType=Observation, id(UUID), patient_id, recorded_by, status, category, code, subject, effectiveDateTime, performer, component[] (LOINC BP/HR/weight), extension (urgent/source) | FHIR Observation; LOINC coded vitals. |
| ehr_visits | resourceType=Encounter, id(UUID), patient_id, doctor_id, status, class, participant, period, reasonCode, diagnosis[], note[] | Linked to ehr_conditions via encounter_id. |
| ehr_conditions | resourceType=Condition, id(UUID), patient_id, encounter_id, clinicalStatus, verificationStatus, code (ICD‑10‑GM), recordedDate | Diagnosis tied to visit. |
| ehr_documents | resourceType=DocumentReference, id(UUID), patient_id, uploaded_by, author, type (LOINC), category, subject, date, description, content.attachment.url, cloudinary_public_id | Lab/imaging/prescription docs. |
| ehr_exercises | patient_id, doctor_id, title, description, category, frequency, duration_minutes, repetitions, sets, video_url, image_url, active, order, notes, created_at, last_done_at | Exercise prescriptions. |
| ehr_messages | sender_id, recipient_id, sender_type, recipient_type, body, read, created_at, resourceType=Communication, payload | Secure messaging; system alerts injected. |
| medications | patient_id, doctor_id, visit_id, pzn, trade_name, active_substance, form, strength, norm_size, coverage, dosage_*, dosage_unit, is_chronic, start_date, end_date, periods[], is_active | Medication prescriptions (KBV eRx alignment). |
| med_intakes | medication_id, patient_id, date, slot, status, confirmed_at, note | Adherence tracking + intake confirmation. |
| med_schedules | medication_id, patient_id, date, slots_generated | Schedule bookkeeping. |
| clinics | name, address, phone, description, created_by, created_at, doctors[] | Clinic management + doctor membership. |
| monitoring_alerts | patient_id, sensor_type, value, unit, severity (`info` / `warning` / `critical`), threshold, created_at | IoT/manual sensor alerts. |
| patient_profiles | patient_id, date_of_birth, gender, blood_type, height_cm, weight_kg, allergies[], chronic_conditions[], current_medications[], smoking_status, emergency_contact_*, notes | Clinical profile used in FHIR Patient. |
| patient_fhir_identifiers | patient_id, gkv_kvid, phone, street, postal_code, city | GKV‑KVID & address identifiers for ISiK. |

---

### 4) API Reference (REST + FHIR)

#### Auth & User

| Method | Path | Purpose |
|---|---|---|
| POST | /login | Auth login (JWT) |
| POST | /register | Create account (optional LANR, GKV‑KVID) |
| POST | /api/auth/forgot-password | Request reset code |
| POST | /api/auth/reset-password | Reset password |
| DELETE | /api/auth/delete-account | DSGVO erasure (full data wipe) |
| GET | /api/doctors | List doctors (patient view) |
| GET | /api/patient/authorized-doctors | Patient's authorized doctors |
| POST | /api/patient/authorize-doctor | Add doctor authorization |
| POST | /api/patient/revoke-doctor | Revoke doctor authorization |
| POST | /api/user/avatar | Upload profile image |

#### Doctor/Patient Access

| Method | Path | Purpose |
|---|---|---|
| GET | /api/doctor/patients | Doctor's authorized patient list |

#### EHR (Vitals, Visits, Profiles, Messages, Documents, Exercises)

| Method | Path | Purpose |
|---|---|---|
| GET | /api/patient/profile | Patient home profile |
| GET | /api/patient/medical-profile | Full medical profile |
| GET | /api/patient/vitals | Patient vitals history |
| POST | /api/patient/vitals | Patient vitals entry |
| GET | /api/patient/visits | Patient visit history |
| GET | /api/doctor/patient/:id/vitals | Doctor view vitals |
| POST | /api/doctor/patient/:id/vitals | Doctor-recorded vitals |
| GET | /api/doctor/patient/:id/visits | Doctor view visits |
| POST | /api/doctor/patient/:id/visits | Record visit + ICD‑10‑GM |
| GET | /api/doctor/patient/:id/profile | Doctor view profile |
| PUT | /api/doctor/patient/:id/profile | Update profile |
| GET | /api/messages/conversations | Conversation list |
| GET | /api/messages/unread-count | Unread count |
| GET | /api/messages/:otherId | Message thread |
| POST | /api/messages/:otherId | Send message |
| GET | /api/doctor/patient/:id/messages | Doctor‑patient thread |
| GET | /api/patient/documents | Patient documents |
| POST | /api/patient/documents | Upload document |
| DELETE | /api/patient/documents/:docId | Delete document |
| GET | /api/doctor/patient/:id/documents | Doctor view documents |
| GET | /api/patient/exercises | Patient exercises |
| POST | /api/patient/exercises/:id/done | Mark exercise done |
| POST | /api/doctor/patient/:id/exercises | Prescribe exercise |
| GET | /api/doctor/patient/:id/exercises | List exercises |
| PUT | /api/doctor/patient/:id/exercises/:exId | Update exercise |
| DELETE | /api/doctor/patient/:id/exercises/:exId | Delete exercise |
| POST | /api/ehr/icd10-suggest | ICD‑10‑GM AI Assist |
| GET | /api/ehr/icd10-suggest/test | AI connectivity test |

#### Medications (blueprint prefix `/api/medications`)

| Method | Path | Purpose |
|---|---|---|
| POST | /api/medications/patient/ | Doctor prescribes medication |
| GET | /api/medications/doctor/patient/:id | Doctor list meds |
| PUT | /api/medications/doctor/patient/:id/:medId | Update medication |
| DELETE | /api/medications/doctor/patient/:id/:medId | Deactivate medication |
| PATCH | /api/medications/doctor/patient/:id/:medId/reactivate | Reactivate medication |
| GET | /api/medications/my | Patient meds |
| GET | /api/medications/today | Today's intake schedule |
| POST | /api/medications/intake/ | Confirm intake |
| POST | /api/medications/intake/:intakeId | Confirm intake (alt) |
| POST | /api/medications/patient/:medId/intake | Confirm by med |
| GET | /api/medications/adherence | Adherence analytics |
| GET | /api/medications/fhir/MedicationRequest/ | FHIR R4 MedicationRequest search |

#### Monitoring & Clinics

| Method | Path | Purpose |
|---|---|---|
| POST | /api/monitoring/alert | Create sensor alert |
| GET | /api/monitoring/alerts/ | List alerts (filtered) |
| GET | /api/clinics | List clinics |
| POST | /api/clinics | Create clinic (doctor/admin) |
| GET | /api/clinics/:id | Clinic details + doctors |
| PUT | /api/clinics/:id | Update clinic |
| DELETE | /api/clinics/:id | Delete clinic (admin) |
| POST | /api/clinics/:id/join | Doctor joins clinic |
| POST | /api/clinics/:id/leave | Doctor leaves clinic |
| GET | /api/clinics/:id/doctors | Doctors in clinic |
| GET | /api/doctor/clinics | Clinics for doctor |

#### FHIR & System

| Method | Path | Purpose |
|---|---|---|
| GET | /metadata | FHIR R4 CapabilityStatement (ISiK Stage 1) |
| GET | /fhir/Patient/:id | FHIR Patient read |
| GET | /fhir/Patient | FHIR Patient search |
| GET | /api/patient/fhir-profile | Patient's own FHIR Patient |
| PUT | /api/patient/fhir-identifiers | Store GKV‑KVID + address |
| GET | /api/patient/fhir-export | FHIR document Bundle export (includes MedicationRequest) |
| GET | /api/health | Health check |
| ANY | /api/v1/* | Legacy proxy → /api/* |

> **Note:** `/api/patient/fhir-export` now includes active `MedicationRequest` resources in the Bundle. See §6 (FHIR Export — Medication Update) below.

---

### 5) Security & Compliance Implementation

- **JWT (HS256)** via PyJWT; tokens are issued in `generate_token` and validated in `token_required`.
- **Mobile tokens:** 90‑day expiry when `X-Client-Type: mobile`; web tokens 24 hours.
- **RBAC:** checks on every domain route (patient, doctor, admin).
- **Doctor–patient authorization:** `authorized_doctors` list + `check_doctor_patient_access`.
- **DSGVO (GDPR) erasure:** `/api/auth/delete-account` deletes all clinical collections (vitals, visits, conditions, documents, exercises, messages, identifiers, profiles, **medications**) and removes authorizations.
- **FHIR security posture** declared in CapabilityStatement: JWT bearer with future SMART on FHIR scopes.

---

### 6) FHIR Export — Medication Update

This section documents the changes made to include medication data in the FHIR Bundle export.

#### 6a) New Helper — `utils/fhir_de.py`

A new helper function `build_fhir_medication_request(med_doc)` was added to `utils/fhir_de.py`. It maps a document from the `medications` collection to a FHIR R4 `MedicationRequest` resource.

**Mapped fields:**

| medications field | FHIR R4 MedicationRequest field |
|---|---|
| `_id` | `id` (UUID string) |
| `patient_id` | `subject.reference` (`Patient/<id>`) |
| `trade_name` | `medicationCodeableConcept.text` |
| `active_substance` | `medicationCodeableConcept.coding[].display` |
| `dosage_*` / `dosage_unit` | `dosageInstruction[].text` |
| `start_date` / `end_date` | `dispenseRequest.validityPeriod` |
| `is_active` | `status` (`active` / `stopped`) |
| `is_chronic` | `courseOfTherapyType` |

**Example output structure:**

```json
{
  "resourceType": "MedicationRequest",
  "id": "<med_id>",
  "status": "active",
  "intent": "order",
  "medicationCodeableConcept": {
    "text": "<trade_name>",
    "coding": [{ "display": "<active_substance>" }]
  },
  "subject": { "reference": "Patient/<patient_id>" },
  "dosageInstruction": [{ "text": "<dosage> <dosage_unit>" }],
  "dispenseRequest": {
    "validityPeriod": {
      "start": "<start_date>",
      "end": "<end_date>"
    }
  }
}
```

#### 6b) Updated Export Logic — `routes/ehr_routes.py`

The `export_fhir_bundle` function at `/api/patient/fhir-export` was updated as follows:

1. **Fetch active medications:** Query the `medications` collection for all documents where `patient_id` matches and `is_active` is `true`.
2. **Convert to FHIR:** Each medication document is passed through `build_fhir_medication_request()`.
3. **Append to Bundle:** The resulting `MedicationRequest` resources are appended to `Bundle.entry[]` following the same pattern as existing `Observation` and `Encounter` entries.

**Updated Bundle resource types:**

| Resource Type | Source Collection | Status |
|---|---|---|
| Patient | users + patient_profiles | ✅ Existing |
| Observation | ehr_vitals | ✅ Existing |
| Encounter | ehr_visits | ✅ Existing |
| Condition | ehr_conditions | ✅ Existing |
| DocumentReference | ehr_documents | ✅ Existing |
| MedicationRequest | medications | ✅ **Newly added** |

---

### 7) Offline & Sync Logic

- **SQLite cache** (`expo-sqlite`) with tables: `vitals`, `pending_vitals`, `pending_medication_intakes`, `today_medications_cache`.
- **Queueing:**
  - Vitals: on network failure, record in `pending_vitals`.
  - Medication intake confirmations: stored in `pending_medication_intakes`.
- **Background sync:**
  - Vitals screen attempts sync of queued vitals before new submission.
  - Medications screen drains queued intakes on load/focus; shows "Saved offline" UX.
- **Web fallback:** in-memory DB for Expo web builds; mobile uses SQLite.
- **Caching:** today's medication schedule cached locally for offline display.

---

## Part 2: Clinical Scope & Digital Health Framework

### 1) Clinical Features

- **Visit Recording:** Doctors create FHIR Encounter + Condition; diagnoses stored with ICD‑10‑GM coding and linked to visit.
- **ICD‑10‑GM AI Assist:** `/api/ehr/icd10-suggest` uses Gemini to rank 3–5 ICD‑10‑GM codes from chief complaint/diagnosis hint.
- **Exercise Prescription:** Doctor assigns structured PT plans (frequency, duration, sets, videos), patient marks completion.

### 2) Interoperability Standards

- **FHIR R4:** full patient export as document Bundle (Patient, Observation, Encounter, Condition, DocumentReference, **MedicationRequest**), FHIR Patient read/search, FHIR MedicationRequest search, and `/metadata` CapabilityStatement.
- **ISiK Stage 1 (Basisdaten):** Patient, Encounter, Condition, Observation profiles stamped in `fhir_de.py`.
- **GKV‑KVID support:** stored in `patient_fhir_identifiers`, exposed in FHIR Patient identifiers.
- **LANR:** stored on doctor user record for practitioner identity.
- **LOINC‑coded observations:** BP (55284‑4), systolic (8480‑6), diastolic (8462‑4), HR (8867‑4), weight (29463‑7).

### 3) Vitals Monitoring & Alerts

- **Blood Pressure classification (UI):** Normal / Elevated / High / Crisis with clear action text.
- **Clinical "urgent" logic:** systolic >180 or diastolic >120 marks urgent.
- **Monitoring alerts:** `monitoring_alerts` severity computed from thresholds (Info/Warning/Critical). Critical alerts create a system message to doctor.

### 4) Care Coordination

- **Secure messaging:** patient↔doctor threads with unread counts and conversation lists.
- **Authorization model:** patients explicitly approve doctors; enforced on all doctor‑patient routes.
- **Clinic management:** doctors can create, join, and manage clinics; patients can browse doctors by clinic.

### 5) Medical Record Structure (PHR)

- **Core PHR components:** Vitals, Visits, Diagnoses, Documents (lab, imaging, prescriptions), Exercises, Medications, Messaging.
- **FHIR export:** Bundled Composition + Patient + Observations + Encounters + Conditions + DocumentReferences + **MedicationRequest** for portability.

---

## Part 3: Value Proposition & Project Roadmap

### 1) Core Problem & Solution

Morafek solves healthcare data fragmentation by consolidating patient‑generated health data and clinician records into a single, standards‑compliant PHR with FHIR R4 interoperability.

### 2) User Personas

- **Patients:** track vitals, upload documents, view visit history, and communicate securely.
- **Doctors:** manage authorized patients, record visits with ICD‑10‑GM AI Assist, prescribe exercises and medications.
- **Clinics:** organize doctors into clinics and provide discoverability for patients.

### 3) Strategic Value Props

- **Bilingual support:** Arabic/English UX for broader accessibility.
- **Compliance-first:** DSGVO (GDPR) erasure + FHIR R4 / ISiK Stage 1 standards.
- **Brand identity:** "Morafek" (مُرَافِق) = Companion, emphasizing long‑term patient support.

### 4) Feature Completeness Status

| Status | Features |
|---|---|
| ✅ Complete | Auth, vitals, visits, ICD‑10‑GM AI Assist, documents, exercises, messaging, clinics, doctor authorization, FHIR R4 export (incl. MedicationRequest), DSGVO deletion |
| 🔄 In Progress | Patient self‑edit profile |
| 🔜 Planned | Connected sensors (HR, CGM, SpO2), push notifications, ePA/SMART on FHIR integration |

### 5) Deployment & Infrastructure

| Layer | Service |
|---|---|
| Frontend | Vercel (web) + Expo for iOS/Android |
| Backend | Render (Flask API) with `/api/health` cold‑start recovery |
| Database | MongoDB Atlas |
| Files | Cloudinary |
| AI | Google Gemini for ICD‑10‑GM suggestions |
