# 🏥 Morafek CareMate — Personal Health Record System

> **"Morafek"** (مُرَافِق) means *companion* in Arabic — your personal health companion.

Morafek CareMate is a cross-platform **Personal Health Record (PHR)** mobile application that enables patients to track their health metrics and manage medical documents, while giving doctors a secure clinical dashboard to record visits, prescribe exercises, and communicate with patients — all in a single unified platform that is FHIR R4 compliant and targets German ISiK Stage 1 standards.

---

## 📋 Table of Contents

1. [App Overview](#app-overview)
2. [Features](#features)
3. [Tech Stack](#tech-stack)
4. [Project Structure](#project-structure)
5. [Setup & Installation](#setup--installation)
6. [Docker Setup](#-docker-setup)
7. [Environment Variables](#environment-variables)
8. [Data Models / Entities](#data-models--entities)
9. [API Endpoints](#api-endpoints)
10. [Security & Privacy](#security--privacy)
11. [Screens & UI](#screens--ui)

---

## 🩺 App Overview

**What it does:**
Morafek CareMate is a bilingual (Arabic/English-friendly) Personal Health Record app that connects patients with their doctors. Patients log vitals, upload medical documents, view their visit history and exercise plans, and message their care team — all from a single mobile app. Doctors get a clinical dashboard to manage patients, record visits with ICD-10-GM coded diagnoses, assign exercise programs, and monitor health alerts.

**The core problem it solves:**
Healthcare data is fragmented across clinics, paper records, and spreadsheets. Morafek centralizes a patient's complete health record — vitals, visits, conditions, documents, and exercises — in a structured, shareable, and standards-compliant format (FHIR R4).

**Target users:**
- **Patients** — individuals managing chronic conditions or tracking their own health
- **Doctors** — clinicians managing a panel of patients via the doctor dashboard
- **Clinics** — organizations grouping multiple doctors under one roof

---

## ✨ Features

### 🔐 Authentication & Account Management
- Role-based registration and login: **Patient** or **Doctor** account types
- JWT-based authentication with:
  - 24-hour tokens for web clients
  - 90-day tokens for mobile clients (no unexpected logouts)
- Forgot password / reset password via email token
- Profile picture upload (via Cloudinary)
- **DSGVO-compliant account deletion** — permanently erases all user data on request

### 📊 Patient Health Dashboard
- Personalized greeting with time-of-day awareness (Good morning / afternoon / evening)
- **Blood Pressure card** — latest reading with color-coded status badge:
  - 🟢 Normal / 🟠 Elevated / 🔴 High / ⚠️ Crisis
- **Last Visit card** — most recent clinical visit summary
- **SOS emergency button** — one-tap to call emergency services (tel:112)
- Quick-action tile grid: My Visits · Messages · My Documents · My Exercises
- **Offline support** — vitals cached in local SQLite; shows "Showing cached data" banner when offline
- Connected Sensors placeholder *(coming soon: heart rate monitor, CGM, SpO2)*

### 💓 Vitals Logging
- Record blood pressure (systolic / diastolic), pulse, weight, and free-text notes
- **Live BP classification** shown as you type (color-coded badge)
- Pre-measurement instruction card (sit 5 minutes, left arm, no talking)
- Urgent readings trigger a warning prompt to contact doctor
- **Offline queue** — vitals saved locally when network unavailable and synced automatically on next open
- Validation: systolic 60–300, diastolic 40–200

### 🏥 Clinical Visits
- Patient view: full visit history with date, reason, ICD-10 diagnosis + code badge, expandable clinical notes
- Doctor view: record new visits per patient with chief complaint, diagnosis, notes
- **ICD-10-GM AI Assist** (doctors only) — local search over all 14,370 ICD-10-GM 2026 terminal codes with AI-powered ranked suggestions via Google Gemini based on chief complaint

### 💬 Secure Messaging
- In-app direct messaging between patients and their authorized doctors
- Conversation list with unread message count badge
- Doctors can view patient message threads from the patient detail view

### 📁 Medical Documents
- Upload lab reports, imaging, prescriptions, and other documents (image or PDF)
- Organized by category with color-coded section banners:
  - 🧪 Lab Report · 🩻 Imaging · 💊 Prescription · 📄 Other
- View documents via Cloudinary URL
- Delete documents (patients only)
- Doctor view: read-only access to patient documents

### 🏋️ Exercise Plans
- Doctor-assigned exercise programs with category, frequency, duration, sets/reps
- Optional video link (opens in-app browser) and image per exercise
- Categories: Mobility · Strength · Balance · Breathing · Other
- **Mark as Done** toggle with optimistic UI update
- Doctor tools: create, edit, and delete exercises per patient

### 👨‍⚕️ Doctor Dashboard
- Welcome header with patient count, clinic count, and updates summary
- Horizontal scrollable clinic strip with "Manage ›" shortcut
- Patient list with tap-to-expand patient detail view
- Per-patient view: vitals, visits, documents, exercises, messages
- Inline patient profile editor (demographics, blood type, allergies, chronic conditions, medications, emergency contact)

### 🏥 Clinic Management (Doctors)
- Create clinics with name, address, phone, description
- View stats: total / created by you / joined
- Edit clinics you created (inline form)
- Leave any clinic (with ownership-aware confirmation prompt)
- Clinics appear in patient doctor-picker for filtering

### 👥 Doctor Authorization (Patients)
- Browse all available doctors with clinic filter (pill strip)
- Authorize a doctor to access your health record
- View your authorized doctors list
- Revoke access from any doctor

### 👤 Patient Profile & Medical Record
- Read-only medical profile view: demographics, blood type, height, weight, allergies, chronic conditions, current medications, smoking status, emergency contact, clinical notes
- Profile picture management (upload from gallery)
- **FHIR R4 data export** — download full health record as a FHIR Bundle JSON file (mobile: share sheet; web: file download)
- Account deletion (DSGVO right-to-erasure compliant)

### 🇩🇪 German Healthcare Standards (FHIR / ISiK)
- FHIR R4 compliant server (CapabilityStatement at `GET /metadata`)
- **ISiK Stage 1** (Basisdaten) support:
  - Patient resources with **GKV-Krankenversichertennummer** (statutory insurance ID)
  - Doctor resources with **LANR** (Lebenslange Arztnummer)
  - ICD-10-GM (BfArM) coded diagnoses
  - LOINC-coded vital signs (blood pressure 55284-4, heart rate 8867-4, body weight 29463-7)
- FHIR REST endpoints: `GET /fhir/Patient/{id}`, `GET /fhir/Patient` (search)
- Full-patient FHIR Bundle export at `GET /api/patient/fhir-export`
- German de.basisprofil.r4 Patient and Observation profiles

### 📡 Health Monitoring & Alerts
- Sensor alert creation for: heart rate, glucose, SpO2, blood pressure
- Automated severity classification: `info` → `warning` → `critical` based on clinical thresholds
- Alert history retrieval

---

## 🛠️ Tech Stack

### Mobile Frontend
| Layer | Technology |
|---|---|
| Framework | React Native 0.81.5 (Expo SDK 54) |
| Navigation | Expo Router 6 (file-based routing) |
| Language | TypeScript 5.9 |
| State Management | Zustand 5.0 |
| HTTP Client | Axios 1.15 |
| Local Database (offline) | expo-sqlite 16 |
| Charts | react-native-chart-kit, victory-native |
| File Handling | expo-document-picker, expo-file-system |
| Image Picker | expo-image-picker |
| Sharing | expo-sharing |
| Push Notifications | expo-notifications |
| Secure Token Storage | expo-secure-store |
| Date Utilities | date-fns 4 |

### Backend
| Layer | Technology |
|---|---|
| Framework | Flask 3.1.1 (Python) |
| Database | MongoDB Atlas (via pymongo 4.13) |
| ODM | Flask-PyMongo 3.0.1 |
| Authentication | JWT (PyJWT 2.10.1) + bcrypt 4.2.1 |
| File Storage | Cloudinary 1.44 |
| AI | Google Generative AI (`google-genai ≥ 1.0.0`) |
| CORS | flask-cors 6.0.1 |
| Production Server | Gunicorn 25.1.0 |
| Config | python-dotenv 1.2.1 |

### Infrastructure & Deployment
| | |
|---|---|
| Backend hosting | Render (https://morafek-api.onrender.com) |
| Frontend (web) | Vercel (https://morafek-care-mate.vercel.app) |
| CDN / Media | Cloudinary |
| Database | MongoDB Atlas |
| Containerisation | Docker + Docker Compose |

---

## 📁 Project Structure

```
Morafek-CareMate/
├── docker-compose.yml         # Orchestrates backend + frontend containers
├── .env                       # Root env for docker-compose variable substitution
├── backend/                   # Flask REST API
│   ├── Dockerfile             # Backend container definition
│   ├── .dockerignore
│   ├── main.py                # App factory, blueprint registration, startup indexes
│   ├── config.py              # Flask config, CORS, MongoDB init, Cloudinary setup
│   ├── requirements.txt       # Python dependencies
│   ├── .env                   # Backend secrets (not committed)
│   ├── routes/
│   │   ├── auth_routes.py     # Login, register, forgot/reset password, delete account, doctor auth
│   │   ├── patient_routes.py  # Patient profile, medical profile, FHIR Patient endpoints
│   │   ├── doctor_routes.py   # Doctor patient-list endpoint
│   │   ├── ehr_routes.py      # Vitals, visits, messages, documents, exercises, ICD-10 AI, FHIR export
│   │   ├── clinic_routes.py   # Clinic CRUD + join/leave
│   │   ├── upload_routes.py   # Avatar upload to Cloudinary
│   │   ├── monitoring_routes.py # Sensor alerts with threshold-based severity
│   │   └── metadata_route.py  # FHIR CapabilityStatement (GET /metadata)
│   ├── utils/
│   │   ├── auth.py            # JWT generation & token_required decorator
│   │   ├── error_handler.py   # Global API error handler decorator
│   │   └── fhir_de.py         # FHIR R4 resource builders (Patient, Observation, etc.)
│   ├── models/                # (reserved — currently schema is in-document via pymongo)
│   └── tests/                 # Backend test suite
└── mobile/                    # React Native (Expo) mobile app
    ├── Dockerfile             # Frontend container definition (web build via nginx)
    ├── .dockerignore
    ├── .env                   # Mobile secrets (not committed)
    ├── app/
    │   ├── (auth)/            # Unauthenticated routes
    │   │   ├── login.tsx
    │   │   ├── register.tsx
    │   │   └── forgot-password.tsx
    │   └── (app)/             # Authenticated routes (protected by layout guard)
    │       ├── (tabs)/        # Bottom tab navigator
    │       ├── ehr/           # EHR detail screens
    │       ├── log/           # Vitals entry
    │       └── settings/      # Doctors & clinics management
    ├── components/
    │   ├── ui/                # Reusable primitives: Button, Card, Input, Loading
    │   ├── doctor/            # ClinicCard, DoctorList, PatientList, PatientDataView
    │   └── ehr/               # ICD10SearchInput, medication components
    ├── services/
    │   ├── api/               # Axios wrappers for every backend route group
    │   └── offline/db.ts      # SQLite cache (vitals) + pending-queue (offline sync)
    ├── store/
    │   └── auth.store.ts      # Zustand auth store (user, token, login/logout)
    ├── constants/             # theme.ts, elderlyTheme.ts, icd10gm.ts (14,370 codes)
    ├── types/                 # TypeScript type declarations
    └── utils/                 # Form validation helpers
```

**Architecture pattern:** Layered (frontend ↔ REST API ↔ MongoDB). The mobile app uses file-based routing (Expo Router) with a Zustand auth store. The backend uses the Flask Blueprint pattern — one blueprint per domain (auth, patient, doctor, EHR, clinics, upload, monitoring, FHIR metadata).

---

## ⚙️ Setup & Installation

### Prerequisites
- **Node.js** ≥ 20 (for mobile)
- **Python** ≥ 3.11 (for backend)
- **Expo CLI** (`npm install -g expo-cli`)
- A **MongoDB Atlas** cluster (free tier works)
- A **Cloudinary** account (free tier works)
- A **Google Generative AI** API key (for ICD-10 AI Assist)

### 1. Clone the repository
```bash
git clone https://github.com/aliattia02/Morafek-CareMate.git
cd Morafek-CareMate
```

### 2. Backend Setup
```bash
cd backend

# Create and activate a virtual environment
python -m venv venv
source venv/bin/activate          # macOS/Linux
# venv\Scripts\activate           # Windows

# Install dependencies
pip install -r requirements.txt

# Copy and fill in environment variables
cp .env.example .env
```

Run in development:
```bash
python main.py
# Server starts on http://0.0.0.0:5000
```

Run in production:
```bash
gunicorn main:app --bind 0.0.0.0:5000 --workers 2
```

### 3. Mobile App Setup
```bash
cd mobile

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env to point EXPO_PUBLIC_API_URL at your backend
```

Run in development:
```bash
npm start           # Expo dev server (scan QR code with Expo Go)
npm run android     # Android emulator
npm run ios         # iOS simulator (macOS only)
npm run web         # Browser (http://localhost:8081)
```

Type-check:
```bash
npm run typecheck
```

---

## 🐳 Docker Setup

Run the full stack locally with a single command — no Python or Node.js installation required.

### Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows/macOS) or Docker Engine (Linux)

### File structure added for Docker

```
Morafek-CareMate/
├── docker-compose.yml     # Orchestrates backend + frontend
├── .env                   # Root env — one line: GEMINI_API_KEY (read by docker-compose)
├── backend/
│   ├── Dockerfile
│   ├── .dockerignore
│   └── .env               # All backend secrets (existing file, unchanged)
└── mobile/
    ├── Dockerfile
    ├── .dockerignore
    └── .env               # Mobile secrets (existing file, unchanged for Docker)
```

### How the two .env files are used

| File | Used by | Notes |
|---|---|---|
| `backend/.env` | Backend container | Loaded directly via `env_file` in docker-compose |
| `mobile/.env` | Native Expo dev only | **Not read during Docker build** — `EXPO_PUBLIC_API_URL` is overridden to `localhost:5000` via build arg |
| `.env` (root) | docker-compose only | Contains only `GEMINI_API_KEY` for build arg substitution |

### 1. Create the root .env

```bash
# In project root (not backend/ or mobile/)
echo "GEMINI_API_KEY=your_gemini_key_here" > .env
```

### 2. Ensure backend/.env is complete

```env
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/morafek?retryWrites=true&w=majority
SECRET_KEY=your-long-random-secret
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
GEMINI_API_KEY=your_gemini_key
```

Generate `SECRET_KEY`:
```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

### 3. Build and start

```bash
docker compose up --build
```

First build takes ~5–10 minutes (downloads images, installs packages). Subsequent starts are fast.

### 4. Access the running services

| Service | URL |
|---|---|
| Backend API | http://localhost:5000 |
| Health check | http://localhost:5000/api/health |
| FHIR CapabilityStatement | http://localhost:5000/metadata |
| Web App | http://localhost:8081 |

### Common commands

```bash
# Start (after first build)
docker compose up

# Stop
docker compose down

# Rebuild after code changes
docker compose up --build

# View logs
docker compose logs -f backend
docker compose logs -f frontend

# Open a shell inside the backend container
docker exec -it morafek-backend bash
```

### Architecture notes

- **Backend** runs Flask via Gunicorn (2 workers) inside a `python:3.11-slim` container, connecting to your existing MongoDB Atlas cluster — no local database container needed.
- **Frontend** builds the Expo web export at build time inside a `node:20-slim` container, then serves the static output via `nginx:alpine`. `EXPO_PUBLIC_API_URL` is baked into the JS bundle at build time — changing the backend URL requires `--build`.
- **Mobile native dev** (Android/iOS via Expo Go) is unaffected — `mobile/.env` continues pointing to Render as before.

---

## 🔑 Environment Variables

### Backend (`backend/.env`)

| Variable | Required | Description |
|---|---|---|
| `MONGO_URI` | ✅ | MongoDB Atlas connection string (`mongodb+srv://...`) |
| `SECRET_KEY` | ✅ | JWT signing secret (long random string) |
| `CLOUDINARY_CLOUD_NAME` | ✅ | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | ✅ | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | ✅ | Cloudinary API secret |
| `GEMINI_API_KEY` | ✅ | Google Generative AI key (for ICD-10 AI Assist) |

### Mobile (`mobile/.env`)

| Variable | Default | Description |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | `http://localhost:5000` | Base URL of the Flask backend |
| `EXPO_PUBLIC_API_VERSION` | `v1` | API version prefix |
| `GEMINI_API_KEY` | — | Gemini key for client-side AI features |

---

## 🗄️ Data Models / Entities

### User (MongoDB `users` collection)

| Field | Type | Notes |
|---|---|---|
| `_id` | ObjectId | Primary key |
| `username` | string | Unique |
| `email` | string | Unique |
| `password` | string | bcrypt hash |
| `first_name` | string | |
| `last_name` | string | |
| `date_of_birth` | string | YYYY-MM-DD |
| `user_type` | enum | `patient` \| `doctor` |
| `profile_picture_url` | string | Cloudinary URL |
| `authorized_doctors` | array | (patient only) list of doctor IDs |
| `ehr_profile` | object | (patient only) blood_type, allergies, chronic_conditions, emergency_contact |
| `clinic_ids` | array | (doctor only) list of clinic IDs |
| `lanr` | string | (doctor only) German Lebenslange Arztnummer |
| `created_at` | datetime | |

### PatientFhirIdentifiers (MongoDB `patient_fhir_identifiers`)

| Field | Type | Notes |
|---|---|---|
| `patient_id` | string | FK → users._id |
| `gkv_kvid` | string | German statutory insurance number |
| `phone` | string | |
| `street`, `postal_code`, `city` | string | German address fields |

### Vital (MongoDB `ehr_vitals`)

| Field | Type |
|---|---|
| `patient_id` | string |
| `systolic` | int (mmHg) |
| `diastolic` | int (mmHg) |
| `pulse` | int (bpm) |
| `weight_kg` | float |
| `notes` | string |
| `urgent` | bool |
| `timestamp` | datetime |

### Visit / Encounter (MongoDB `ehr_visits`)

| Field | Type |
|---|---|
| `patient_id` | string |
| `doctor_id` | string |
| `chief_complaint` | string |
| `diagnosis_icd10` | string (ICD-10-GM code) |
| `diagnosis_text` | string |
| `visit_date` | string |
| `notes` | string |
| `encounter_fhir_id` | string (FHIR Encounter UUID) |

### Document (MongoDB `ehr_documents`)

| Field | Type |
|---|---|
| `patient_id` | string |
| `url` | string (Cloudinary) |
| `category` | enum: lab_report, imaging, prescription, other |
| `description` | string |
| `created_at` | datetime |

### Exercise (MongoDB `ehr_exercises`)

| Field | Type |
|---|---|
| `patient_id` | string |
| `doctor_id` | string |
| `title` | string |
| `category` | enum: mobility, strength, balance, breathing, other |
| `frequency` | string |
| `duration_minutes` | int |
| `repetitions`, `sets` | int |
| `video_url`, `image_url` | string |
| `notes` | string |

### Message (MongoDB `messages`)

| Field | Type |
|---|---|
| `sender_id` | string |
| `receiver_id` | string |
| `content` | string |
| `timestamp` | datetime |
| `read` | bool |

### Clinic (MongoDB `clinics`)

| Field | Type |
|---|---|
| `name` | string |
| `address`, `phone`, `description` | string |
| `created_by` | string (doctor user ID) |
| `doctor_ids` | array |
| `doctor_count` | int |
| `created_at` | datetime |

### MonitoringAlert (MongoDB `monitoring_alerts`)

| Field | Type |
|---|---|
| `patient_id` | string |
| `sensor_type` | enum: heart_rate, glucose, spo2, blood_pressure |
| `value` | float |
| `unit` | string |
| `severity` | enum: critical, warning, info |
| `message` | string |
| `created_at` | datetime |

---

## 🌐 API Endpoints

### Authentication (`/login`, `/register`, `/api/auth/...`)

| Method | Path | Description |
|---|---|---|
| POST | `/login` | Login (returns JWT) |
| POST | `/register` | Register new user |
| POST | `/api/auth/forgot-password` | Send password reset email |
| POST | `/api/auth/reset-password` | Reset password with token |
| DELETE | `/api/auth/delete-account` | Permanently delete account (DSGVO) |

### Patient (`/api/patient/...`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/patient/profile` | Get own profile |
| GET | `/api/patient/medical-profile` | Get full medical profile |
| GET | `/api/patient/fhir-profile` | Get FHIR-formatted profile |
| PUT | `/api/patient/fhir-identifiers` | Update German FHIR identifiers |
| GET | `/api/patient/authorized-doctors` | List authorized doctors |
| POST | `/api/patient/authorize-doctor` | Authorize a doctor |
| POST | `/api/patient/revoke-doctor` | Revoke a doctor's access |

### Doctors (`/api/doctors`, `/api/doctor/...`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/doctors` | List all available doctors |
| GET | `/api/doctor/patients` | Doctor: list their patients |

### EHR — Vitals

| Method | Path | Description |
|---|---|---|
| GET | `/api/patient/vitals` | Patient: get own vitals |
| POST | `/api/patient/vitals` | Patient: log a vital reading |
| GET | `/api/doctor/patient/{id}/vitals` | Doctor: view patient vitals |
| POST | `/api/doctor/patient/{id}/vitals` | Doctor: add vital for patient |

### EHR — Visits

| Method | Path | Description |
|---|---|---|
| GET | `/api/patient/visits` | Patient: view own visit history |
| POST | `/api/doctor/patient/{id}/visits` | Doctor: create visit record |
| GET | `/api/doctor/patient/{id}/visits` | Doctor: view patient visits |

### EHR — Patient Medical Profile (Doctor-managed)

| Method | Path | Description |
|---|---|---|
| GET | `/api/doctor/patient/{id}/profile` | Doctor: read patient medical profile |
| PUT | `/api/doctor/patient/{id}/profile` | Doctor: update patient medical profile |

### EHR — Documents

| Method | Path | Description |
|---|---|---|
| GET | `/api/patient/documents` | Patient: list documents |
| POST | `/api/patient/documents` | Patient: upload document |
| DELETE | `/api/patient/documents/{id}` | Patient: delete document |
| GET | `/api/doctor/patient/{id}/documents` | Doctor: view patient documents |

### EHR — Exercises

| Method | Path | Description |
|---|---|---|
| GET | `/api/patient/exercises` | Patient: get assigned exercises |
| POST | `/api/patient/exercises/{id}/done` | Patient: mark exercise done |
| POST | `/api/doctor/patient/{id}/exercises` | Doctor: assign exercise |
| GET | `/api/doctor/patient/{id}/exercises` | Doctor: list patient exercises |
| PUT | `/api/doctor/patient/{id}/exercises/{eid}` | Doctor: edit exercise |
| DELETE | `/api/doctor/patient/{id}/exercises/{eid}` | Doctor: delete exercise |

### EHR — Messaging

| Method | Path | Description |
|---|---|---|
| GET | `/api/messages/conversations` | List all conversations |
| GET | `/api/messages/unread-count` | Get unread message count |
| GET | `/api/messages/{other_user_id}` | Get messages with a user |
| POST | `/api/messages/{other_user_id}` | Send a message |
| GET | `/api/doctor/patient/{id}/messages` | Doctor: view patient messages |

### EHR — AI & FHIR

| Method | Path | Description |
|---|---|---|
| POST | `/api/ehr/icd10-suggest` | AI ICD-10-GM code suggestions (doctors only) |
| GET | `/api/patient/fhir-export` | Export full FHIR R4 Bundle |

### Clinics (`/api/clinics/...`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/clinics` | List all clinics |
| POST | `/api/clinics` | Create a clinic |
| GET | `/api/clinics/{id}` | Get clinic details |
| PUT | `/api/clinics/{id}` | Update clinic |
| DELETE | `/api/clinics/{id}` | Delete clinic |
| POST | `/api/clinics/{id}/join` | Join a clinic |
| POST | `/api/clinics/{id}/leave` | Leave a clinic |
| GET | `/api/clinics/{id}/doctors` | List doctors in clinic |
| GET | `/api/doctor/clinics` | List clinics I belong to |

### Monitoring

| Method | Path | Description |
|---|---|---|
| POST | `/api/monitoring/alert` | Submit sensor alert |
| GET | `/api/monitoring/alerts/` | List alerts |

### FHIR R4 (German ISiK)

| Method | Path | Description |
|---|---|---|
| GET | `/metadata` | FHIR CapabilityStatement (no auth) |
| GET | `/fhir/Patient/{id}` | Read FHIR Patient resource |
| GET | `/fhir/Patient` | Search FHIR Patients |

### Uploads

| Method | Path | Description |
|---|---|---|
| POST | `/api/user/avatar` | Upload profile picture |

### Utility

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Health check |
| GET/POST/... | `/api/v1/*` | Proxy → `/api/*` (v1 compatibility shim) |

---

## 🔒 Security & Privacy

### Authentication & Authorization
- JWT (HS256) — all protected endpoints require an `Authorization: Bearer <token>` header
- `token_required` decorator on every protected route validates and decodes the JWT
- Role-based access control — `user_type` embedded in JWT payload; doctor-only endpoints check the role before proceeding
- Doctor-patient access control — doctors can only access data for patients who have explicitly authorized them; `check_doctor_patient_access()` enforces this on every EHR endpoint
- Separate token lifetimes: 24h (web), 90 days (mobile, via `X-Client-Type: mobile` header)

### Data Protection
- Passwords hashed with bcrypt (`Werkzeug generate_password_hash`)
- JWT secrets loaded exclusively from environment variables — never hardcoded
- MongoDB credentials loaded from `.env` only — startup raises if missing
- Cloudinary credentials loaded from environment — startup raises if missing
- CORS whitelisted to known origins only; dynamic allowlist for Vercel preview deployments

### DSGVO (GDPR) Compliance
- Account deletion endpoint (`DELETE /api/auth/delete-account`) wipes all user data permanently
- Password confirmation required before deletion
- GKV Versichertennummer masked in API responses (only first 4 chars shown)
- Trust bar on login screen displays: DSGVO compliant · End-to-end encrypted · FHIR R4

### Health Data Standards
- FHIR R4 structured data export — portable, vendor-neutral
- ISiK Stage 1 (Basisdaten) compliance — German hospital interoperability standard
- ICD-10-GM (BfArM) coded diagnoses
- LOINC-coded vital sign observations
- SMART on FHIR scopes planned for future ePA (Elektronische Patientenakte) integration

---

## 📱 Screens & UI

| Screen | Role | What the user sees & does |
|---|---|---|
| Login | All | Branding hero, Patient/Doctor role chip selector, username + password fields, forgot password link, register link. Trust bar: DSGVO · Encrypted · FHIR R4. Wake-up progress banner when backend is cold-starting. |
| Register | All | Patient or Doctor toggle, first/last name, username, email, date of birth, password + confirm. Live validation. |
| Forgot Password | All | Email entry to trigger password reset. |
| Patient Home | Patient | Greeting header with SOS button. Blood pressure card with status badge and Add Reading button. Last Visit card. 2-column action tile grid (Visits, Messages, Documents, Exercises). Connected Sensors placeholder. Pull-to-refresh. Offline cache banner. |
| Record Vitals | Patient | Pre-measurement instruction card. Systolic/diastolic side-by-side input with live BP category badge. Pulse + weight + notes. Save locally or sync to server. |
| My Visits | Patient | Scrollable list of visit cards showing date, reason, ICD-10 code badge, and expandable clinical notes. |
| Messages | Both | Conversation list with unread badges. Per-conversation thread view. Compose and send messages. |
| My Documents | Patient | Category-grouped document cards (Lab Report / Imaging / Prescription / Other). View (opens Cloudinary URL). Delete. Upload panel (pick image or PDF, select category, enter description). |
| My Exercises | Patient | List of doctor-assigned exercise cards with category badge, details, optional video button, image, doctor notes, and Mark as Done toggle. |
| My Medical Profile | Patient | Read-only view: demographics, blood type, height, weight, allergies, chronic conditions, current medications, smoking status, emergency contact, clinical notes. |
| Profile | Both | Avatar (tapable to upload). Name, role badge. FHIR export button. Authorized Doctors shortcut (patients). Sign out. Delete account (DSGVO modal). |
| Doctor Dashboard | Doctor | Welcome header with stats (patients, clinics, updates). Horizontal clinic strip. Patient list. Tap patient → patient detail view with tabs for vitals, visits, documents, exercises, messages. |
| Visit Form | Doctor | Chief complaint, ICD-10-GM search field with AI Assist button, visit date picker, clinical notes. Submit creates visit record. |
| Exercise Form | Doctor | Category tile picker, title, description, frequency, duration, reps/sets, video URL, image URL, notes. Create or edit exercises. |
| Patient Data View | Doctor | Inline drill-down: patient vitals chart/list, visit history, document list, exercise plan, message thread. Edit patient medical profile form. |
| Doctor Management | Patient | Clinic filter strip ("All" + individual clinics). Scrollable list of all doctors. Authorize / Revoke buttons per doctor. |
| Clinic Management | Doctor | Stats bar. Create Clinic form. Cards for "Created by You" and "Clinics You've Joined". Edit (creator) or Leave (any member). |

---

**Notes on feature completeness:**
- ✅ **Complete:** Authentication, vitals logging, visit recording, ICD-10-GM with AI Assist, documents, exercises, messaging, clinics, doctor authorization, FHIR R4 export, ISiK metadata, account deletion, Docker Compose deployment
- 🔄 **Partial / In Progress:** Patient profile editing (doctors can edit; patient self-edit not yet exposed in UI)
- 🔜 **Planned / Placeholder:** Connected Sensors (heart rate monitor, CGM, SpO2), SMART on FHIR scopes for ePA integration, push notification delivery