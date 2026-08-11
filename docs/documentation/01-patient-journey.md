# Part 1 — Patient Journey

> Morafek CareMate · Patient-facing features, dashboard, and Health Connect sync
> Platform: React Native (Expo ~54, Router ~6) · Backend: Flask 3.1 / MongoDB Atlas
> Part of a 3-part documentation set — see [`README.md`](README.md) for the other parts.

---

## Table of Contents

1. [Getting In: Registration & Login](#1-getting-in-registration--login)
2. [Patient Home Dashboard](#2-patient-home-dashboard)
3. [Recording Blood Pressure](#3-recording-blood-pressure)
4. [Medications](#4-medications)
5. [Visits](#5-visits)
6. [Messaging Your Doctor](#6-messaging-your-doctor)
7. [Documents](#7-documents)
8. [Exercises](#8-exercises)
9. [Medical Profile](#9-medical-profile)
10. [Managing Authorized Doctors & Data-Sharing](#10-managing-authorized-doctors--data-sharing)
11. [Research Consent](#11-research-consent)
12. [FHIR Export](#12-fhir-export)
13. [Health Connect Sync (Android)](#13-health-connect-sync-android)
14. [Account & Privacy Controls](#14-account--privacy-controls)
15. [Offline Behaviour](#15-offline-behaviour)
16. [Patient API Reference](#16-patient-api-reference)

---

## 1. Getting In: Registration & Login

### Roles at a glance

The app supports four `user_type` values: `patient`, `doctor`, `researcher`, `admin`. Role is chosen at registration/login and stored in the JWT — it's never editable in-app. This document covers the **patient** role only; see [Part 2](02-doctor-journey.md) for doctor and [Part 3](03-research-admin-consent.md) for researcher/admin.

### Registration (`POST /register`)

**Required:** `username`, `email`, `password`, `firstName`, `lastName`, `dateOfBirth`, `user_type: "patient"`

**Optional:** `gkv_kvid` — the German statutory health insurance number (format: 1 uppercase letter + 9 digits, e.g. `A123456789`). Validated server-side; an invalid format returns a 400 with a German error message. Stored in `patient_fhir_identifiers` for later FHIR export.

**What happens behind the scenes:**
1. A user document is created with `authorized_doctors: []` and an empty `ehr_profile`.
2. `gpas.get_or_create(user_id)` is called **fire-and-forget** to pre-assign a research pseudonym. If gPAS is unreachable at registration time, this is not an error — registration still succeeds and the pseudonym is created lazily the first time the patient grants research consent.

Username and email must be unique. On success (201), the patient is sent to the login screen.

### Login (`POST /login`)

Body: `{ username, password, user_type: "patient" }`. The backend looks up `{username, user_type}` together, so a patient and a doctor can share the same username string without collision.

**Screen:** teal hero header, a role-chip selector (🧑 Patient / 👨‍⚕️ Doctor / 🔬 Researcher / 🛡️ Admin — patient is the default), username/password fields, a tappable demo-account box, and a DSGVO trust bar ("DSGVO compliant · End-to-end encrypted · FHIR R4").

**Token lifetime:** mobile clients (sending `X-Client-Type: mobile`) receive a **90-day** JWT; web sessions receive a 24-hour token.

**Cold-start handling:** before submitting login, the app calls `wakeUpServer()`, which polls `GET /api/health` every 5 s for up to 90 s. This exists because the backend runs on Render's free tier, which spins down after inactivity (30–60 s cold start). A `WakeUpBanner` with an animated progress bar is shown during the wait; the poll is skipped entirely when talking to a local/`localhost` backend. If it times out, the user sees "The server is waking up. Please wait a moment and try again."

### Forgot password

Two steps:
1. `POST /api/auth/forgot-password` `{ email }` — generates a 6-digit code with a 15-minute expiry. Always returns 200 with a neutral message, regardless of whether the email exists (no account enumeration).
2. `POST /api/auth/reset-password` `{ email, code, new_password }` — validates the code and expiry, then sets the new password.

### Session lifecycle

- **Cold start:** on app launch, `useAuth()` reads the token from `expo-secure-store`. If present, its `exp` claim is checked client-side (no network round-trip); if valid, the user is dropped straight into the app. The server independently re-validates the signature on every authenticated request.
- **Logout:** clears the token and cached user data from secure storage and the in-memory store, then the navigation guard redirects to `/login`.
- **Token storage:** auth tokens live only in `expo-secure-store` (iOS Keychain / Android Keystore) — never in `AsyncStorage` or anywhere unencrypted.

---

## 2. Patient Home Dashboard

`(tabs)/index.tsx` is the default landing screen for the `patient` role (doctors/admins are redirected to their own dashboard; researchers are redirected to the Profile tab — see [Part 3](03-research-admin-consent.md)).

On mount, it loads three things in parallel:

| Data | Source | If it fails |
|---|---|---|
| Latest vital reading | `GET /api/patient/vitals` (limit 1) | Falls back to the local SQLite cache |
| Most recent visit | `GET /api/patient/visits` | Shows "No visits" |
| Today's medication count | `GET /api/medications/today` | Badge is silently hidden |

**Layout:**
- Teal header with a time-of-day greeting and an **SOS button** that dials 112.
- **Blood Pressure card** — latest systolic/diastolic/pulse with a colour-coded status badge (🟢 Normal / 🟠 Elevated / 🔴 High / ⚠️ Crisis) and an "Add Reading" shortcut.
- **Last Visit card** — date and diagnosis of the most recent doctor visit.
- A 2-column grid of shortcuts: Visits, Messages, Documents, Exercises, Medications (with an unread/pending badge).
- A "Connected Sensors" placeholder for future heart-rate/CGM/SpO2 wearable integrations.

---

## 3. Recording Blood Pressure

**Screen:** `log/vitals.tsx` · **Endpoint:** `POST /api/patient/vitals`

1. Pre-measurement instructions are shown (sit 5 minutes, left arm, no talking).
2. **Systolic** and **Diastolic** are required — a live colour-coded badge (Normal/Elevated/High/Crisis) updates as the patient types.
3. **Pulse** is required.
4. **Weight (kg)** is optional and stored as a separate FHIR component (LOINC `29463-7`).
5. Free-text **notes** are optional.

**Urgency is computed server-side only** — the client cannot set or override it: `urgent = systolic > 180 OR diastolic > 120`. A `urgent: true` response shows a red "Critical reading — contact doctor" banner; otherwise a green confirmation banner is shown and the screen closes after 1.5 s.

**Offline:** if the POST fails on a network error, the reading is queued into SQLite (`queueVital()`) and a yellow "Saved locally" banner appears. Any queued readings are flushed (`syncPendingVitals()`) the next time the vitals screen loads, before a new submission is sent.

**Storage:** the reading is stored as a FHIR R4 `Observation` in `ehr_vitals`, profiled for `de.basisprofil.r4` / ISiK, with each vital split into its own LOINC-coded component (systolic `8480-6`, diastolic `8462-4`, heart rate `8867-4`, weight `29463-7`).

---

## 4. Medications

**Screen:** `ehr/medications.tsx`

### Today tab

`GET /api/medications/today` returns medications active today, grouped by dosing slot (Morgens / Mittags / Abends / Nachts — morning/noon/evening/night), each collapsible with a taken/pending count and an overall adherence progress bar.

```json
{
  "date": "2026-08-11",
  "slots": {
    "morning": [{ "medication": {...}, "intake_id": "...", "status": "pending", "dosage": 1, "unit": "Tablette" }],
    "noon": [], "evening": [], "night": []
  },
  "summary": { "total": 3, "taken": 1, "pending": 1, "skipped": 1 }
}
```

Calling this endpoint upserts an intake record (`status: pending`) for every non-zero dosage slot due today — it's idempotent, so refreshing the screen never creates duplicates.

### Confirming a dose

```
Tap "Taken" or "Skipped"
  └─ POST /api/medications/intake/  { intake_id, status, note }
       ├─ Online  → confirms immediately, adherence bar recalculates
       └─ Offline → queued to SQLite, toast: "Saved offline. Will sync when connection is restored."
```

### My Medications tab

`GET /api/medications/my` lists the full active medication list — PZN, dosage label, coverage type (GKV/PKV/Selbstzahler), start/end dates, chronic flag. Tapping a row opens `MedicationDetailModal`.

### Adherence

`GET /api/medications/adherence?period_days=28` returns an `overall_rate` (0–1), a daily breakdown for the heatmap component, and a per-medication breakdown.

### Notifications

On mount, `scheduleMedicationNotifications()` lazily imports `expo-notifications` (only when called, not at module load — see [§ Edge case: Expo Go push limitation](#note-notifications)) and schedules a local reminder for each pending slot time.

<a id="note-notifications"></a>
> **Why the lazy import matters:** `expo-notifications`' remote push registration is banned in Expo Go SDK 53+ and crashes the app at route-scan time if imported at the top of the file. The fix uses `const Notifications = await import('expo-notifications')` inside the scheduling function itself — local scheduled notifications (the only feature actually used here) work fine.

---

## 5. Visits

**Screen:** `ehr/visits.tsx` · **Endpoint:** `GET /api/patient/visits`

Lists every doctor visit, newest first — date, chief complaint, and ICD-10-GM diagnosis if one was recorded. Tapping a row opens `VisitDetailModal` with the full clinical note. Each entry joins a FHIR `Encounter` (`ehr_visits`) with its linked `Condition` (`ehr_conditions`) via a shared `encounter_fhir_id`.

---

## 6. Messaging Your Doctor

**Screen:** `ehr/messages.tsx`

| Endpoint | Purpose |
|---|---|
| `GET /api/messages/conversations` | All conversation partners, last message preview, unread count each |
| `GET /api/messages/<other_user_id>` | Full thread with one person, oldest → newest |
| `POST /api/messages/<other_user_id>` | Send a message — `{ body }` |
| `GET /api/messages/unread-count` | Total unread badge count |

Messages are stored as FHIR `Communication` resources in `ehr_messages`. System-generated critical alerts (see [Part 2 §6, Sensor Monitoring Alerts](02-doctor-journey.md#6-sensor-monitoring-alerts)) also land in this same thread, from `sender_id: "system"`.

---

## 7. Documents

**Screen:** `ehr/documents.tsx` · **Upload:** `POST /api/patient/documents` (multipart/form-data)

| Field | Required | Notes |
|---|---|---|
| `file` | ✓ | JPEG, PNG, WebP, or PDF — max 10 MB |
| `description` | ✓ | Short label |
| `category` | — | `lab_report` \| `imaging` \| `prescription` \| `other` (default) |
| `encounter_id` | — | Links the document to a specific visit |

Files are streamed to **Cloudinary** (`morafek/documents/`); the returned `secure_url` is stored on the FHIR `DocumentReference.content[0].attachment.url`, alongside the `cloudinary_public_id` for later deletion.

| Category | LOINC | Display |
|---|---|---|
| `lab_report` | `11502-2` | Laboratory report |
| `imaging` | `18748-4` | Diagnostic imaging study |
| `prescription` | `57833-6` | Prescription for medication |
| `other` | `34133-9` | Summary of episode note |

`DELETE /api/patient/documents/<id>` removes the file from Cloudinary first, then the record from MongoDB. `GET /api/patient/documents` lists all documents, newest first.

---

## 8. Exercises

**Screen:** `ehr/exercises.tsx` · **Endpoint:** `GET /api/patient/exercises`

Shows only active exercises (`active: true`), sorted by the doctor-assigned `order`. Each shows title, description, category (mobility / strength / balance / breathing / other), frequency, duration, reps/sets, and optional video/image.

**Mark done:** `POST /api/patient/exercises/<id>/done` with `{ "done": true }` sets `last_done_at`; `{ "done": false }` clears it.

---

## 9. Medical Profile

**Screen:** `ehr/patient-profile.tsx`

| Endpoint | Purpose |
|---|---|
| `GET /api/patient/medical-profile` | Full profile including a FHIR identifier summary |
| `GET /api/patient/fhir-profile` | The patient's own FHIR `Patient` resource (`de.basisprofil.r4` + ISiKPatient) |
| `PUT /api/patient/fhir-identifiers` | Update German health identifiers (GKV, phone, address) |

**Editable fields:** date of birth, gender, blood type, height/weight, allergies, chronic conditions, current medications, smoking status, emergency contact, free-text notes.

**FHIR identifiers** (`patient_fhir_identifiers`): `gkv_kvid` (validated 1 letter + 9 digits), `phone`, `street`, `postal_code`, `city`. The GKV number is masked in every API response as `A123••••••`.

---

## 10. Managing Authorized Doctors & Data-Sharing

A doctor can only see a patient's data once the patient has explicitly authorized them — this is the base access gate, described fully from the doctor's side in [Part 2 §1](02-doctor-journey.md#1-patient-authorization-model).

**Screen:** `settings/doctors.tsx`

| Endpoint | Purpose |
|---|---|
| `GET /api/doctors?clinic_id=<optional>` | Browse available doctors, optionally scoped to a clinic |
| `GET /api/patient/authorized-doctors` | List currently authorized doctors |
| `POST /api/patient/authorize-doctor` `{ doctor_id }` | Grant access (idempotent — `$addToSet`) |
| `POST /api/patient/revoke-doctor` `{ doctor_id }` | Revoke access (`$pull`) |

### A second, independent gate: doctor data-sharing

On top of the authorization list above, a patient can flip a single master switch that overrides every authorized doctor's read access at once:

`GET` / `POST /api/patient/doctor-sharing` — body `{ "enabled": true | false }`.

This is **ANDed** with the authorization check — it can only *remove* access an authorized doctor would otherwise have, never grant access the authorization list doesn't already allow. It gates vitals, consent status, and FHIR `Patient` reads identically. New patients (and anyone who has never touched the toggle) default to `enabled: true`, specifically so this feature didn't silently cut off doctor access for the existing patient base when it shipped.

```
doctor_can_read(doctor, patient) =
    doctor_id in patient.authorized_doctors
    AND patient_identifiers[patient].doctor_sharing == true
```

Use this when you want to authorize a doctor for the record but temporarily pause their access — e.g. between appointments — without re-doing the authorization step later.

---

## 11. Research Consent

**Screen:** `ehr/consent.tsx`

Morafek can pseudonymise and mirror a patient's vitals into a separate, de-identified research dataset (see [Part 3](03-research-admin-consent.md) for the full architecture) — but only for patients who explicitly opt in via this screen. Two backend flows exist; the app uses the **strict** one.

### Granting consent (`POST /api/consent/accept`)

```
1. Check gICS — if status is already ACCEPTED, skip re-submitting (idempotent)
2. Submit addConsent to gICS      (hard failure → 502; a duplicate-consent fault counts as success)
3. Call gPAS getOrCreatePseudonymFor  (hard failure → roll back the gICS consent → 502)
4. Write MongoDB only after both external calls succeeded
5. Return { pseudonymSuffix: "XXXX" }  — last 4 characters only
```

**The full pseudonym never reaches the mobile client.** Only the last 4 characters are returned, shown in the UI as `****XXXX`, and cached in `AsyncStorage` so the pseudonymised-export button stays enabled across app restarts without an extra server round-trip.

### Revoking (`POST /api/consent/revoke`)

Revokes in gICS and marks the local record `status: "revoked"`. The pseudonym itself is **not** deleted — re-granting consent later returns the exact same pseudonym (gPAS's create call is idempotent), and any vitals already mirrored for research under that pseudonym are **not** retroactively removed. Revoking only stops *future* mirroring; deleting already-shared data is a separate, admin-mediated erasure step (see [Part 3 §5](03-research-admin-consent.md#5-erasure-requests-a-two-step-destructive-action)).

### Status & diagnostics

- `GET /api/consent/status` — live query against gICS: `ACCEPTED` \| `REJECTED` \| `UNKNOWN`.
- `GET /api/consent/diagnose` — a structured health check of gICS, gPAS, the consent status, and the MongoDB record, useful for support/debugging.

### When the cloud backend can't reach gICS/gPAS

gICS and gPAS only run in the local Docker development stack, not on the cloud (Render) deployment. When the app is talking to the cloud backend, `acceptConsent()` detects the resulting 502 and shows a calm "🏥 Please visit your hospital" card instead of a raw error.

---

## 12. FHIR Export

Two export options, both from the Profile screen (`ehr/fhir-export.tsx`):

| Export | Endpoint | Contains |
|---|---|---|
| Full | `GET /api/patient/fhir-export` | Complete FHIR R4 document Bundle with all PII: Composition, Patient (name/telecom/address), Observations, Encounters, Conditions, DocumentReferences, Medication/MedicationRequest/MedicationStatement (last 90 days of intake history) |
| Pseudonymised | `GET /api/patient/fhir-export/pseudonymised` | Identical clinical content, but the Patient resource is stripped to pseudonym + GKV-KVID + gender + birthDate. All `Patient/<mongo_id>` references are rewritten to `Patient/<pseudonym>`. Requires `granted` consent and a pseudonym on record (falls back to the Mongo `_id` if none exists yet) |

Both bundles conform to FHIR R4's document-bundle rules: `Bundle.type = "document"`, an identifier is present, `Bundle.total` is omitted, and the Composition is the first entry. Conditions recorded without an ICD code are silently skipped, along with their dangling `Encounter.diagnosis` references, to keep the bundle self-contained.

---

## 13. Health Connect Sync (Android)

**Screen:** `settings/health-connect.tsx` — Android only.

Reads wearable data from the on-device Health Connect store via `react-native-health-connect`. Permissions (`HeartRate`, `Steps`) are OS-level — there's no OAuth involved.

**Sync:** `POST /api/healthconnect/sync` accepts a batch of up to 2,000 FHIR R4 Observations. Each is validated independently (resource type, status, patient ID match, UUID present, parseable timestamp, allowed LOINC code, non-negative value, `source: "health_connect"`). **One bad record never aborts the whole batch** — it's just counted as skipped; a 422 is only returned if *every* observation in the batch fails.

**Allowed LOINC codes today:** `8867-4` (heart rate), `41950-7` (steps). SpO2, weight, and blood glucose mappers are reserved for later.

**Idempotency:** upserts are keyed on the client-generated observation UUID, so re-sending the same reading is a no-op.

**Status:** `GET /api/healthconnect/status` returns `has_data`, `last_sync`, and per-type counts.

**Selective erasure:** `DELETE /api/healthconnect/data` deletes only Health-Connect-sourced vitals (`source: "health_connect"`) — manually entered vitals and clinical records are untouched. This is a DSGVO Art. 17 right-to-erasure mechanism scoped specifically to wearable data.

---

## 14. Account & Privacy Controls

All under **Profile → ACCOUNT**.

### Account deletion (`DELETE /api/auth/delete-account`)

Requires password confirmation in a modal. Wipes: `ehr_vitals`, `ehr_visits`, `ehr_conditions`, `ehr_documents`, `ehr_messages`, `ehr_exercises`, `patient_profiles`, `patient_fhir_identifiers` (including the GKV number and address — an explicit DSGVO Art. 17 fix), `patient_identifiers`, and `sync_issues`. The patient is also removed from every doctor's `authorized_doctors` array.

**One thing is deliberately *not* deleted:** the gPAS pseudonym record itself. It's the authoritative Treuhandstelle mapping and must be retained for legal/regulatory follow-up even after the account is gone — only the locally-cached copy is removed. `consent_history` and `research_vitals` rows are likewise left untouched for the same reason (see [Part 3](03-research-admin-consent.md) for why this is by design, not an oversight).

### Pseudonym transparency

- Only the last 4 characters of the research pseudonym ever reach the client, shown as `****XXXX`.
- It's used purely for display — it is never sent back to the server in any request.
- It persists across app restarts via `AsyncStorage`, independent of the in-memory session store.

---

## 15. Offline Behaviour

The app uses SQLite (`expo-sqlite`) on Android/iOS, with an in-memory fallback on Expo Web.

| Table | Contents | Cleared when |
|---|---|---|
| `vitals` | Cached recent readings (last 50) | Never (LRU via `INSERT OR REPLACE`) |
| `visits` | Cached visit records | Never |
| `pending_vitals` | Vitals queued while offline | After successful sync |
| `pending_medication_intakes` | Intake confirmations queued while offline | After successful sync |
| `today_medications_cache` | Today's medication schedule | On next successful fetch |

**Vitals:** a failed `POST` is queued (`queueVital()`) and shown with a yellow "Saved locally" banner; the queue is flushed the next time the vitals screen mounts.

**Medication intake:** a failed confirmation is queued (`queueMedicationIntake()`), the UI reverts, and a toast reads "Saved offline. Will sync when connection is restored." — flushed on the next medications screen mount.

**Today's schedule:** if the fetch fails, `getCachedTodayMedications()` reads the local cache and a yellow "⚠️ Showing cached data" banner appears.

**Retry policy:** the shared Axios client retries `ECONNABORTED`, `ERR_NETWORK`, no-response, and 502/503/504 responses with exponential back-off (2 s → 4 s → 8 s → 15 s cap, 4 attempts). Individual requests can opt out via `__noRetryOn5xx: true` — used by the consent-accept call, since a 502 there means "TTP unreachable" (permanent for a cloud deployment), not a transient blip worth retrying.

---

## 16. Patient API Reference

All routes require `Authorization: Bearer <token>` unless noted.

| Method | Path | Purpose |
|---|---|---|
| POST | `/login` | Authenticate, returns JWT |
| POST | `/register` | Create a patient account |
| POST | `/api/auth/forgot-password` | Request a reset code |
| POST | `/api/auth/reset-password` | Reset password with code |
| DELETE | `/api/auth/delete-account` | DSGVO Art. 17 full erasure |
| GET | `/api/health` | Health check *(no auth)* |
| GET | `/api/patient/profile` | Home-screen profile summary |
| GET | `/api/patient/medical-profile` | Full medical profile |
| GET/POST | `/api/patient/vitals` | Vitals history / record a reading |
| GET | `/api/patient/visits` | Visit history |
| GET/PUT | `/api/patient/fhir-identifiers`, `/api/patient/fhir-profile` | German FHIR identifiers / own FHIR Patient resource |
| GET | `/api/patient/fhir-export`, `/api/patient/fhir-export/pseudonymised` | Full / pseudonymised FHIR Bundle |
| GET/POST/DELETE | `/api/messages/*` | Conversations, threads, send, unread count |
| GET/POST/DELETE | `/api/patient/documents*` | List, upload, delete documents |
| GET/POST | `/api/patient/exercises*` | List exercises / mark done |
| GET | `/api/doctors`, `/api/patient/authorized-doctors` | Browse doctors / list authorized ones |
| POST | `/api/patient/authorize-doctor`, `/api/patient/revoke-doctor` | Grant / revoke doctor access |
| GET/POST | `/api/patient/doctor-sharing` | Master doctor data-sharing toggle |
| GET/POST | `/api/medications/my`, `/api/medications/today`, `/api/medications/intake/*`, `/api/medications/adherence` | Own medications, today's schedule, intake confirmation, adherence stats |
| GET | `/api/medications/fhir/MedicationRequest/` | FHIR searchset Bundle of own prescriptions |
| GET/POST/DELETE | `/api/consent/*`, `/api/patient/consent` | Strict + legacy consent grant/revoke/status/diagnose |
| POST/GET/DELETE | `/api/healthconnect/*` | Sync, status, selective erasure |
| POST | `/api/monitoring/alert`, GET `/api/monitoring/alerts/` | Record / list sensor alerts (own data only as a patient) |

For the doctor-facing counterparts of these routes (`/api/doctor/patient/<id>/...`), see [Part 2 §7](02-doctor-journey.md#7-doctor-api-reference).
