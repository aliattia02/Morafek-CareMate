# Morafek CareMate — FHIR-Native Care Coordination Platform

> **A full-stack clinical EHR built from scratch:** manual HL7 FHIR R4 resource construction, automated clinical severity monitoring, and consent-gated role-based access — deployed to production on Render (backend) and Vercel (frontend).

[![Live Demo](https://img.shields.io/badge/Live%20Demo-morafek--care--mate.vercel.app-0F6E56?style=flat-square)](https://morafek-care-mate.vercel.app)
[![Backend](https://img.shields.io/badge/API-morafek--api.onrender.com-185FA5?style=flat-square)](https://morafek-api.onrender.com/api/health)
[![Stack](https://img.shields.io/badge/Stack-Flask%20%7C%20MongoDB%20%7C%20React%20Native-444?style=flat-square)](#tech-stack)
[![Standards](https://img.shields.io/badge/Standards-HL7%20FHIR%20R4%20%7C%20LOINC%20%7C%20ICD--10--GM-1D9E75?style=flat-square)](#clinical-standards)

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [The Clinical Problem Solved](#the-clinical-problem-solved)
3. [Architecture](#architecture)
4. [Key Architectural & Clinical Decisions](#key-architectural--clinical-decisions)
5. [Clinical Standards Implemented](#clinical-standards)
6. [Tech Stack](#tech-stack)
7. [Features](#features)
8. [API Reference](#api-reference)
9. [Data Models](#data-models)
10. [Monitoring & Alert Thresholds](#monitoring--alert-thresholds)
11. [Offline Support](#offline-support)
12. [Configuration & Environment Variables](#configuration--environment-variables)
13. [Getting Started](#getting-started)
14. [Project Structure](#project-structure)
15. [Known Limitations & Roadmap](#known-limitations--roadmap)
16. [Portfolio Context](#portfolio-context)

---

## Project Overview

Morafek CareMate is a clinically grounded, standards-compliant care coordination platform connecting patients with their authorized physicians. It implements HL7 FHIR R4 resources manually at the application layer — without a dedicated FHIR server — across a Python/Flask REST backend and a React Native (Expo) mobile application.

**Core capabilities at a glance:**

- Vitals logging with automated severity classification against clinical reference ranges
- Doctor–patient messaging with critical-alert auto-escalation into the clinical thread
- Exercise prescription, assignment, and patient compliance tracking
- Clinical document management with LOINC-coded categories and Cloudinary storage
- ICD-10-GM coded visit records stored as FHIR Encounter + Condition pairs
- Full FHIR R4 Bundle document export of a patient's complete health record
- Offline-capable mobile app with local SQLite caching and a pending-sync queue
- Patient-controlled doctor authorization model (consent-gated access, instantly revocable)

---

## The Clinical Problem Solved

Outpatient care in fragmented health systems breaks down at the handoff point. Doctors lose visibility into patient vitals between visits; patients have no structured channel to escalate deteriorating readings; clinical documents — prescriptions, lab reports, imaging — live in silos with no coded metadata that makes them computable or portable.

The deeper issue is data standards. Most small-to-mid clinic software stores health data in proprietary schemas, making interoperability expensive later and regulatory compliance harder still. Morafek CareMate demonstrates that a lean engineering team can deliver a clinically credible, standards-compliant coordination platform — without a dedicated FHIR server — by constructing HL7 FHIR R4 resources at the application layer and enforcing consent-based access at every API boundary.

The result: a patient's full health record can be exported as a standards-compliant FHIR R4 Bundle at any time, automated alerts escalate critical sensor readings directly into the clinical messaging thread, and every document is LOINC-coded for downstream interoperability.

---

## Architecture

```
┌────────────────────────────────────┐      ┌─────────────────────────────────────┐
│         Mobile App (Expo)          │      │          Backend (Flask)             │
│                                    │      │                                     │
│  ┌──────────┐  ┌─────────────────┐ │      │  ┌───────────────────────────────┐  │
│  │  (auth)  │  │     (app)       │ │      │  │  Routes                       │  │
│  │  login   │  │  (tabs)/        │ │◄────►│  │  auth · patient · doctor      │  │
│  │  register│  │  ehr/           │ │ REST │  │  ehr · monitoring · upload    │  │
│  │  forgot  │  │  log/           │ │ JWT  │  │  clinic                       │  │
│  └──────────┘  │  settings/      │ │      │  └──────────────┬────────────────┘  │
│                └─────────────────┘ │      │                 │                   │
│  ┌─────────────────────────────┐   │      │  ┌──────────────▼────────────────┐  │
│  │  Zustand Auth Store         │   │      │  │  MongoDB Atlas                │  │
│  │  expo-secure-store          │   │      │  │  FHIR R4 resource shapes      │  │
│  │  expo-sqlite (offline)      │   │      │  └───────────────────────────────┘  │
│  └─────────────────────────────┘   │      │                                     │
└────────────────────────────────────┘      │  ┌───────────────────────────────┐  │
                                            │  │  Cloudinary                   │  │
                                            │  │  avatars · documents          │  │
                                            │  └───────────────────────────────┘  │
                                            └─────────────────────────────────────┘
```

**Key design decisions:**

- FHIR R4 resources are constructed manually at the application layer — no external FHIR server dependency
- Role-based access is encoded in the JWT and enforced server-side on every protected route
- Patients explicitly authorize each doctor; access is revocable at any time
- Mobile tokens: 90-day lifespan (clinically motivated). Web tokens: 24-hour lifespan
- Exponential backoff (4 retries, capped at 15 s) on 503/504 and network errors — vitals submissions survive flaky connections silently

---

## Key Architectural & Clinical Decisions

### 1. Manual FHIR R4 construction vs. a FHIR server

A hosted FHIR server (HAPI, Azure FHIR) introduces infrastructure cost, vendor lock-in, and latency for a lean system. By constructing `Observation`, `Encounter`, `Condition`, `DocumentReference`, and `Communication` resources at the application layer in MongoDB, the system remains fully portable. Any future FHIR server migration is a serialization step, not a re-architecture.

### 2. Patient-controlled doctor authorization (consent model)

Each doctor must be individually authorized by the patient before gaining any data access — access can be revoked instantly. This maps directly to GDPR Article 9 explicit consent requirements and the HIPAA minimum-necessary principle. The `admin` role bypasses this (super-doctor access) for clinical oversight scenarios.

### 3. 90-day mobile tokens vs. 24-hour web tokens

Chronic care patients access health apps daily over months. Forcing re-authentication every 24 hours on mobile creates abandonment — the single biggest driver of poor engagement in digital therapeutics targeting elderly or chronically ill populations. The 90-day mobile token lifetime is a clinical UX decision, signaled by the `X-Client-Type: mobile` header.

### 4. Hardcoded clinical severity thresholds

Alert thresholds for heart rate, glucose, SpO₂, and blood pressure are derived from established clinical reference ranges, not from user preferences. Making them end-user configurable without clinical oversight creates liability in a DiGA/CE-marked context. The `critical` tier automatically escalates into the patient's primary doctor message thread as a system Communication resource.

### 5. LOINC-coded document categories

Documents are stored as FHIR `DocumentReference` with LOINC codes: lab reports `11502-2`, imaging `18748-4`, prescriptions `57833-6`, other `34133-9`. A receiving system — hospital EHR, insurance portal, national health record — can classify and route these documents without manual triage. Plain-text categories would break interoperability at the first system boundary.

### 6. ICD-10-GM codes — optional, not mandatory

Mandatory coding creates friction at the point of care. Optional coding with free-text fallback supports the full spectrum of use. The FHIR `Encounter` + `Condition` pair preserves both: structured ICD-10-GM when available, narrative diagnosis text always.

### 7. Offline SQLite with typed pending queue

Patients with poor connectivity should never lose a vitals entry. The `pending_vitals` SQLite table stores readings locally for sync on reconnect. Missing readings can obscure a deteriorating BP trend — this is a clinical safety design choice, not a UX convenience.

---

## Clinical Standards

| Standard | Where implemented | Clinical purpose |
|---|---|---|
| **HL7 FHIR R4** | All EHR collections. Full Bundle export endpoint. | Interoperability baseline for exchange with hospitals, insurers, and national registries. |
| **LOINC** | Vitals Observations (`8480-6` systolic, `8462-4` diastolic, `8867-4` pulse). Document categories (`11502-2`, `18748-4`, `57833-6`, `34133-9`). | Enables receiving systems to auto-classify clinical data without manual mapping. |
| **ICD-10-GM** | Optional `diagnosis_icd10` field on FHIR Condition resources linked to Encounters. | German statutory billing, DRG grouping, and epidemiological reporting compatibility. |
| **FHIR Bundle (document)** | `GET /api/patient/fhir-export` — constructs a Bundle containing all patient resources. | Portable patient record for specialist referrals, second opinions, and emergency handoffs. |
| **FHIR Communication** | `ehr_messages` collection — all messages stored as Communication resources. | Preserves clinical communication as a computable audit trail, not a plain chat log. |
| **OMOP CDM** | MongoDB schema is flat and typed — ETL to OMOP is a mapping step, not a re-architecture. | Enables cohort analytics, RWE studies, and federated research network participation. |
| **SNOMED CT** | FHIR Condition coding array is extensible. ICD-10-GM can be supplemented without schema change. | Post-coordination coding and semantic interoperability for clinical decision support. |

---

## Tech Stack

### Backend

| Package | Version | Clinical relevance |
|---|---|---|
| Flask | 3.1.1 | Thin, auditable API layer — every route is readable by a clinical informatics auditor. |
| Flask-PyMongo | 3.0.1 | MongoDB integration mapping directly to FHIR resource shapes. |
| flask-cors | 6.0.1 | Regex-based origin validation — production Vercel preview URLs handled without manual updates. |
| pymongo[srv] | 4.13.2 | MongoDB Atlas driver with SRV connection string support. |
| PyJWT | 2.10.1 | HS256-signed tokens with role, expiry, and client-type claims. |
| bcrypt | 4.2.1 | Password hashing. The baseline for credential security in a health data system. |
| cloudinary | 1.44.1 | HIPAA-eligible file storage. Hard-delete on document removal — right-to-erasure by design. |
| gunicorn | 25.1.0 | Production WSGI server for Render deployment. |
| python-dotenv | 1.2.1 | Environment variable management — no credentials in source. |

### Mobile

| Package | Version | Purpose |
|---|---|---|
| react-native | 0.81.5 | Cross-platform mobile framework |
| expo | ~54.0.0 | Build toolchain |
| expo-router | ~6.0.15 | File-based navigation |
| expo-sqlite | ~16.0.10 | On-device offline database (vitals cache + pending queue) |
| expo-secure-store | ~15.0.7 | Hardware-backed encrypted JWT storage |
| zustand | ^5.0.0 | Global auth state management |
| axios | ^1.15.0 | HTTP client with exponential backoff retry logic |
| expo-image-picker | ~17.0.10 | Avatar and document selection |
| expo-document-picker | ~13.0.3 | PDF document selection |
| victory-native | ^37.3.6 | Clinical data visualization |
| date-fns | ^4.1.0 | Date formatting |
| typescript | ~5.9.2 | Type safety across the entire mobile codebase |

---

## Features

### Authentication & User Management

| Flow | Endpoint | Details |
|---|---|---|
| Login | `POST /login` | Returns JWT + user data (name, profile picture) |
| Register | `POST /register` | Creates account; rejects duplicate username or email |
| Forgot Password | `POST /api/auth/forgot-password` | 6-digit code, 15-min expiry; always returns 200 (anti-enumeration) |
| Reset Password | `POST /api/auth/reset-password` | Verifies code, updates password hash, clears code fields |

> Note: Email delivery is not yet implemented. Reset codes are logged server-side only.

**Token management:** JWT signed with HS256; contains `user_id`, `user_type`, `exp`, `mobile` claims. Mobile clients (`X-Client-Type: mobile`) receive 90-day tokens; web clients receive 24-hour tokens. Stored in `expo-secure-store` (encrypted) on device; falls back to in-memory map on web. The Zustand auth store validates `exp` on startup and clears expired tokens automatically.

**User roles:**

| Role | Access |
|---|---|
| `patient` | Own health data only; can authorize/revoke doctors |
| `doctor` | Patients who have explicitly authorized them |
| `admin` | All patients without authorization (clinical oversight) |

---

### Patient Features

- Home screen: most-recent BP reading with status badge (Normal / Elevated / High / Crisis), most-recent visit summary, SOS button (direct dial 112)
- Log vitals: systolic BP, diastolic BP, pulse, optional weight — stored as FHIR R4 Observations
- View own visit history, documents, exercises, and messages
- Mark exercises done/not-done (sets/unsets `last_done_at`)
- Authorize or revoke doctor access from the Settings screen
- Export full EHR as a FHIR R4 Bundle document

---

### Doctor Features

- Searchable list of authorized patients only
- 6-tab patient detail view: Overview, Visits, Vitals, Documents, Exercises, Messages
- Record vitals on behalf of a patient
- Record a visit with chief complaint, free-text diagnosis, optional ICD-10-GM code, and notes — stored as FHIR Encounter + Condition pair
- Assign, update, and delete exercise prescriptions
- Direct message thread per patient

---

### EHR Module

**Visits** — stored as FHIR `Encounter` + linked `Condition`:

| Field | Notes |
|---|---|
| `chief_complaint` | Required |
| `diagnosis_text` | Free-text clinical summary |
| `diagnosis_icd10` | Optional ICD-10-GM code |
| `notes` | Additional clinical notes |
| `status` | Fixed: `finished` |
| `class` | Fixed: `AMB` (ambulatory) |

**Documents** — stored as FHIR `DocumentReference`:

| Category | LOINC Code |
|---|---|
| Lab report | `11502-2` |
| Imaging | `18748-4` |
| Prescription | `57833-6` |
| Other | `34133-9` |

Allowed formats: JPEG, PNG, WebP, PDF. Max size: 10 MB. Deletion removes from Cloudinary before removing the database record.

**Exercises** — prescribed by doctors, tracked by patients:

| Field | Notes |
|---|---|
| `category` | `mobility` / `strength` / `balance` / `breathing` / `other` |
| `frequency` | Free string (e.g. "3 times daily") |
| `duration_minutes` | Integer |
| `repetitions` / `sets` | Optional |
| `video_url` / `image_url` | Optional media links |
| `active` | Boolean — patients only see active exercises |
| `order` | Integer — controls display order |

**Messages** — stored as FHIR `Communication` resources. System-generated messages are inserted automatically when a monitoring alert reaches `critical` severity.

---

## API Reference

### Authentication (`auth_routes.py`)

| Method | Path | Description |
|---|---|---|
| `POST` | `/login` | Login; returns JWT + user data |
| `POST` | `/register` | Register new user |
| `GET` | `/api/doctors` | List all doctors (patients only) |
| `GET` | `/api/patient/authorized-doctors` | Get patient's authorized doctors |
| `POST` | `/api/patient/authorize-doctor` | Add doctor to authorized list |
| `POST` | `/api/patient/revoke-doctor` | Remove doctor from authorized list |
| `POST` | `/api/auth/forgot-password` | Request password-reset code |
| `POST` | `/api/auth/reset-password` | Verify code and set new password |

### Patient (`patient_routes.py`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/patient/profile` | Get patient profile (name, email, EHR profile) |

### Doctor (`doctor_routes.py`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/doctor/patients` | Get authorized patient list |

### EHR (`ehr_routes.py`)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/patient/vitals` | Patient records own vitals |
| `GET` | `/api/patient/vitals` | Patient views own vitals |
| `POST` | `/api/doctor/patient/<id>/vitals` | Doctor records vitals for patient |
| `GET` | `/api/doctor/patient/<id>/vitals` | Doctor views patient vitals |
| `GET` | `/api/patient/visits` | Patient views own visit history |
| `POST` | `/api/doctor/patient/<id>/visits` | Doctor records a visit |
| `GET` | `/api/doctor/patient/<id>/visits` | Doctor views patient visits |
| `GET` | `/api/messages/conversations` | List all conversation threads |
| `GET` | `/api/messages/unread-count` | Count unread messages |
| `GET` | `/api/messages/<other_user_id>` | Get thread with a specific user |
| `POST` | `/api/messages/<other_user_id>` | Send a message |
| `GET` | `/api/doctor/patient/<id>/messages` | Doctor views thread with patient |
| `GET` | `/api/patient/documents` | Patient views own documents |
| `POST` | `/api/patient/documents` | Patient uploads a document |
| `DELETE` | `/api/patient/documents/<doc_id>` | Patient deletes own document |
| `GET` | `/api/doctor/patient/<id>/documents` | Doctor views patient documents |
| `POST` | `/api/doctor/patient/<id>/exercises` | Doctor assigns exercise |
| `GET` | `/api/doctor/patient/<id>/exercises` | Doctor lists patient exercises |
| `PUT` | `/api/doctor/patient/<id>/exercises/<ex_id>` | Doctor updates exercise |
| `DELETE` | `/api/doctor/patient/<id>/exercises/<ex_id>` | Doctor deletes exercise |
| `GET` | `/api/patient/exercises` | Patient views own active exercises |
| `POST` | `/api/patient/exercises/<id>/done` | Patient marks exercise done/not-done |
| `GET` | `/api/patient/fhir-export` | Export full EHR as FHIR R4 Bundle |

### Monitoring (`monitoring_routes.py`)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/monitoring/alert` | Record sensor alert (severity auto-computed) |
| `GET` | `/api/monitoring/alerts/` | List alerts (filterable by sensor type and severity) |

### Upload (`upload_routes.py`)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/user/avatar` | Upload profile picture to Cloudinary |

---

## Data Models

### User

```json
{
  "username": "string",
  "email": "string",
  "password_hash": "string",
  "user_type": "patient | doctor | admin",
  "firstName": "string",
  "lastName": "string",
  "dateOfBirth": "string",
  "profile_picture_url": "string",
  "authorized_doctors": ["doctor_id"],
  "ehr_profile": {
    "blood_type": "string",
    "allergies": ["string"],
    "chronic_conditions": ["string"],
    "emergency_contact": "string"
  }
}
```

### FHIR Observation (Vitals)

```json
{
  "resourceType": "Observation",
  "patient_id": "string",
  "doctor_id": "string | null",
  "component": [
    { "code": { "coding": [{ "system": "http://loinc.org", "code": "8480-6" }] }, "valueQuantity": { "value": 120, "unit": "mmHg" } },
    { "code": { "coding": [{ "system": "http://loinc.org", "code": "8462-4" }] }, "valueQuantity": { "value": 80, "unit": "mmHg" } },
    { "code": { "coding": [{ "system": "http://loinc.org", "code": "8867-4" }] }, "valueQuantity": { "value": 72, "unit": "/min" } }
  ],
  "notes": "string",
  "created_at": "datetime"
}
```

### FHIR Encounter (Visit)

```json
{
  "resourceType": "Encounter",
  "status": "finished",
  "class": "AMB",
  "patient_id": "string",
  "doctor_id": "string",
  "chief_complaint": "string",
  "diagnosis_icd10": "string | null",
  "visit_date": "datetime",
  "notes": "string"
}
```

### FHIR Condition (Diagnosis)

```json
{
  "resourceType": "Condition",
  "encounter_fhir_id": "string",
  "patient_id": "string",
  "doctor_id": "string",
  "diagnosis_text": "string",
  "diagnosis_icd10": "string | null"
}
```

### Monitoring Alert

```json
{
  "patient_id": "string",
  "sensor_type": "heart_rate | glucose | spo2 | blood_pressure",
  "value": "number",
  "unit": "string",
  "severity": "warning | critical",
  "message": "string",
  "created_at": "datetime"
}
```

---

## Monitoring & Alert Thresholds

Severity is computed automatically against clinically established reference ranges. If not provided in the request, it is derived server-side.

| Sensor | Normal | Warning | Critical |
|---|---|---|---|
| Heart rate | 60–100 bpm | 50–100 bpm | < 40 or > 130 bpm |
| Glucose | 70–140 mg/dL | 70–180 mg/dL | < 54 or > 250 mg/dL |
| SpO₂ | ≥ 94% | 94–100% | < 90% |
| Blood pressure | 90–140 mmHg | 90–140 mmHg | < 80 or > 180 mmHg |

When severity is `critical`, a system-generated `Communication` resource is automatically inserted into the patient's message thread with their first authorized doctor.

---

## Offline Support

Uses `expo-sqlite` on iOS/Android with an in-memory object fallback on web.

| SQLite table | Purpose |
|---|---|
| `vitals` | Cache of server-returned vitals (last 50 records) |
| `visits` | Table exists; populate/read not yet implemented |
| `pending_vitals` | Queue for vitals submitted while offline |

**Sync behavior:** The patient home screen caches vitals after a successful API fetch and reads from SQLite when the network call fails. A background sync loop for `pending_vitals` is scaffolded (`queueVital`, `getPendingVitals`) but not yet wired to any screen.

---

## Configuration & Environment Variables

### Backend

| Variable | Required | Purpose |
|---|---|---|
| `MONGO_URI` | ✅ | MongoDB Atlas connection string |
| `SECRET_KEY` | ✅ | JWT signing secret |
| `CLOUDINARY_CLOUD_NAME` | ✅ | Cloudinary account name |
| `CLOUDINARY_API_KEY` | ✅ | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | ✅ | Cloudinary API secret |

The application refuses to start if `MONGO_URI` or `SECRET_KEY` are absent.

CORS allowed origins are configured in `config.py` with a regex-based approach that covers all Vercel preview deployments automatically:

```python
ALLOWED_ORIGIN_PATTERNS = [
    re.compile(r"^https://morafek-care-mate.*\.vercel\.app$"),
    re.compile(r"^https://morafek.*\.vercel\.app$"),
]
```

### Mobile

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_API_URL` | Backend base URL (e.g. `https://morafek-api.onrender.com`) |
| `EXPO_PUBLIC_API_VERSION` | API version string (default `v1`; versioned routing currently disabled) |

---

## Getting Started

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate       # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env           # fill in all required variables
python main.py
```

API starts on `http://localhost:5000`. Health check: `GET /api/health`.

### Mobile

```bash
cd mobile
npm install
cp .env.example .env           # set EXPO_PUBLIC_API_URL
npx expo start
```

Press `i` for iOS simulator, `a` for Android emulator, or scan the QR code with the Expo Go app.

---

## Project Structure

```
Morafek-CareMate/
├── backend/
│   ├── routes/
│   │   ├── auth_routes.py          # Login, register, password reset, doctor listing
│   │   ├── patient_routes.py       # Patient profile
│   │   ├── doctor_routes.py        # Doctor patient list
│   │   ├── ehr_routes.py           # Vitals, visits, documents, exercises, messages, FHIR export
│   │   ├── monitoring_routes.py    # Sensor alerts with severity computation
│   │   ├── clinic_routes.py        # Clinic management
│   │   └── upload_routes.py        # Avatar upload
│   ├── utils/
│   │   ├── auth.py                 # JWT creation, token validation, role enforcement
│   │   └── error_handler.py        # Centralised error responses
│   ├── config.py                   # Environment config, CORS, token lifetimes
│   ├── main.py                     # App entry point, blueprint registration
│   └── requirements.txt
│
└── mobile/
    ├── app/
    │   ├── (auth)/                 # login, register, forgot-password screens
    │   └── (app)/
    │       ├── (tabs)/             # Home, Doctor Dashboard, Profile
    │       ├── ehr/                # Visits, Documents, Exercises, Messages, Patient Profile
    │       ├── log/                # Vitals logging
    │       └── settings/           # Doctor management
    ├── components/
    │   ├── ui/                     # Button, Card, Input, Loading
    │   └── doctor/                 # PatientList, DoctorList, PatientDataView
    ├── hooks/                      # useAuth, useApi, useApiEffect, useSimpleApi
    ├── services/
    │   ├── api/                    # auth, doctor, ehr, profile, client, endpoints
    │   └── offline/db.ts           # SQLite offline cache
    ├── store/auth.store.ts         # Zustand global auth state
    ├── utils/                      # Validation, secure storage, time utilities
    ├── types/                      # TypeScript type definitions
    └── constants/                  # Theme, elderly theme
```

---

## Known Limitations & Roadmap

| Area | Status | Notes |
|---|---|---|
| Password reset email | Not implemented | Reset codes are logged server-side only |
| Token refresh | Stub | `refreshToken()` returns `null`; re-login required after expiry |
| Patient EHR profile update | Not implemented | Profile fields can only be set at registration |
| Offline vitals sync loop | Scaffolded | `queueVital` and `getPendingVitals` exist; sync-on-reconnect not wired |
| Visit history in SQLite | Not implemented | Table exists; no populate or read function |
| Connected Sensors UI | Placeholder | CGM/wearable integration not yet implemented |
| Push notifications | Package installed | `expo-notifications` present; no server-side trigger logic yet |

---

## Portfolio Context

This project was built as the primary technical artifact of an M.Sc. in Digital Health, supervised by **Prof. Dr. med. Klaus G. Parhofer** at LMU Munich, and targets readiness for the German **DiGA framework** (Digitale Gesundheitsanwendungen) and **CE Class IIa** medical device software certification.

### Clinical standards coverage

- HL7 FHIR R4 — 6 resource types implemented (Observation, Encounter, Condition, DocumentReference, Communication, Bundle)
- LOINC — 7 codes mapped across vitals and document categories
- ICD-10-GM — optional diagnosis coding on every visit record
- OMOP CDM — ETL-ready flat schema; no structural changes required
- SNOMED CT — extensibility built into the Condition coding array

### What this codebase demonstrates

For **digital health startups:** Full-stack clinical platform delivery in a solo engineering capacity — from MongoDB schema design through FHIR R4 resource construction, consent-gated access control, automated alert severity computation, and a production-deployed offline-capable mobile app.

For **hospital IT departments:** Standards-compliant data architecture — every clinical entity is a typed FHIR resource, every document is LOINC-coded, every visit optionally ICD-10-GM coded, and the patient record exports as a FHIR R4 Bundle document on demand. The access model enforces explicit patient consent with instant revocation.

For **health-tech integration consultancies:** End-to-end implementation of FHIR R4, LOINC, and ICD-10-GM — with OMOP CDM and SNOMED CT extensibility — authored by a contributor who holds both a pharmacy qualification and an M.Sc. in Digital Health, working at the intersection of clinical domain knowledge and production software engineering.

---

*Built by Ali — M.Sc. Digital Health · Pharmacy · Clinical Informatics · LMU Munich*
