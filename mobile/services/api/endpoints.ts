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
 *   LIBRE (LibreLinkUp CGM integration)
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
    LOGOUT: '/logout',
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
};