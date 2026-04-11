# Morafek-CareMate

A full-stack Electronic Health Record (EHR) platform built for care coordination between patients and doctors. The system implements HL7 FHIR R4 resources manually — without a pre-built FHIR server — across a Python/Flask backend and a React Native (Expo) mobile application.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)
- [Features](#features)
  - [Authentication & User Management](#authentication--user-management)
  - [Patient Features](#patient-features)
  - [Doctor Features](#doctor-features)
  - [EHR Module](#ehr-module)
  - [Monitoring & Alerts](#monitoring--alerts)
  - [File & Document Upload](#file--document-upload)
  - [Offline Support](#offline-support)
- [FHIR R4 Implementation](#fhir-r4-implementation)
- [API Reference](#api-reference)
- [Data Models](#data-models)
- [Configuration & Environment Variables](#configuration--environment-variables)
- [Getting Started](#getting-started)

---

## Overview

Morafek-CareMate is a clinical-grade care coordination platform that connects patients with their authorized doctors. Key capabilities include:

- Vitals logging with automated severity classification
- Doctor–patient messaging with critical-alert escalation
- Exercise prescription and compliance tracking
- Clinical document management with LOINC-coded categories
- ICD-10-GM coded visit records stored as FHIR Encounters
- Full FHIR R4 Bundle export of a patient's complete health record
- Offline-capable mobile app with local SQLite caching

---

## Architecture

```
┌─────────────────────────────────┐      ┌──────────────────────────────────┐
│        Mobile App (Expo)        │      │        Backend (Flask)           │
│                                 │      │                                  │
│  ┌──────────┐  ┌─────────────┐  │      │  ┌──────────────────────────┐   │
│  │  (auth)  │  │    (app)    │  │      │  │  Routes                  │   │
│  │  login   │  │  (tabs)     │  │◄────►│  │  auth / patient /        │   │
│  │  register│  │  ehr/       │  │ REST │  │  doctor / ehr /          │   │
│  │  forgot  │  │  log/       │  │ JWT  │  │  monitoring / upload     │   │
│  └──────────┘  │  settings/  │  │      │  └────────────┬─────────────┘   │
│                └─────────────┘  │      │               │                 │
│  ┌──────────────────────────┐   │      │  ┌────────────▼─────────────┐   │
│  │  Zustand Auth Store      │   │      │  │  MongoDB Atlas           │   │
│  │  expo-secure-store       │   │      │  │  FHIR R4 resource shapes │   │
│  │  expo-sqlite (offline)   │   │      │  └──────────────────────────┘   │
│  └──────────────────────────┘   │      │                                  │
└─────────────────────────────────┘      │  ┌──────────────────────────┐   │
                                         │  │  Cloudinary              │   │
                                         │  │  avatars / documents     │   │
                                         │  └──────────────────────────┘   │
                                         └──────────────────────────────────┘
```

**Key design decisions:**
- FHIR R4 resources are constructed manually at the application layer — no external FHIR server dependency
- Role-based access is encoded in the JWT and enforced server-side on every protected route
- Patients explicitly authorize each doctor; access can be revoked at any time
- Mobile tokens have a 90-day lifespan; web tokens expire after 24 hours

---

## Project Structure

```
Morafek-CareMate/
├── backend/                        # Python/Flask API
│   ├── routes/
│   │   ├── auth_routes.py          # Login, register, password reset, doctor listing
│   │   ├── patient_routes.py       # Patient profile
│   │   ├── doctor_routes.py        # Doctor patient list
│   │   ├── ehr_routes.py           # Vitals, visits, documents, exercises, messages, FHIR export
│   │   ├── monitoring_routes.py    # Sensor alerts with severity computation
│   │   └── upload_routes.py        # Avatar upload
│   ├── utils/
│   │   ├── auth.py                 # JWT creation, token validation, role enforcement
│   │   └── error_handler.py        # Centralised error responses
│   ├── config.py                   # Environment config, CORS origins, token lifetimes
│   ├── main.py                     # App entry point, blueprint registration
│   └── requirements.txt
│
└── mobile/                         # React Native / Expo app
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

## Tech Stack

### Backend

| Package | Version | Purpose |
|---|---|---|
| Flask | 3.1.1 | Web framework |
| Flask-PyMongo | 3.0.1 | MongoDB integration |
| flask-cors | 6.0.1 | Cross-origin request handling |
| pymongo[srv] | 4.13.2 | MongoDB driver |
| PyJWT | 2.10.1 | JWT signing and verification |
| bcrypt | 4.2.1 | Password hashing |
| cloudinary | 1.44.1 | File storage (avatars, documents) |
| gunicorn | 25.1.0 | Production WSGI server |
| python-dotenv | 1.2.1 | Environment variable loading |
| Werkzeug | 3.1.3 | WSGI utilities |

### Mobile

| Package | Version | Purpose |
|---|---|---|
| react-native | 0.81.5 | Mobile framework |
| expo | ~54.0.0 | Build toolchain |
| expo-router | ~6.0.15 | File-based navigation |
| expo-sqlite | ~16.0.10 | Local offline database |
| expo-secure-store | ~15.0.7 | Encrypted token storage |
| zustand | ^5.0.0 | Global state management |
| axios | ^1.15.0 | HTTP client with retry logic |
| expo-image-picker | ~17.0.10 | Avatar & document selection |
| expo-document-picker | ~13.0.3 | PDF document selection |
| react-native-chart-kit | ^6.12.0 | Health data charts |
| victory-native | ^37.3.6 | Advanced data visualisation |
| date-fns | ^4.1.0 | Date formatting |
| typescript | ~5.9.2 | Type safety |

---

## Features

### Authentication & User Management

**Auth flows**

| Flow | Endpoint | Details |
|---|---|---|
| Login | `POST /login` | Returns JWT + user data (name, profile picture) |
| Register | `POST /register` | Creates account; rejects duplicate username or email |
| Forgot Password | `POST /api/auth/forgot-password` | Generates 6-digit code (15-min expiry); always returns 200 (anti-enumeration) |
| Reset Password | `POST /api/auth/reset-password` | Verifies code, updates password hash, clears code fields |

> **Note:** Email delivery is not yet implemented. The reset code is logged server-side only. Token refresh is a client-side stub returning null.

**Token management**
- JWT signed with HS256; contains `user_id`, `user_type`, `exp`, `mobile` claims
- Mobile clients (`X-Client-Type: mobile`) receive 90-day tokens; web clients receive 24-hour tokens
- Stored in `expo-secure-store` (encrypted); falls back to in-memory map on web
- Zustand auth store validates `exp` on startup and clears expired tokens automatically

**User roles**

| Role | Description |
|---|---|
| `patient` | Standard patient; EHR profile created at registration |
| `doctor` | Can access any patient who has authorized them |
| `admin` | Super-doctor; can access all patients without authorization |

---

### Patient Features

**Home screen** shows the most-recent blood pressure reading with a status badge (Normal / Elevated / High / Crisis), most-recent visit summary, SOS button (direct dial 112), and tile navigation to all core modules.

**Available actions:**

- Log vitals (systolic BP, diastolic BP, pulse, optional weight)
- View own visit history
- Upload, view, and delete own clinical documents
- View active exercises prescribed by a doctor; mark exercises done or not-done
- Message their doctor directly
- View and manage their medical profile (blood type, allergies, chronic conditions, emergency contact)
- Authorize or revoke doctor access from the Settings screen
- Export their full EHR as a FHIR R4 Bundle document

---

### Doctor Features

**Doctor Dashboard** shows a searchable list of authorized patients only. Selecting a patient opens a 6-tab detail view:

| Tab | Contents |
|---|---|
| Overview | Patient summary |
| Visits | Full visit history |
| Vitals | BP, pulse, weight readings |
| Documents | Uploaded clinical documents |
| Exercises | Prescribed exercises with CRUD |
| Messages | Direct message thread |

**Doctor-specific actions (all scoped to authorized patients):**

- Record vitals on behalf of a patient
- Record a visit with chief complaint, free-text diagnosis, optional ICD-10-GM code, and notes
- Assign, update, and delete exercises
- View all document categories uploaded by the patient
- Full message thread per patient; inline message composer in PatientDataView

---

### EHR Module

All EHR data is stored in MongoDB using HL7 FHIR R4 resource shapes.

#### Visits

Stored as linked `Encounter` + `Condition` FHIR resources.

| Field | Type | Notes |
|---|---|---|
| chief_complaint | string | Required |
| diagnosis_text | string | Free-text clinical summary |
| diagnosis_icd10 | string | Optional ICD-10-GM code |
| notes | string | Additional notes |
| visit_date | datetime | |
| status | string | Fixed: `finished` |
| class | string | Fixed: `AMB` (ambulatory) |

#### Documents

Stored as `DocumentReference` FHIR resources. Files hosted on Cloudinary.

| Category | LOINC Code |
|---|---|
| Lab report | 11502-2 |
| Imaging | 18748-4 |
| Prescription | 57833-6 |
| Other | 34133-9 |

Allowed formats: JPEG, PNG, WebP, PDF. Max size: 10 MB. Deletion removes the file from Cloudinary before removing the database record.

#### Exercises

Prescribed by doctors; patients track compliance.

| Field | Notes |
|---|---|
| category | mobility / strength / balance / breathing / other |
| frequency | Free string (e.g. "3 times daily") |
| duration_minutes | Integer |
| repetitions / sets | Optional |
| video_url / image_url | Optional media links |
| active | Boolean; patients only see active exercises |
| order | Integer; controls display order |

Patients mark each exercise done (`POST /api/patient/exercises/<id>/done`), which sets/unsets `last_done_at`.

#### Messages

Stored as `Communication` FHIR resources.

- Full thread view per doctor–patient pair
- Unread count aggregation per conversation
- System-generated messages inserted automatically when a monitoring alert reaches `critical` severity
- Conversations endpoint returns one entry per partner, ordered by most-recent, with bulk unread count

#### Patient EHR Profile

Stored in the `users` collection under `ehr_profile`.

| Field | Type |
|---|---|
| blood_type | string |
| allergies | array |
| chronic_conditions | array |
| emergency_contact | string |

> Profile write currently happens only at registration. No update endpoint exists yet.

---

### Monitoring & Alerts

`POST /api/monitoring/alert` accepts sensor readings and computes severity automatically if not provided.

**Severity thresholds:**

| Sensor | Warning Range | Critical Threshold |
|---|---|---|
| heart_rate | 50–100 bpm | < 40 or > 130 bpm |
| glucose | 70–180 mg/dL | < 54 or > 250 mg/dL |
| spo2 | 94–100% | < 90% |
| blood_pressure | 90–140 mmHg | < 80 or > 180 mmHg |

When severity is `critical`, a system message is automatically inserted into the patient's message thread with their first authorized doctor.

`GET /api/monitoring/alerts/` supports filtering by `sensor_type` and `severity`. Patients see only their own alerts; doctors specify a `patient_id` query parameter (access-checked).

---

### File & Document Upload

**Avatar upload** (`POST /api/user/avatar`)
- Allowed: JPEG, PNG, WebP, GIF — max 5 MB
- Uploaded to Cloudinary folder `morafek/avatars`; face-gravity crop applied to 400×400 px
- URL persisted to `users.profile_picture_url`

**Document upload** (`POST /api/patient/documents`)
- Allowed: JPEG, PNG, WebP, PDF — max 10 MB
- Uploaded to Cloudinary folder `morafek/documents`
- `cloudinary_public_id` stored to enable hard deletion

---

### Offline Support

Uses `expo-sqlite` on iOS/Android with an in-memory object fallback on web.

**SQLite tables:**

| Table | Purpose |
|---|---|
| `vitals` | Cache of server-returned vitals (last 50) |
| `visits` | Table exists; populate/read not yet implemented |
| `pending_vitals` | Queue for vitals submitted while offline |

**Sync behaviour:** The patient home screen caches vitals after a successful API fetch and reads from SQLite when the network call fails. A background sync loop for `pending_vitals` is not yet wired up — `queueVital` and `getPendingVitals` functions exist and are ready to be connected.

---

## FHIR R4 Implementation

FHIR resources are constructed manually at the application layer. No external FHIR server is used.

| FHIR Resource | Collection | Used For |
|---|---|---|
| `Observation` | `ehr_vitals` | Blood pressure, pulse, weight readings |
| `Encounter` | `ehr_visits` | Doctor visit records |
| `Condition` | `ehr_conditions` | Diagnoses linked to Encounters (with ICD-10-GM) |
| `DocumentReference` | `ehr_documents` | Clinical documents (LOINC-coded categories) |
| `Communication` | `ehr_messages` | Doctor–patient and system-generated messages |
| `Bundle (document)` | — | Full patient record export (all of the above) |

**FHIR R4 Bundle export** (`GET /api/patient/fhir-export`) returns a standards-compliant `Bundle` of type `document` containing all `Observation`, `Encounter`, `Condition`, and `DocumentReference` resources for the requesting patient.

---

## API Reference

### Authentication (`auth_routes.py`)

| Method | Path | Description |
|---|---|---|
| POST | `/login` | Login; returns JWT + user data |
| POST | `/register` | Register new user |
| GET | `/api/doctors` | List all doctors (patients only) |
| GET | `/api/patient/authorized-doctors` | Get patient's authorized doctors |
| POST | `/api/patient/authorize-doctor` | Add doctor to authorized list |
| POST | `/api/patient/revoke-doctor` | Remove doctor from authorized list |
| POST | `/api/auth/forgot-password` | Request password-reset code |
| POST | `/api/auth/reset-password` | Verify code and set new password |

### Patient (`patient_routes.py`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/patient/profile` | Get patient profile (name, email, EHR profile) |

### Doctor (`doctor_routes.py`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/doctor/patients` | Get authorized patient list |

### EHR (`ehr_routes.py`)

| Method | Path | Description |
|---|---|---|
| POST | `/api/patient/vitals` | Patient records own vitals |
| GET | `/api/patient/vitals` | Patient views own vitals |
| POST | `/api/doctor/patient/<id>/vitals` | Doctor records vitals for patient |
| GET | `/api/doctor/patient/<id>/vitals` | Doctor views patient vitals |
| GET | `/api/patient/visits` | Patient views own visit history |
| POST | `/api/doctor/patient/<id>/visits` | Doctor records a visit |
| GET | `/api/doctor/patient/<id>/visits` | Doctor views patient visits |
| GET | `/api/messages/conversations` | List all conversation threads |
| GET | `/api/messages/unread-count` | Count unread messages |
| GET | `/api/messages/<other_user_id>` | Get thread with a specific user |
| POST | `/api/messages/<other_user_id>` | Send a message |
| GET | `/api/doctor/patient/<id>/messages` | Doctor views thread with patient |
| GET | `/api/patient/documents` | Patient views own documents |
| POST | `/api/patient/documents` | Patient uploads a document |
| DELETE | `/api/patient/documents/<doc_id>` | Patient deletes own document |
| GET | `/api/doctor/patient/<id>/documents` | Doctor views patient documents |
| POST | `/api/doctor/patient/<id>/exercises` | Doctor assigns exercise |
| GET | `/api/doctor/patient/<id>/exercises` | Doctor lists patient exercises |
| PUT | `/api/doctor/patient/<id>/exercises/<ex_id>` | Doctor updates exercise |
| DELETE | `/api/doctor/patient/<id>/exercises/<ex_id>` | Doctor deletes exercise |
| GET | `/api/patient/exercises` | Patient views own active exercises |
| POST | `/api/patient/exercises/<id>/done` | Patient marks exercise done/not-done |
| GET | `/api/patient/fhir-export` | Export full EHR as FHIR R4 Bundle |

### Monitoring (`monitoring_routes.py`)

| Method | Path | Description |
|---|---|---|
| POST | `/api/monitoring/alert` | Record sensor alert (severity auto-computed) |
| GET | `/api/monitoring/alerts/` | List alerts (filterable by sensor_type, severity) |

### Upload (`upload_routes.py`)

| Method | Path | Description |
|---|---|---|
| POST | `/api/user/avatar` | Upload profile picture to Cloudinary |

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

## Configuration & Environment Variables

### Backend

| Variable | Required | Purpose |
|---|---|---|
| `MONGO_URI` | ✅ | MongoDB Atlas connection string |
| `SECRET_KEY` | ✅ | JWT signing secret |
| `CLOUDINARY_CLOUD_NAME` | ✅ | Cloudinary account name |
| `CLOUDINARY_API_KEY` | ✅ | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | ✅ | Cloudinary API secret |

> The app refuses to start if `MONGO_URI` or `SECRET_KEY` are missing.

CORS allowed origins are defined in `config.py` and include localhost development ports and the production domains (`morafek-api.onrender.com`, `morafek.vercel.app`).

### Mobile

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_API_URL` | Backend base URL (e.g. `https://morafek-api.onrender.com`) |
| `EXPO_PUBLIC_API_VERSION` | API version string (default `v1`; versioned routing currently disabled) |

Copy `.env.example` to `.env` and fill in both values before running the app.

---

## Getting Started

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate       # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp config-draft\ local.py config.py   # adjust env values
python main.py
```

The API starts on `http://localhost:5000`.

### Mobile

```bash
cd mobile
npm install
cp .env.example .env           # set EXPO_PUBLIC_API_URL
npx expo start
```

Press `i` for iOS simulator, `a` for Android emulator, or scan the QR code with the Expo Go app.

---

## Known Limitations & Planned Work

- Password reset email delivery is not implemented — codes are logged server-side only
- Token refresh is a client-side stub; re-login is required after expiry
- Patient EHR profile (blood type, allergies, etc.) can only be set at registration — no update endpoint yet
- Offline sync loop for pending vitals is scaffolded but not connected
- Visit history table (`visits`) in SQLite exists but has no populate or read implementation
- Connected Sensors UI card is a placeholder — CGM/wearable integration is not yet implemented
- 
