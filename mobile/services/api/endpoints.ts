/**
 * API Endpoint Constants
 * Location: mobile/services/api/endpoints.ts
 *
 * Main Export: API (default), API (named)
 * Description: Single source of truth for all backend API endpoint paths.
 *              All paths must exactly match the Flask route decorators in the backend.
 *
 * Features:
 * - Versioning support (USE_VERSIONED_API flag)
 * - Helper function for optional /api/v1/ prefix
 * - All endpoint groups: AUTH, PATIENT, CALCULATIONS, ACTIVITIES,
 *   MEALS, BLOOD_SUGAR, INSULIN, MOB, MEDICATION, FOOD, DOCTORS, DOCTOR, EXPORT,
 *   LIBRE (LibreLinkUp CGM integration), HEALTH_CONNECT (Android wearable sync)
 *
 * ⚠️  CRITICAL: Auth routes are at ROOT level (/login, /register) — NO /api prefix.
 *     All other routes use the /api prefix (/api/meals, /api/blood-sugar, etc.)
 *
 * Route → Backend file mapping (for debugging 404s):
 *   INSULIN.ACTIVE      → medication_routes.py  /api/insulin/active-effect
 *   INSULIN.LOG         → medication_routes.py  /api/insulin/log  (POST)
 *   INSULIN.DATA        → medication_routes.py  /api/insulin-data
 *   INSULIN.ANALYTICS   → medication_routes.py  /api/insulin-analytics
 *   MEALS.*             → meal_routes.py
 *   MOB.*               → meal_routes.py
 *   CALCULATIONS.IOB    → same as INSULIN.ACTIVE (aliased)
 *   CALCULATIONS.ACTIVE_EFFECTS_FULL → cumulative_effects_routes.py /api/active-effects-full
 *   CALCULATIONS.CUMULATIVE_EFFECTS  → cumulative_effects_routes.py /api/cumulative-effects
 *   LIBRE.*             → libre_routes.py
 *   EHR.ICD10_SUGGEST   → ehr_routes.py  /api/ehr/icd10-suggest  (POST, doctors only)
 *   HEALTH_CONNECT.*    → health_connect_routes.py  /api/healthconnect/*
 *
 * MEDICATIONS route notes (blueprint registered under /api/medications):
 *   DOCTOR_CREATE       → POST   /api/medications/patient/           patient_id in body
 *   DOCTOR_PATIENT      → GET    /api/medications/doctor/patient/:id
 *   DOCTOR_PATIENT_MED  → PUT|DELETE /api/medications/doctor/patient/:id/:medId
 *   DOCTOR_PATIENT_VISIT→ GET    /api/medications/doctor/patient/:id/visit/:visitId
 *   MY                  → GET    /api/medications/my
 *   TODAY               → GET    /api/medications/today
 *   INTAKE              → POST   /api/medications/intake/            intake_id in body
 *   ADHERENCE           → GET    /api/medications/adherence
 *   HISTORY             → GET    /api/medications/history
 */

// API version configuration
export const API_VERSION = 'v1';
export const USE_VERSIONED_API = false; // Set to true when backend supports /api/v1/

/**
 * Helper to get versioned endpoint.
 * When USE_VERSIONED_API is true, transforms /api/xxx → /api/v1/xxx
 */
const v = (endpoint: string): string => {
  if (!USE_VERSIONED_API) return endpoint;
  if (endpoint.startsWith('/api/')) {
    return endpoint.replace('/api/', `/api/${API_VERSION}/`);
  }
  return endpoint;
};

