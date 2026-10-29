# Morafek CareMate — User Journey Documentation

**App:** Morafek CareMate  
**Platform:** React Native (Expo SDK 53), Android & iOS  
**Backend:** Flask/Python · MongoDB Atlas · gICS 2025.x · gPAS 2025.x · FHIR R4  
**Compliance:** DSGVO · ISiK Stage 1 · de.basisprofil.r4 · KBV ERP  
**App version:** 1.0.1 (bundle ID `com.morafek.mobile`, min Android SDK 26)  
**Last updated:** May 2026

---

## Table of Contents

1. [Roles & Access Model](#1-roles--access-model)
2. [App Launch & Authentication](#2-app-launch--authentication)
3. [Patient Journey](#3-patient-journey)
4. [Doctor Journey](#4-doctor-journey)
5. [Feature Catalogue](#5-feature-catalogue)
6. [Backend API Endpoint Index](#6-backend-api-endpoint-index)
7. [Navigation Graph](#7-navigation-graph)
8. [Infrastructure & Docker Stack](#8-infrastructure--docker-stack)
9. [MongoDB Collections](#9-mongodb-collections)
10. [Edge Cases & System Guards](#10-edge-cases--system-guards)
11. [Offline Behaviour](#11-offline-behaviour)
12. [Data & Privacy](#12-data--privacy)

---

## 1. Roles & Access Model

The app supports three user roles. Role is set at registration and stored in the JWT payload. It is never editable in-app.

| Role | `user_type` value | Home screen | Key capabilities |
|------|-------------------|-------------|-----------------|
| **Patient** | `patient` | `(tabs)/index.tsx` | View own EHR, log vitals, manage consent, message doctors, upload documents |
| **Doctor** | `doctor` | `(tabs)/doctor-dashboard.tsx` | View authorized patients, record visits, prescribe medications, assign exercises |
| **Admin** | `admin` | Redirected to doctor dashboard | Same as doctor + unrestricted patient access, facility reactivation |

### German Professional Identifiers

Doctors may supply a **LANR** (Lebenslange Arztnummer, 9 digits) at registration. It is stored on the user document and included in FHIR `Practitioner` references inside `MedicationRequest.requester` and `Encounter.participant`.

Patients may supply a **GKV-KVID** (Krankenversichertennummer, format: 1 uppercase letter + 9 digits, e.g. `A123456789`) at registration or later via `PUT /api/patient/fhir-identifiers`. It is stored in `patient_fhir_identifiers` and included in FHIR `Patient` resources.

### Doctor → Patient Authorization

A patient must explicitly authorize a doctor before the doctor can access any of their data. Authorization is stored as an array of doctor ID strings on the patient's user document (`authorized_doctors: []`).

- Patient authorizes: `POST /api/patient/authorize-doctor` → uses `$addToSet` (idempotent)
- Patient revokes: `POST /api/patient/revoke-doctor` → uses `$pull`
- Doctor access check (`check_doctor_patient_access`): verifies `doctor_id` is in `patient.authorized_doctors`; admins bypass this check entirely

The doctor patient list (`GET /api/doctor/patients`) returns only patients who have authorized that doctor, plus a `fhir_identifiers` summary block showing whether the patient's GKV number is stored and a masked preview (`A123••••••`).

### Routing Enforcement

`useAuth.ts` contains a `useEffect` navigation guard that fires on every render:

- If `isAuthenticated && inAuthGroup` → push to `/(app)/(tabs)`
- If `!isAuthenticated && !inAuthGroup` → push to `/(auth)/login`

`index.tsx` (patient home) also guards locally: if `user_type === 'doctor'` or `'admin'`, it immediately calls `router.replace('/(app)/(tabs)/doctor-dashboard')`.

`visit-form.tsx` and `exercise-form.tsx` each check `user?.user_type !== 'doctor'` and redirect to `/` if a patient somehow reaches them.

---

## 2. App Launch & Authentication

### 2.1 Cold Start Flow

```
App opens
  └─ Root _layout.tsx mounts
       └─ useAuth() → checkAuth()
            ├─ secureStorage.get(AUTH_TOKEN)
            │    ├─ No token → isAuthenticated = false → redirect to /login
            │    └─ Token exists → isTokenValid() checks JWT exp claim
            │         ├─ Expired → clear storage → redirect to /login
            │         └─ Valid → load USER_DATA from storage
            │              └─ isAuthenticated = true → redirect to /(app)/(tabs)
            └─ isLoading = false (spinner hidden)
```

Token validity is checked **client-side only** (decoding the JWT `exp` claim without verifying the signature). The server re-validates the signature on every authenticated request via the `token_required` decorator.

Mobile clients receive a **90-day token** (via `X-Client-Type: mobile` request header). Web sessions receive 24-hour tokens. Both expiry values are set in `config.py` (`MOBILE_TOKEN_EXPIRY`, `TOKEN_EXPIRY`).

### 2.2 Login (`POST /login`)

**Request body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `username` | string | ✓ | |
| `password` | string | ✓ | |
| `user_type` | string | ✓ | `patient` \| `doctor` \| `admin` |

The backend looks up by `{username, user_type}` — a patient and a doctor may share the same username string without collision.

**Response 200:**
```json
{
  "token": "<JWT>",
  "user_type": "patient",
  "firstName": "Max",
  "lastName": "Mustermann",
  "profile_picture_url": "",
  "shared_constants": {}
}
```

**What the user sees:**
- Teal hero section with Morafek logo and pulse-line decoration
- Role selector: **Patient** 🧑 | **Doctor** 👨‍⚕️ (chips, default = patient)
- Username and password fields with show/hide toggle
- Demo account box ("Tap to fill" — prefills `test1`/`4444` for patient, `testd1`/`4444` for doctor)
- DSGVO trust bar: "DSGVO compliant · End-to-end encrypted · FHIR R4"

**Login flow:**

```
handleLogin()
  └─ validateForm() — username & password required
       └─ useAuth.login()
            ├─ wakeUpServer() — polls /api/health every 5 s up to 90 s
            │    └─ Shows WakeUpBanner with animated progress bar
            │         (skipped entirely for localhost/local backend)
            └─ storeLogin(credentials)
                 └─ POST /login
                      └─ Store token + user data in SecureStorage
                           └─ Navigation guard redirects to /(app)/(tabs)
```

If `wakeUpServer()` times out, an Alert is shown: "The server is waking up. Please wait a moment and try again." This covers the Render free-tier cold-start (typically 30–60 s).

### 2.3 Registration (`POST /register`)

**Required fields:** `username`, `email`, `password`, `firstName`, `lastName`, `dateOfBirth`, `user_type`

**Optional fields:**

| Field | Applicable to | Validation |
|-------|--------------|-----------|
| `lanr` | Doctors | 9 digits exactly (LANR format). Stored on user document for FHIR `Practitioner` resources. |
| `gkv_kvid` | Patients | 1 uppercase letter + 9 digits (e.g. `A123456789`). Stored in `patient_fhir_identifiers`. |

**Validation rules:** username and email must be unique. Invalid LANR → 400 with German error message. Invalid GKV → 400 with German error message.

**Registration side effects:**

1. Patient user document is created with `authorized_doctors: []` and an empty `ehr_profile`.
2. Doctor user document is created with `clinic_ids: []` (and `lanr` if supplied).
3. For patients: `gpas.get_or_create(user_id)` is called to pre-assign a gPAS pseudonym. This is **fire-and-forget** — if gPAS is unreachable, registration still succeeds and the pseudonym is created lazily on first consent grant.
4. The pseudonym (if obtained) is written to `patient_fhir_identifiers.pseudonym`.

**Response 201:** `{ "message": "User registered successfully", "id": "<user_id>" }`

After successful registration, the user is redirected to the login screen.

### 2.4 Forgot Password

Two-step flow:

**Step 1 — `POST /api/auth/forgot-password`:** Accepts `{ email }`. Generates a 6-digit code, stores it on the user document with a 15-minute expiry. Always returns 200 with a neutral message (no enumeration of whether the email exists). Production note: the code must be sent via email — it is currently only logged server-side.

**Step 2 — `POST /api/auth/reset-password`:** Accepts `{ email, code, new_password }`. Validates code match and expiry. On success, hashes and stores the new password and clears the reset code fields.

### 2.5 Logout

Available from `profile.tsx`. Calls `authService.logout()` which:

1. Clears `AUTH_TOKEN` and `USER_DATA` from SecureStorage
2. Sets `isAuthenticated = false` in Zustand store
3. Clears `pseudonymSuffix` from store
4. Navigation guard fires and redirects to `/login`

### 2.6 Account Deletion (`DELETE /api/auth/delete-account`)

Available from `profile.tsx` under **ACCOUNT → Delete My Data**. A modal requires password confirmation. Backend flow:

**Patient deletion wipes:**
- `ehr_vitals`, `ehr_visits`, `ehr_conditions`, `ehr_documents`, `ehr_messages`, `ehr_exercises`
- `patient_profiles`, `patient_fhir_identifiers` (GKV number, address — explicit DSGVO Art. 17 fix)
- Removes patient from all doctors' `authorized_doctors` arrays

**Doctor deletion:**
- Removes doctor from all clinics' `doctors` arrays
- Removes doctor from all patients' `authorized_doctors` arrays

**gPAS pseudonym is intentionally NOT deleted.** The pseudonym record in gPAS is the authoritative Treuhandstelle mapping and must be retained for legal/regulatory follow-up even after account deletion. Only the locally-cached copy in `patient_fhir_identifiers` is removed.

**Response 200:** `{ "message": "...", "deleted": { "ehr_vitals": 12, ... } }`

---

## 3. Patient Journey

### 3.1 Patient Home (`(tabs)/index.tsx`)

The patient home is the primary dashboard. It loads three data sources in parallel on mount:

| Data | API call | Fallback |
|------|----------|---------|
| Latest vital | `GET /api/patient/vitals` (limit 1) | SQLite cache |
| Last visit | `GET /api/patient/visits` | None (shows "No visits") |
| Today's medication count | `GET /api/medications/today` | Silent fail (badge hidden) |

**Layout:**
- Teal header bar with time-based greeting and **SOS button** (dials 112)
- **Blood Pressure card** — displays latest systolic/diastolic/pulse with colour-coded status badge (Normal 🟢 / Elevated 🟠 / High 🔴 / Crisis ⚠️) and an "Add Reading" button
- **Last Visit card** — date and diagnosis of most recent doctor visit
- **2-column action tile grid** linking to: Visits, Messages, Documents, Exercises, Medications (with unread badge showing pending medication count)
- **Connected Sensors placeholder** (heart rate monitor, CGM, SpO2 — coming soon)

### 3.2 Record Blood Pressure (`log/vitals.tsx`)

**Entry point:** Home → "Add Reading" button, or Profile → "Log Blood Pressure"

**Endpoint:** `POST /api/patient/vitals`

**Step-by-step:**

1. Patient reads pre-measurement instructions (sit 5 min, left arm, no talking)
2. Enters **Systolic** and **Diastolic** (required) — a live colour-coded badge updates as they type (Normal / Elevated / High / Crisis)
3. Enters **Pulse** (required)
4. Optionally enters **weight (kg)** — stored as a separate FHIR component (LOINC 29463-7)
5. Optionally enters free-text **notes**
6. Taps **Save Reading**

**Backend validation:** `systolic`, `diastolic`, `pulse` are required. The `urgent` flag is computed server-side: `systolic > 180 OR diastolic > 120`. Source is recorded as `patient_home`.

**Urgency logic — server-side only.** The client cannot override the urgent flag.

```
handleSubmit()
  ├─ syncPendingVitals() — flush any offline queue first
  ├─ POST /api/patient/vitals
  │    ├─ response.data.urgent === true → red banner "Critical reading — contact doctor"
  │    └─ success → green banner → router.back() after 1.5 s
  └─ Network error → queueVital() into SQLite → yellow banner "Saved locally"
```

**FHIR storage:** The observation is stored as a FHIR R4 `Observation` document in `ehr_vitals` with profile URLs for `de.basisprofil.r4` and `ISiKLebenszeichen`. Each vital sign is split into separate components (LOINC 8480-6 systolic, 8462-4 diastolic, 8867-4 heart rate, 29463-7 body weight).

### 3.3 Medications (`ehr/medications.tsx`)

**Endpoint:** `GET /api/medications/today`

**Tabs:**
- **Today** — medications grouped by slot (Morgens / Mittags / Abends / Nachts), each collapsible. Shows taken/pending counts per slot and a progress bar with overall daily adherence rate.
- **My Medications** — full active medication list (`GET /api/medications/my`) with PZN, dosage label, coverage type (GKV/PKV/Selbstzahler), start/end dates, chronic indicator. Tapping opens `MedicationDetailModal`.

**On screen mount:**

1. `syncPendingIntakes()` — flushes any offline confirmations from SQLite
2. `loadTodayData()` — `GET /api/medications/today` → generates/fetches intake slots for today, caches to SQLite
3. `loadMyMedications()` — `GET /api/medications/my` + `GET /api/medications/adherence?period_days=28`
4. `scheduleMedicationNotifications()` — lazy-imports `expo-notifications`, requests permission, schedules local alerts for each pending slot time

**Today endpoint detail:** Returns medications active today (start_date ≤ today AND (is_chronic OR end_date ≥ today)). For each medication and each non-zero dosage slot, an intake record is upserted (`$setOnInsert` with status `pending`). Duplicate calls are idempotent.

**Response shape:**
```json
{
  "date": "2026-05-20",
  "slots": {
    "morning": [ { "medication": {...}, "intake_id": "...", "status": "pending", "dosage": 1, "unit": "Tablette" } ],
    "noon": [], "evening": [], "night": []
  },
  "summary": { "total": 3, "taken": 1, "pending": 1, "skipped": 1 }
}
```

**Confirming intake:**

```
Tap "Taken" or "Skipped"
  └─ POST /api/medications/intake/  { intake_id, status, note }
       ├─ Online → confirms immediately → UI updates, adherence bar recalculates
       └─ Offline → queueMedicationIntake() to SQLite
            └─ Toast: "Saved offline. Will sync when connection is restored."
```

**Adherence heatmap** (`GET /api/medications/adherence?period_days=28`) returns `overall_rate` (0–1 float), a daily breakdown array for the `AdherenceHeatmap` component, and a per-medication breakdown.

### 3.4 Visits (`ehr/visits.tsx`)

**Endpoint:** `GET /api/patient/visits`

Displays a list of all doctor visits, sorted newest first. Each visit shows date, chief complaint, and ICD-10 diagnosis (if recorded). Tapping opens `VisitDetailModal` with full details including clinical notes.

**Data shape:** Each visit entry joins an `Encounter` (from `ehr_visits`) with its linked `Condition` (from `ehr_conditions`) via the shared `encounter_fhir_id` UUID.

### 3.5 Messages (`ehr/messages.tsx`)

Three endpoints power the messaging feature:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/messages/conversations` | Lists all conversation partners, with last message preview, timestamp, and unread count per partner |
| `GET /api/messages/<other_user_id>` | Fetches the full message thread with one other user (ascending order) |
| `POST /api/messages/<other_user_id>` | Sends a message; requires `{ body }` |
| `GET /api/messages/unread-count` | Returns total unread count for badge display |

Messages are stored as FHIR `Communication` resources in `ehr_messages` with `sender_id`, `recipient_id`, `sender_type`, `recipient_type`, `body`, `read`, and `created_at`.

The conversation list uses a single-pass deduplication strategy plus a bulk aggregation query to count unread messages per partner — no N+1 queries.

**Critical:** Route `/api/messages/conversations` and `/api/messages/unread-count` are registered **before** the variable route `/api/messages/<other_user_id>` to prevent Werkzeug from treating "conversations" as a user ID.

### 3.6 Documents (`ehr/documents.tsx`)

**Upload:** `POST /api/patient/documents` (multipart/form-data)

| Field | Required | Notes |
|-------|----------|-------|
| `file` | ✓ | JPEG, PNG, WebP, or PDF; max 10 MB |
| `description` | ✓ | Short text label |
| `category` | — | `lab_report` \| `imaging` \| `prescription` \| `other` (default) |
| `encounter_id` | — | Links document to a specific visit |

**Upload flow:** File is streamed to **Cloudinary** (`morafek/documents/` folder). The returned `secure_url` is stored in the FHIR `DocumentReference.content[0].attachment.url`. The `cloudinary_public_id` is stored for deletion.

**LOINC categories:**

| Category | LOINC code | Display |
|----------|-----------|---------|
| `lab_report` | 11502-2 | Laboratory report |
| `imaging` | 18748-4 | Diagnostic imaging study |
| `prescription` | 57833-6 | Prescription for medication |
| `other` | 34133-9 | Summary of episode note |

**Delete:** `DELETE /api/patient/documents/<document_id>` — removes from Cloudinary first, then from MongoDB.

**List:** `GET /api/patient/documents` — sorted by `date` descending.

### 3.7 Exercises (`ehr/exercises.tsx`)

**Endpoint:** `GET /api/patient/exercises` — returns only active exercises (`active: true`), sorted by `order`.

**Mark done/undone:** `POST /api/patient/exercises/<exercise_id>/done` with `{ "done": true }` — sets `last_done_at` to current UTC timestamp. `done: false` removes the field.

**Exercise fields visible to patient:** title, description, category (mobility / strength / balance / breathing / other), frequency, duration_minutes, repetitions, sets, video_url, image_url, notes.

### 3.8 Medical Profile (`ehr/patient-profile.tsx`)

**Endpoints:**
- `GET /api/patient/medical-profile` — full profile including FHIR identifier summary
- `GET /api/patient/fhir-profile` — own FHIR Patient resource (de.basisprofil.r4 + ISiKPatient)
- `PUT /api/patient/fhir-identifiers` — update German health identifiers

**Medical profile fields:**

| Field | Validation |
|-------|-----------|
| `date_of_birth` | string `YYYY-MM-DD` |
| `gender` | `male` \| `female` \| `other` \| `prefer_not_to_say` |
| `blood_type` | `A+` \| `A-` \| `B+` \| `B-` \| `AB+` \| `AB-` \| `O+` \| `O-` \| `unknown` |
| `height_cm`, `weight_kg` | positive float or null |
| `allergies`, `chronic_conditions`, `current_medications` | list of strings |
| `smoking_status` | `never` \| `former` \| `current` \| `unknown` |
| `emergency_contact_name`, `emergency_contact_phone` | strings |
| `notes` | free text |

**FHIR identifiers** (stored in `patient_fhir_identifiers`): `gkv_kvid` (validated: 1 uppercase letter + 9 digits), `phone`, `street`, `postal_code`, `city`. GKV is masked in API responses (first 4 chars + `••••••`).

### 3.9 Research Consent (`ehr/consent.tsx`)

The consent screen has two flows — **strict** (used by the mobile app) and **legacy soft** (available for integrations).

**Strict grant flow (`POST /api/consent/accept`):**

```
1. Check gICS — if already ACCEPTED, skip addConsent (idempotency guard)
2. Submit addConsent SOAP call to gICS (hard failure → 502 if gICS fault)
   └─ Duplicate-consent fault is treated as idempotent success
3. Call gPAS getOrCreatePseudonymFor (hard failure → gICS rollback → 502)
4. Write MongoDB (users.pseudonym + patient_consents) AFTER both succeed
5. Return { pseudonymSuffix: "XXXX" }  ← last 4 chars only, never the full pseudonym
```

**Response:** Only `pseudonymSuffix` (4 characters) is returned. The full pseudonym never leaves the server. The suffix is displayed in the UI as `****XXXX` and stored in `AsyncStorage` for cross-restart persistence.

**Revoke (`POST /api/consent/revoke`):** Revokes in gICS, marks `status: "revoked"` in `patient_consents`. The pseudonym is intentionally **not** deleted from gPAS or cleared from MongoDB — re-granting returns the same pseudonym via gPAS idempotency.

**Status check (`GET /api/consent/status`):** Queries gICS live. Returns `ACCEPTED` | `REJECTED` | `UNKNOWN`.

**Diagnostics (`GET /api/consent/diagnose`):** Returns a structured health check of gICS, gPAS, the consent status, and the MongoDB record. Useful for operators.

**Cloud fallback:** When `IS_LOCAL_BACKEND === false`, gICS and gPAS are unreachable. `acceptConsent()` detects a 502 or `ERR_BAD_RESPONSE` and rethrows as `Error('TTP_UNAVAILABLE')`. The consent screen renders a calm "🏥 Please visit your hospital" card.

### 3.10 FHIR Export (`ehr/fhir-export.tsx`)

Two export types are available from the Profile screen:

**Full export (`GET /api/patient/fhir-export`):** A conformant FHIR R4 document Bundle containing all PII. Includes: Composition (first entry, §3.3 required), Patient (with name, telecom, address), Observations (one per vital sign), Encounters, Conditions, DocumentReferences, Medication resources (KBV_PR_ERP_Medication_PZN), MedicationRequest (KBV_PR_ERP_Prescription), and MedicationStatement resources (intake history for last 90 days).

**Pseudonymised export (`GET /api/patient/fhir-export/pseudonymised`):** Identical clinical content, but the Patient resource contains only: pseudonym identifier, GKV-KVID (if present — allowed in research bundles), gender, birthDate. All `Patient/<mongo_id>` references are rewritten to `Patient/<pseudonym>`. Requires consent status = `granted` and a pseudonym on record (falls back to mongo_id if pseudonym not yet assigned).

**Bundle conformance:** `Bundle.type = "document"`, `Bundle.identifier` present (required by KBV/gematik ePA), `Bundle.total` absent (invalid for document type), Composition prepended as first entry.

**Conditions with empty `code.coding`** (no ICD code recorded) are skipped and dangling `Encounter.diagnosis` references to them are cleaned up before export.

### 3.11 Health Connect (Android) (`settings/health-connect.tsx`)

**Android only.** Reads wearable data from the on-device Health Connect store via `react-native-health-connect`. Permissions declared in `app.json`: `HeartRate`, `Steps`. No OAuth — all permissions are OS-level.

**Sync endpoint:** `POST /api/healthconnect/sync`

Accepts a batch of up to 2,000 FHIR R4 Observations. Each observation is validated individually (8 checks: resourceType, status, patient ID match, id UUID present, effectiveDateTime parseable, LOINC code in allowed set, valueQuantity.value non-negative, source = "health_connect"). Invalid observations are counted as skipped — a single bad record does not abort the batch.

**Allowed LOINC codes:** `8867-4` (heart rate), `41950-7` (steps). SPO2, weight, blood glucose, sleep are reserved for future mapper support.

**Upsert idempotency:** Keyed on client-generated UUID (`id` field). Sending the same observation twice is a no-op (`$setOnInsert`).

**Status:** `GET /api/healthconnect/status` — returns `has_data`, `last_sync` (ISO-8601), and per-type counts.

**Selective erasure (DSGVO Art. 17):** `DELETE /api/healthconnect/data` — deletes only HC-sourced records from `ehr_vitals` (source = "health_connect"). Manual vitals and clinical records are unaffected.

### 3.12 Manage Authorized Doctors (`settings/doctors.tsx`)

- `GET /api/doctors?clinic_id=<optional>` — lists all doctors (or doctors in a specific clinic)
- `GET /api/patient/authorized-doctors` — lists currently authorized doctors
- `POST /api/patient/authorize-doctor` → `{ doctor_id }` — grants access
- `POST /api/patient/revoke-doctor` → `{ doctor_id }` — revokes access

Doctor records include `lanr` when present.

---

## 4. Doctor Journey

### 4.1 Doctor Dashboard (`(tabs)/doctor-dashboard.tsx`)

On mount loads the patient list (`GET /api/doctor/patients`). Each patient card shows name, active conditions, active medications, and a `fhir_identifiers` block indicating whether the GKV number is stored (`gkv_kvid_stored: bool`, `gkv_kvid_masked: "A123••••••"`).

Tapping a patient opens `PatientDataView` inline (no navigation). The dashboard also links to clinic management (`settings/clinics.tsx`).

**Admin view:** Admins see all patients (`user_type: patient`), not filtered by `authorized_doctors`.

### 4.2 Record a Visit (`ehr/visit-form.tsx`)

**Entry point:** `PatientDataView` → "New Visit" button. Params: `patient_id`, `patient_name`.

**Endpoint:** `POST /api/doctor/patient/<patient_id>/visits`

**Required fields:** `chief_complaint`, `diagnosis_text`

**Optional fields:** `diagnosis_icd10` (ICD-10-GM code, min 3 chars if provided), `notes`, `visit_date` (ISO 8601; defaults to current UTC time)

**ICD-10-GM AI Suggest:** A Gemini 2.5 Flash call (`POST /api/ehr/icd10-suggest`) is available from the diagnosis field. Requires `GEMINI_API_KEY` env var. Sends `chief_complaint` + `diagnosis_hint` and returns 3–5 ranked ICD-10-GM 2026 suggestions with German rationale. Returns 503 if Gemini is not configured; 502 if the API call fails.

**Backend creates two documents atomically:**

1. `Encounter` in `ehr_visits` — FHIR R4 resource with ISiK profile stamp, Aufnahmenummer identifier, status `finished`, class `AMB` (ambulatory)
2. `Condition` in `ehr_conditions` — ICD-10-GM coded condition with ISiK profile stamp and `recordedDate`

**Response** includes `id`, `_id`, and `encounter_id` (all the same MongoDB ObjectId string) — the `visit-form.tsx` reads `visitRes.data?.id ?? visitRes.data?._id` to pass the `visitId` to `MedicationPrescriptionPanel`.

**Duplicate prevention:** The save button is disabled after the first successful save (`isVisitSaved = Boolean(successMsg)`).

### 4.3 Prescribe Medications (`MedicationPrescriptionPanel`)

**Endpoint:** `POST /api/medications/patient/`

**Required fields:**

| Field | Type | Validation |
|-------|------|-----------|
| `patient_id` | string | Valid ObjectId, patient must be authorized |
| `pzn` | string | Exactly 8 digits |
| `trade_name` | string | Non-empty |
| `active_substance` | string | Non-empty |
| `form` | string | Must be in KBV Darreichungsform map (e.g. `tablette`, `kapsel`, `tropfen`) |
| `strength` | string | e.g. `500 mg` |
| `norm_size` | string | `N1` \| `N2` \| `N3` |
| `aut_idem` | bool | Generic substitution allowed |
| `coverage` | string | `GKV` \| `PKV` \| `Selbstzahler` |
| `is_chronic` | bool | Chronic medications have no `end_date` |
| `start_date` | string | `YYYY-MM-DD` |
| `end_date` | string \| null | Required when `is_chronic = false` |
| `dosage_morning/noon/evening/night` | int | Each ≥ 0 |
| `dosage_unit` | string | `Tablette` \| `Kapsel` \| `ml` \| `IE` \| `Hub` \| `Tropfen` |

**Optional fields:** `dosage_note`, `duration_days`, `visit_id` (links to the creating visit — validated against `ehr_visits`)

**Period tracking:** Each medication stores a `periods` array `[{start_date, end_date}]`. The current open period has `end_date: null`.

**Deactivate vs. Delete:** Medications are never hard-deleted. Deactivation (`DELETE /api/medications/doctor/patient/<pid>/<mid>`) sets `is_active: false` and closes the current open period with `deactivated_at: today`. Reactivation (`PATCH .../reactivate`) reopens a new period.

**FHIR export:** Active medications are exported as three linked resources: `Medication` (KBV_PR_ERP_Medication_PZN), `MedicationRequest` (KBV_PR_ERP_Prescription), and `MedicationStatement` per intake record (last 90 days).

### 4.4 Assign Exercises (`ehr/exercise-form.tsx`)

**Endpoint:** `POST /api/doctor/patient/<patient_id>/exercises`

**Required fields:** `title`, `description`, `category` (mobility / strength / balance / breathing / other), `frequency`, `duration_minutes` (positive int), `order` (int for display ordering)

**Optional fields:** `repetitions`, `sets`, `video_url`, `image_url`, `active` (default `true`), `notes`

**Update:** `PUT /api/doctor/patient/<patient_id>/exercises/<exercise_id>` — any subset of fields.

**Delete:** `DELETE /api/doctor/patient/<patient_id>/exercises/<exercise_id>`

### 4.5 View Patient Data

| Feature | Endpoint |
|---------|---------|
| Vitals history | `GET /api/doctor/patient/<id>/vitals` |
| Visit history | `GET /api/doctor/patient/<id>/visits` |
| Medications | `GET /api/medications/doctor/patient/<id>` |
| Medical profile | `GET /api/doctor/patient/<id>/profile` (update: `PUT`) |
| Documents | `GET /api/doctor/patient/<id>/documents` |
| Exercises | `GET /api/doctor/patient/<id>/exercises` |
| Messages | `GET /api/doctor/patient/<id>/messages` |
| Consent status | `GET /api/doctor/patient/<id>/consent` |
| FHIR Patient | `GET /fhir/Patient/<id>` |

All these endpoints run `check_doctor_patient_access()` which enforces the `authorized_doctors` list (admins bypass).

### 4.6 Sensor Monitoring Alerts

**Endpoint:** `POST /api/monitoring/alert`

**Required fields:** `patient_id`, `sensor_type`, `value`, `unit`. `message` is optional; `severity` is optional (computed if omitted).

**Severity thresholds:**

| Sensor type | Warning | Critical |
|-------------|---------|----------|
| `heart_rate` | 50–100 bpm | 40–130 bpm |
| `glucose` | 70–180 mg/dL | 54–250 mg/dL |
| `spo2` | 94–100% | 90–100% |
| `blood_pressure` | 90–140 mmHg | 80–180 mmHg |

When severity is `critical`, a system message is automatically sent to the first doctor in the patient's `authorized_doctors` list (stored in `ehr_messages` with `sender_id: "system"`).

**List alerts:** `GET /api/monitoring/alerts/?patient_id=<id>` — patients see only their own; doctors/admins must supply `patient_id` and must be authorized.

### 4.7 Clinic Management (`settings/clinics.tsx`)

Doctors manage their clinic affiliations. A clinic aggregates doctors and makes them discoverable to patients via `GET /api/doctors?clinic_id=<id>`.

### 4.8 Facility Reactivation (Admin)

**Endpoint:** `POST /api/consent/admin/reactivate/<patient_id>` (doctor/admin only)

The **only** flow that issues a brand-new pseudonym for a patient. Flow:

1. Delete old pseudonym from gPAS (hard failure)
2. Create fresh pseudonym in gPAS (hard failure)
3. Re-accept in gICS (hard failure; duplicate treated as success)
4. Update `users`, `patient_fhir_identifiers`, `patient_consents`
5. Return `{ pseudonymSuffix: "XXXX" }`

Use this when a facility re-enrolls a patient under a new research cohort requiring a fresh pseudonym. Patient self-reactivation via `POST /api/consent/accept` returns the **same** pseudonym via gPAS idempotency.

---

## 5. Feature Catalogue

| Feature | Who | Endpoints | Notes |
|---------|-----|-----------|-------|
| Blood pressure logging | Patient | `POST /api/patient/vitals` | FHIR Observation, urgency flag auto-computed |
| Vitals history | Patient + Doctor | `GET /api/patient/vitals`, `GET /api/doctor/patient/<id>/vitals` | Sorted newest first |
| Medication schedule | Patient | `GET /api/medications/today` | Grouped by slot, intake upserted on fetch |
| Intake confirmation | Patient | `POST /api/medications/intake/` | Supports intake_id or medication_id+slot+date |
| Adherence heatmap | Patient | `GET /api/medications/adherence` | Period 1–90 days, daily + per-med breakdown |
| Visit history | Patient + Doctor | `GET /api/patient/visits`, `GET /api/doctor/patient/<id>/visits` | Encounter + Condition joined |
| Visit recording | Doctor | `POST /api/doctor/patient/<id>/visits` | ISiK Encounter + Condition created atomically |
| ICD-10-GM AI suggest | Doctor | `POST /api/ehr/icd10-suggest` | Gemini 2.5 Flash, returns 3–5 coded suggestions |
| Medication prescribing | Doctor | `POST /api/medications/patient/` | Full KBV ERP fields, period tracking |
| Medication deactivation | Doctor | `DELETE /api/medications/doctor/patient/<pid>/<mid>` | Soft-delete with period closure |
| Medication reactivation | Doctor | `PATCH .../reactivate` | Opens new treatment period |
| Exercise assignment | Doctor | `POST /api/doctor/patient/<id>/exercises` | 5 categories, video/image support |
| Exercise completion | Patient | `POST /api/patient/exercises/<id>/done` | Sets `last_done_at` |
| Document upload | Patient | `POST /api/patient/documents` | Cloudinary CDN, JPEG/PNG/WebP/PDF ≤ 10 MB |
| Document deletion | Patient | `DELETE /api/patient/documents/<id>` | Removes from Cloudinary + MongoDB |
| Messaging | Patient + Doctor | `GET/POST /api/messages/<user_id>` | FHIR Communication resources |
| Conversation list | Patient + Doctor | `GET /api/messages/conversations` | Unread count per partner |
| Research consent | Patient | `POST /api/consent/accept` | gICS + gPAS, strict flow |
| Consent revoke | Patient | `POST /api/consent/revoke` | Pseudonym retained |
| Consent diagnose | Patient | `GET /api/consent/diagnose` | Live stack health check |
| FHIR full export | Patient | `GET /api/patient/fhir-export` | Full PII bundle |
| FHIR pseudonymised export | Patient | `GET /api/patient/fhir-export/pseudonymised` | Research-safe, pseudonym replaces ID |
| FHIR Patient read | Patient + Doctor | `GET /fhir/Patient/<id>` | de.basisprofil.r4 + ISiKPatient |
| FHIR Patient search | Doctor + Admin | `GET /fhir/Patient?name=&birthdate=&gender=&identifier=` | ISiK Stage 1 search params |
| FHIR MedicationRequest search | Patient | `GET /api/medications/fhir/MedicationRequest/` | KBV ERP searchset Bundle |
| GKV identifier update | Patient | `PUT /api/patient/fhir-identifiers` | Validated KVID-10 format |
| Health Connect sync | Patient (Android) | `POST /api/healthconnect/sync` | Up to 2,000 FHIR Observations per batch |
| Health Connect status | Patient | `GET /api/healthconnect/status` | Last sync time + type counts |
| Health Connect erasure | Patient | `DELETE /api/healthconnect/data` | DSGVO selective erasure |
| Sensor monitoring alerts | Doctor/System | `POST /api/monitoring/alert` | Auto-severity, critical → doctor message |
| Medical profile | Patient + Doctor | `GET/PUT /api/doctor/patient/<id>/profile` | Blood type, allergies, smoking, emergency contact |
| Doctor authorization | Patient | `POST /api/patient/authorize-doctor` | `$addToSet`, idempotent |
| Doctor revocation | Patient | `POST /api/patient/revoke-doctor` | `$pull` |
| Facility reactivation | Admin/Doctor | `POST /api/consent/admin/reactivate/<id>` | New pseudonym from gPAS |
| Account deletion | All | `DELETE /api/auth/delete-account` | DSGVO Art. 17 full erasure |

---

## 6. Backend API Endpoint Index

All endpoints require `Authorization: Bearer <token>` unless marked *(no auth)*.

### Authentication

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/login` | — | Login; returns JWT + user info |
| POST | `/register` | — | Register; creates user + gPAS pseudonym |
| POST | `/api/auth/forgot-password` | — | Generate 6-digit reset code (15 min expiry) |
| POST | `/api/auth/reset-password` | — | Verify code and set new password |
| DELETE | `/api/auth/delete-account` | Any | DSGVO Art. 17 full account erasure |
| GET | `/api/health` | *(no auth)* | Health check; `Cache-Control: no-store` |

### Doctors & Authorization

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/api/doctors?clinic_id=` | Patient | List available doctors (optionally by clinic) |
| GET | `/api/patient/authorized-doctors` | Patient | List authorized doctors |
| POST | `/api/patient/authorize-doctor` | Patient | Add doctor to authorized list |
| POST | `/api/patient/revoke-doctor` | Patient | Remove doctor from authorized list |
| GET | `/api/doctor/patients` | Doctor/Admin | List accessible patients + FHIR ID summary |

### EHR — Vitals

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/patient/vitals` | Patient | Record own vitals (BP + optional weight) |
| GET | `/api/patient/vitals` | Patient | Own vitals history |
| POST | `/api/doctor/patient/<id>/vitals` | Doctor | Record vitals for a patient |
| GET | `/api/doctor/patient/<id>/vitals` | Doctor | Patient vitals history |

### EHR — Visits

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/api/patient/visits` | Patient | Own visit history |
| POST | `/api/doctor/patient/<id>/visits` | Doctor | Record a visit (Encounter + Condition) |
| GET | `/api/doctor/patient/<id>/visits` | Doctor | Patient visit history |

### EHR — ICD-10

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/ehr/icd10-suggest` | Doctor | Gemini ICD-10-GM AI suggestions |
| GET | `/api/ehr/icd10-suggest/test` | *(no auth)* | Gemini connectivity test |

### EHR — Medical Profile

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/api/patient/profile` | Patient | Basic profile for home screen |
| GET | `/api/patient/medical-profile` | Patient | Full medical profile + FHIR IDs |
| GET | `/api/doctor/patient/<id>/profile` | Doctor | Patient medical profile |
| PUT | `/api/doctor/patient/<id>/profile` | Doctor | Create/update patient medical profile |

### EHR — Exercises

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/api/patient/exercises` | Patient | Own active exercises |
| POST | `/api/patient/exercises/<id>/done` | Patient | Mark exercise done/undone |
| POST | `/api/doctor/patient/<id>/exercises` | Doctor | Assign exercise |
| GET | `/api/doctor/patient/<id>/exercises` | Doctor | List patient exercises |
| PUT | `/api/doctor/patient/<id>/exercises/<eid>` | Doctor | Update exercise |
| DELETE | `/api/doctor/patient/<id>/exercises/<eid>` | Doctor | Delete exercise |

### EHR — Documents

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/api/patient/documents` | Patient | Own documents |
| POST | `/api/patient/documents` | Patient | Upload document (Cloudinary) |
| DELETE | `/api/patient/documents/<id>` | Patient | Delete document |
| GET | `/api/doctor/patient/<id>/documents` | Doctor | Patient documents |

### EHR — Messages

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/api/messages/conversations` | Any | All conversation partners + unread counts |
| GET | `/api/messages/unread-count` | Any | Total unread count |
| GET | `/api/messages/<other_user_id>` | Any | Thread with one user |
| POST | `/api/messages/<other_user_id>` | Any | Send message |
| GET | `/api/doctor/patient/<id>/messages` | Doctor | Doctor–patient thread |

### Medications

All under prefix `/api/medications/`

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `patient/` | Doctor | Prescribe medication |
| GET | `patient` or `my` | Patient | Own active medications |
| GET | `doctor/patient/<id>` | Doctor | Patient medications |
| PUT | `doctor/patient/<pid>/<mid>` | Doctor | Update dosage/unit/note/status |
| DELETE | `doctor/patient/<pid>/<mid>` | Doctor | Deactivate (soft delete) |
| PATCH | `doctor/patient/<pid>/<mid>/reactivate` | Doctor | Reactivate medication |
| POST | `intake/` or `intake/<id>` or `patient/<id>/intake` | Patient | Confirm intake |
| GET | `today` or `patient/intakes` | Patient | Today's schedule + intake status |
| GET | `adherence?period_days=28` | Patient | Adherence stats + heatmap data |
| GET | `fhir/MedicationRequest/` | Patient | FHIR searchset Bundle |

### Consent

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/api/patient/consent` | Patient | Own consent status + masked pseudonym |
| POST | `/api/patient/consent` | Patient | Grant (legacy soft flow) |
| DELETE | `/api/patient/consent` | Patient | Revoke (legacy soft flow) |
| GET | `/api/doctor/patient/<id>/consent` | Doctor | Patient consent (read-only) |
| POST | `/api/consent/accept` | Patient | Grant (strict: gICS + gPAS hard failures) |
| POST | `/api/consent/revoke` | Patient | Revoke (strict) |
| GET | `/api/consent/status` | Patient | Live gICS query |
| GET | `/api/consent/diagnose` | Patient | Full stack diagnostic |
| POST | `/api/consent/admin/reactivate/<id>` | Doctor/Admin | Facility reactivation (new pseudonym) |

### FHIR

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/api/patient/fhir-profile` | Patient | Own FHIR Patient resource |
| PUT | `/api/patient/fhir-identifiers` | Patient | Update GKV, phone, address |
| GET | `/fhir/Patient/<id>` | Patient/Doctor | FHIR Patient read |
| GET | `/fhir/Patient?...` | Doctor/Admin | FHIR Patient search (ISiK Stage 1 params) |
| GET | `/api/patient/fhir-export` | Patient | Full FHIR R4 document Bundle |
| GET | `/api/patient/fhir-export/pseudonymised` | Patient | Research-safe pseudonymised Bundle |
| GET | `/metadata` | *(no auth)* | FHIR CapabilityStatement |

### Health Connect

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/healthconnect/sync` | Patient | Batch sync FHIR Observations (≤ 2,000) |
| GET | `/api/healthconnect/status` | Patient | Sync status + per-type counts |
| DELETE | `/api/healthconnect/data` | Patient | Selective DSGVO erasure of HC data |

### Monitoring

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/api/monitoring/alert` | Any | Record sensor alert |
| GET | `/api/monitoring/alerts/` | Patient/Doctor | List alerts (patient: own; doctor: by patient_id) |

---

## 7. Navigation Graph

```
(auth) group — unauthenticated
├── /login                          ← default entry for unauthenticated users
│    ├── → /register
│    └── → /forgot-password
└── /register
     └── → /login (after success)

(app) group — requires valid JWT
├── (tabs)
│    ├── index [PATIENT ONLY]       ← redirects doctors to doctor-dashboard
│    │    ├── → /(app)/log/vitals
│    │    ├── → /(app)/ehr/visits
│    │    ├── → /(app)/ehr/messages
│    │    ├── → /(app)/ehr/documents
│    │    ├── → /(app)/ehr/exercises
│    │    └── → /(app)/ehr/medications
│    │
│    ├── doctor-dashboard [DOCTOR/ADMIN ONLY]
│    │    ├── PatientDataView (inline, no navigation)
│    │    └── → /(app)/settings/clinics
│    │
│    └── profile (all roles)
│         ├── [PATIENT] → /(app)/ehr/patient-profile
│         ├── [PATIENT] → /(app)/log/vitals
│         ├── [PATIENT] → /(app)/settings/doctors
│         ├── [PATIENT] → /(app)/ehr/consent
│         ├── [PATIENT] → /(app)/ehr/fhir-export
│         ├── [PATIENT, Android] → /(app)/settings/health-connect
│         ├── [DOCTOR] → /(app)/(tabs)/doctor-dashboard
│         └── [DOCTOR] → /(app)/settings/clinics
│
├── ehr/
│    ├── consent
│    │    └── pseudonymised FHIR export (inline — no navigation away)
│    ├── documents
│    ├── exercise-form           ← params: patient_id, patient_name, exercise_id?
│    ├── exercises
│    ├── fhir-export
│    ├── medications
│    ├── messages                ← params: other_user_id?, other_user_name?, other_user_type?
│    ├── patient-profile
│    ├── visit-form              ← params: patient_id, patient_name
│    └── visits
│
├── log/
│    └── vitals
│
└── settings/
     ├── clinics
     ├── doctors
     └── health-connect
```

---

## 8. Infrastructure & Docker Stack

The local development stack is defined in `docker-compose.yml` and consists of six services:

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| `backend` | Local build | 5000 | Flask/Python API server |
| `frontend` | Local build | 8081 | Expo web build (static, served by nginx) |
| `mysql` | `mariadb:10.11` | (internal) | Shared database for gPAS + gICS |
| `gpas` | `mosaicgreifswald/gpas:latest` | 8080 | gPAS pseudonymisation SOAP service |
| `gics` | `mosaicgreifswald/gics:latest` | 8082 | gICS informed-consent SOAP service |
| `gpas-schema-fix` | `mariadb:10.11` | — | One-shot DB migration (restart: "no") |
| `gics-schema-fix` | `mariadb:10.11` | — | One-shot DB migration (restart: "no") |

**Startup sequence:** `mysql` must be healthy before anything else starts. `backend` waits for `mysql` (healthy), `gpas` (started), and `gics` (started). The backend handles gPAS/gICS being temporarily unavailable via graceful null-pseudonym fallback.

**Schema fix services:** gPAS and gICS use EclipseLink JPA DDL that generates columns too narrow for MariaDB's UTF-8 MB4 index limits. The `gpas-schema-fix` and `gics-schema-fix` services poll for the tables to exist, then widen columns and fix primary key prefix lengths. They run once (`restart: "no"`) and do not block startup.

**Cloud deployment:** The backend is deployed on **Render.com** (free tier). gICS and gPAS are **not** deployed to the cloud — they run only in the local Docker stack. Cloud API requests to consent/pseudonymisation endpoints receive a 502 that the mobile client surfaces as "Please visit your hospital".

### Environment Variables (Backend)

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `MONGO_URI` | ✓ | — | MongoDB Atlas connection string |
| `SECRET_KEY` | ✓ | — | JWT signing key |
| `CLOUDINARY_CLOUD_NAME` | ✓ | — | Document upload CDN |
| `CLOUDINARY_API_KEY` | ✓ | — | |
| `CLOUDINARY_API_SECRET` | ✓ | — | |
| `GICS_URL` | — | `http://gics:8080` | gICS container URL |
| `GICS_DOMAIN` | — | `morafek-data-sharing` | Consent domain name |
| `GICS_SIGNER_ID_TYPE` | — | `morafek-patient-id` | gICS signer ID type |
| `GICS_TIMEOUT` | — | `10` | Request timeout in seconds |
| `GPAS_URL` | — | `http://gpas:8080` | gPAS container URL |
| `GPAS_DOMAIN` | — | `morafek-patients` | Pseudonym domain |
| `GPAS_TIMEOUT` | — | `5` | Request timeout in seconds |
| `GPAS_ENABLED` | — | `true` | Set `false` to skip gPAS (local dev without full stack) |
| `GEMINI_API_KEY` | — | — | Required for ICD-10-GM AI suggest |
| `GICS_LOG_SOAP` | — | `0` | Set `1` to log outbound SOAP envelopes at INFO level |

### CORS Policy

Allowed origins are maintained in `config.py` (`ALLOWED_ORIGINS` list + `ALLOWED_ORIGIN_PATTERNS` regex list). Vercel preview deployments matching `https://morafek*.vercel.app` are automatically allowed. The `X-Client-Type` header is in the allowed headers list and must be present for mobile token issuance.

---

## 9. MongoDB Collections

| Collection | Contents | Key indexes |
|-----------|---------|------------|
| `users` | All user accounts (patients, doctors, admins). Patients have `authorized_doctors[]`, `ehr_profile`. Doctors have `clinic_ids[]`, optional `lanr`. | username, email |
| `patient_fhir_identifiers` | GKV KVID, address, phone, pseudonym. One doc per patient. | `patient_id` (unique), `gkv_kvid` (sparse), `pseudonym` (sparse) |
| `patient_consents` | Consent status, granted_at, revoked_at, gics_consent_id, pseudonym. | `patient_id` (unique) |
| `patient_profiles` | Extended medical profile (blood type, height, allergies, etc.). | `patient_id` |
| `ehr_vitals` | FHIR Observation docs for vitals (manual + Health Connect). | `patient_id`, compound `(patient_id, source, synced_at)` for HC queries, `id` sparse for HC upsert |
| `ehr_visits` | FHIR Encounter docs. | `patient_id` |
| `ehr_conditions` | FHIR Condition docs, linked to encounters via `encounter_id`. | `patient_id` |
| `ehr_documents` | FHIR DocumentReference docs. Cloudinary URL stored in `content[0].attachment.url`. | `patient_id` |
| `ehr_messages` | FHIR Communication docs. `sender_id`, `recipient_id`, `read`. | `patient_id` (via sender/recipient) |
| `ehr_exercises` | Exercise assignments. `active`, `order`, `last_done_at`. | `patient_id` |
| `medications` | Medication prescriptions. `is_active`, `periods[]`, `dosage_*` slots. | `patient_id`, `doctor_id`, `visit_id` |
| `med_schedules` | Daily schedule markers (currently used for future date-range scheduling). | `(medication_id, patient_id, date)` |
| `med_intakes` | One doc per medication + patient + date + slot. Status: `pending` \| `taken` \| `skipped`. | `(patient_id, date)`, `medication_id` |
| `monitoring_alerts` | Sensor alerts with severity. | `patient_id`, `sensor_type` |
| `clinics` | Clinic records with `doctors[]` list. | — |

---

## 10. Edge Cases & System Guards

### 10.1 Render Free-Tier Cold Start

The Render.com free tier spins down dynos after inactivity. Cold starts take 30–60 s.

**Mitigation:** `wakeUpServer()` in `client.ts` polls `GET /api/health` every 5 s for up to 90 s before login/registration attempts. The login screen renders a `WakeUpBanner` with an animated progress bar (0→100%) during the poll. On timeout, a clear error message is shown.

This flow is **skipped entirely** for local backends (URL contains `localhost` or `127.0.0.1`).

### 10.2 gICS/gPAS Unavailable from Cloud

gICS and gPAS run only in the local Docker stack. From the cloud Render backend they are unreachable and return 502.

`acceptConsent()` in `consent.ts` detects this: when `IS_LOCAL_BACKEND === false`, a 502 or `ERR_BAD_RESPONSE` is caught and rethrown as `Error('TTP_UNAVAILABLE')`. The consent screen displays a calm "🏥 Please visit your hospital" card rather than a raw error banner.

### 10.3 401 Startup Race Condition

Some screens (e.g. doctor dashboard) mount and fire authenticated requests before `SecureStorage` has finished hydrating the token. The old code wiped credentials on any 401, logging users out spuriously.

**Fix (in `client.ts`):** On 401, the response interceptor checks if a token is actually stored. If a token exists, the session is preserved and a warning is logged. Only if no token is present (genuine unauthenticated state) is `USER_DATA` cleared.

### 10.4 Token Expiry

JWTs contain an `exp` claim. On `checkAuth()`, `isTokenValid()` decodes the payload client-side and compares `exp` to the current epoch. An expired token is cleared immediately, and the user is redirected to login without a server round-trip.

### 10.5 Expo Go Push Notification Limitation

`expo-notifications` remote push registration (`DevicePushTokenAutoRegistration`) is banned in Expo Go SDK 53+. This module fires as a side effect at import time, crashing the app at route-scan.

**Fix (in `ehr/medications.tsx`):** The top-level `import * as Notifications from 'expo-notifications'` is replaced with a lazy `const Notifications = await import('expo-notifications')` inside `scheduleMedicationNotifications()`. The import only runs when the function is called (after navigation), never at route-scan time. Local scheduled notifications (the only feature used) continue to work normally.

### 10.6 Duplicate Visit Submission

The Visit Form save button is **disabled after the first successful save** (`isVisitSaved = Boolean(successMsg)`). This prevents double-tapping from creating duplicate visit records.

### 10.7 Consent Store Rehydration

`pseudonymSuffix` is held in the Zustand store (in-memory). On app restart the store resets. The consent screen's `loadStatus()` checks `AsyncStorage` (`@caremate/pseudonym_suffix`) and calls `setPseudonymSuffix()` if the store is empty but the key exists. This ensures the pseudonymised export button remains active across restarts without a server round-trip.

### 10.8 Network Error vs Server Error

The Axios response interceptor applies **4-retry exponential back-off** (2 s → 4 s → 8 s → 15 s cap) for:
- `ECONNABORTED` (timeout)
- `ERR_NETWORK` / "Network Error"
- No response at all
- HTTP 502, 503, 504

Callers can set `__noRetryOn5xx: true` on the request config to skip server-error retries. This is used by `acceptConsent()` — a 502 from the cloud backend is permanent (TTP unreachable), not a transient cold-start that would benefit from retrying.

### 10.9 GPAS_ENABLED=false Mode

When `GPAS_ENABLED=false` is set in the backend environment (e.g. local dev without the full Docker stack), gPAS calls are skipped entirely. Consent is still recorded in gICS and MongoDB; the pseudonym field is left `null`. The export falls back to using the MongoDB `_id` as the FHIR Patient ID. This flag is checked in `accept_consent`, `admin_reactivate_consent`, and the registration flow.

### 10.10 ICD-10 AI Suggest Unavailability

If `GEMINI_API_KEY` is not set in the environment, `POST /api/ehr/icd10-suggest` returns 503 immediately without hitting the Gemini API. The mobile form should handle this gracefully and fall back to manual ICD code entry. If the API key is set but Gemini returns an error, the endpoint returns 502 with `detail` containing the exact error message for debugging.

### 10.11 Health Connect Batch Validation

Invalid observations in a batch do not abort the entire sync. Each observation is validated independently; failures are counted in the `errors` array and `skipped` count. A 422 is only returned if **every** observation in the batch fails. This ensures that a single malformed record (e.g. missing UUID) cannot block hundreds of valid heart-rate readings.

### 10.12 FHIR Export — Empty ICD Codes

Conditions without a `code.coding` entry (visits recorded before ICD coding was optional) are silently skipped from the FHIR export. Their references in `Encounter.diagnosis` are also cleaned up to keep the bundle self-contained (FHIR R4 §3.3 document bundle rule: all referenced resources must be present).

### 10.13 gPAS Pseudonym at Registration

gPAS pseudonym creation at registration is fire-and-forget. If gPAS is unreachable (e.g. still booting in Docker), the user is registered successfully and a warning is logged. The pseudonym is then created lazily on the next call to `gpas.get_or_create()` — which happens when the patient first grants consent.

---

## 11. Offline Behaviour

The app uses SQLite via `expo-sqlite` (`services/offline/db.ts`) on Android/iOS, with an in-memory fallback for Expo Web.

### Database Tables

| Table | Contents | Cleared when |
|-------|----------|-------------|
| `vitals` | Cached vital readings (last 50) | Never (LRU via `INSERT OR REPLACE`) |
| `visits` | Cached visit records | Never |
| `pending_vitals` | Vitals queued when network unavailable | After successful sync |
| `pending_medication_intakes` | Intake confirmations queued offline | After successful sync |
| `today_medications_cache` | Today's medication schedule | On next successful fetch |

### Offline Flows

**Blood pressure reading (offline):**
1. `POST /api/patient/vitals` fails with network error
2. `queueVital()` saves to `pending_vitals` with a local ID
3. Yellow banner: "📥 Saved locally — will sync when online"
4. Next time the vitals screen loads, `syncPendingVitals()` flushes the queue

**Medication intake confirmation (offline):**
1. `POST /api/medications/intake/` fails
2. `queueMedicationIntake()` saves to `pending_medication_intakes`
3. UI reverts to previous state — a toast shows "Saved offline. Will sync when connection is restored."
4. On next medications screen mount, `syncPendingIntakes()` flushes the queue

**Today's medication schedule (offline):**
1. `GET /api/medications/today` fails
2. `getCachedTodayMedications()` reads from `today_medications_cache`
3. Yellow banner: "⚠️ Showing cached data"

---

## 12. Data & Privacy

### DSGVO Compliance

| Mechanism | Implementation |
|-----------|---------------|
| Right to erasure (Art. 17) | `DELETE /api/auth/delete-account` — wipes all patient data server-side including `patient_fhir_identifiers` (GKV number) |
| Selective HC erasure (Art. 17) | `DELETE /api/healthconnect/data` — removes only Health Connect sourced records, leaving manual vitals intact |
| Research consent (Art. 9) | gICS broad consent management; revocable at any time in-app |
| Data minimisation | Pseudonymised export never includes name/contact; full pseudonym never leaves server |
| Local-only Health Connect | Wearable data read from device and sent directly to the app backend; no Google server involvement |
| Audit trail | gPAS pseudonym intentionally retained after account deletion (Treuhandstelle compliance) |

### Token Storage

Auth tokens are stored in `expo-secure-store` (iOS Keychain / Android Keystore) via the `secureStorage` utility. They are never written to AsyncStorage or any unencrypted location.

### Pseudonym Architecture

- The full gPAS pseudonym is **never sent to the mobile client**
- Only the last 4 characters (`pseudonymSuffix`) are transmitted and stored (locally in AsyncStorage + in Zustand store)
- Displayed in the UI as `****XXXX`
- Used solely for display — never sent back to the server in any request
- The pseudonym is stored server-side in both `users.pseudonym` and `patient_fhir_identifiers.pseudonym` (mirrored for the FHIR export pipeline)

### gPAS Pseudonym Lifecycle

| Event | Action |
|-------|--------|
| Patient registration | `get_or_create()` called (fire-and-forget) |
| Consent grant (strict) | `get_or_create_pseudonym()` called (hard failure) |
| Consent revoke | Pseudonym **retained** in gPAS + MongoDB |
| Patient re-grants consent | Same pseudonym returned (gPAS idempotent) |
| Account deletion | Local cache (`patient_fhir_identifiers`) deleted; gPAS record **retained** |
| Admin reactivation | Old pseudonym deleted from gPAS; new pseudonym created |

### Consent Dual-Flow

Two consent flows exist for different use cases:

**Soft flow** (`POST /api/patient/consent`): gICS and gPAS failures are fire-and-forget. MongoDB is always written. Used for integrations where TTP unavailability should not block the user. `status: "granted"` may be recorded even without a pseudonym.

**Strict flow** (`POST /api/consent/accept`): gICS and gPAS failures are hard (502). MongoDB is written **only after** both external services succeed. On gPAS failure, the gICS consent is rolled back. This is the flow used by the mobile app's consent screen.

### API Security

- All requests carry `Authorization: Bearer <token>` injected by the Axios request interceptor
- The `X-Client-Type: mobile` header signals the backend to issue 90-day tokens instead of 24-hour tokens
- All communication uses HTTPS (enforced at the backend/infrastructure level)
- The `token_required` decorator skips auth for `OPTIONS` requests (CORS preflight)
- CORS is enforced with an explicit allowlist; all Vercel preview deployments for the project are automatically allowed via regex pattern