const API = {
  AUTH: {
    LOGIN: '/login',
    REGISTER: '/register',
    LOGOUT: '/logout', // Note: Flask has no /logout route — JWT is stateless.
                       // Client clears token locally. This constant is kept for future use.
    FORGOT_PASSWORD: '/api/auth/forgot-password',
    RESET_PASSWORD:  '/api/auth/reset-password',
  },
  PATIENT: {
    PROFILE: v('/api/patient/profile'),
    AUTHORIZED_DOCTORS: v('/api/patient/authorized-doctors'),
    AUTHORIZE_DOCTOR: v('/api/patient/authorize-doctor'),
    REVOKE_DOCTOR: v('/api/patient/revoke-doctor'),
  },
  USER: {
    UPLOAD_AVATAR: v('/api/user/avatar'),
  },
  DOCTORS: {
    LIST: v('/api/doctors'),
  },
  DOCTOR: {
    PATIENTS: v('/api/doctor/patients'),
  },
  EHR: {
    VITALS:        v('/api/patient/vitals'),
    VISITS:        v('/api/patient/visits'),
    MESSAGES:      (otherId: string) => v(`/api/messages/${otherId}`),
    UNREAD_COUNT:  v('/api/messages/unread-count'),
    CONVERSATIONS: v('/api/messages/conversations'),
    PATIENT_VISITS:   (id: string) => v(`/api/doctor/patient/${id}/visits`),
    PATIENT_VITALS:   (id: string) => v(`/api/doctor/patient/${id}/vitals`),
    PATIENT_MESSAGES: (id: string) => v(`/api/doctor/patient/${id}/messages`),
    DOCUMENTS:        v('/api/patient/documents'),
    DOCUMENT:         (id: string) => v(`/api/patient/documents/${id}`),
    PATIENT_DOCUMENTS: (patientId: string) => v(`/api/doctor/patient/${patientId}/documents`),
    EXERCISES:        v('/api/patient/exercises'),
    PATIENT_EXERCISES: (patientId: string) => v(`/api/doctor/patient/${patientId}/exercises`),
    PATIENT_EXERCISE_BY_ID: (patientId: string, exerciseId: string) =>
      v(`/api/doctor/patient/${patientId}/exercises/${exerciseId}`),
    EXERCISE_DONE: (exerciseId: string) => v(`/api/patient/exercises/${exerciseId}/done`),

    // ── FHIR exports ──────────────────────────────────────────────────────
    // Full export  — all PII included, for personal health records
    FHIR_EXPORT:               v('/api/patient/fhir-export'),
    // Pseudonymised — name/telecom/address stripped, requires consent grant
    FHIR_EXPORT_PSEUDONYMISED: v('/api/patient/fhir-export/pseudonymised'),

    // ── ICD-10-GM AI Assist ───────────────────────────────────────────────
    // POST  { chief_complaint, diagnosis_hint }
    // →     { suggestions: [{ code, description, rationale }] }
    // Doctors only — protected by token_required + user_type check on backend.
    ICD10_SUGGEST: v('/api/ehr/icd10-suggest'),
  },
  MEDICATIONS: {
    // ── Doctor: create ───────────────────────────────────────────────────
    // POST /api/medications/patient/   ← patient_id MUST be in the request body
    // (no patientId path segment — the Flask route is /patient/ with no <patient_id>)
    DOCTOR_CREATE: v('/api/medications/patient/'),

    // ── Doctor: list / update / delete ──────────────────────────────────
    // All three use the /doctor/ prefix that matches the registered Flask routes:
    //   GET    /api/medications/doctor/patient/<patient_id>
    //   PUT    /api/medications/doctor/patient/<patient_id>/<medication_id>
    //   DELETE /api/medications/doctor/patient/<patient_id>/<medication_id>
    DOCTOR_PATIENT: (patientId: string) =>
      v(`/api/medications/doctor/patient/${patientId}`),

    DOCTOR_PATIENT_MED: (patientId: string, medicationId: string) =>
      v(`/api/medications/doctor/patient/${patientId}/${medicationId}`),

    // GET /api/medications/doctor/patient/<patient_id>/visit/<visit_id>
    // (new route added to medication_routes.py — see backend fix)
    DOCTOR_PATIENT_VISIT: (patientId: string, visitId: string) =>
      v(`/api/medications/doctor/patient/${patientId}/visit/${visitId}`),

    // ── Patient-facing ───────────────────────────────────────────────────
    MY:        v('/api/medications/my'),
    TODAY:     v('/api/medications/today'),

    // POST /api/medications/intake/   ← intake_id MUST be in the request body
    // (no intakeId path segment — the Flask route is /intake/ with no <intake_id>)
    INTAKE:    v('/api/medications/intake/'),

    ADHERENCE: v('/api/medications/adherence'),
    HISTORY:   v('/api/medications/history'),
  },

  // ── Health Connect (Android wearable FHIR sync) ───────────────────────────
  // No OAuth — permissions are granted at the Android OS level.
  // Backend: backend/routes/health_connect_routes.py
  HEALTH_CONNECT: {
    /** POST  { observations: HCFHIRObservation[] } → HCSyncResponse */
    SYNC:   '/api/healthconnect/sync',
    /** GET   → HCStatusResponse (last_sync, counts, has_data) */
    STATUS: '/api/healthconnect/status',
    /** DELETE → { message, deleted_count }  GDPR/DSGVO selective erasure */
    DATA:   '/api/healthconnect/data',
  },
} as const;

// Named export for direct usage
export { API };

// Default export for convenience
export default API;

// Debug helper — logs all endpoints (useful for troubleshooting 404s)
export const logEndpoints = () => {
  console.log('📋 API Endpoints Configuration:');
  console.log('AUTH.LOGIN:', API.AUTH.LOGIN);
  console.log('AUTH.REGISTER:', API.AUTH.REGISTER);
  console.log('PATIENT.PROFILE:', API.PATIENT.PROFILE);
  console.log('DOCTORS.LIST:', API.DOCTORS.LIST);
  console.log('DOCTOR.PATIENTS:', API.DOCTOR.PATIENTS);
  console.log('EHR.VITALS:', API.EHR.VITALS);
  console.log('EHR.VISITS:', API.EHR.VISITS);
  console.log('EHR.MESSAGES(id):', API.EHR.MESSAGES('example-id'));
  console.log('EHR.ICD10_SUGGEST:', API.EHR.ICD10_SUGGEST);
  console.log('MEDICATIONS.DOCTOR_CREATE:', API.MEDICATIONS.DOCTOR_CREATE);
  console.log('MEDICATIONS.DOCTOR_PATIENT(id):', API.MEDICATIONS.DOCTOR_PATIENT('example-id'));
  console.log('MEDICATIONS.INTAKE:', API.MEDICATIONS.INTAKE);
  console.log('HEALTH_CONNECT.SYNC:', API.HEALTH_CONNECT.SYNC);
  console.log('HEALTH_CONNECT.STATUS:', API.HEALTH_CONNECT.STATUS);
  console.log('HEALTH_CONNECT.DATA:', API.HEALTH_CONNECT.DATA);
};