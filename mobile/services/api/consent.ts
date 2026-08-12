/**
 * mobile/services/api/consent.ts
 * Consent management API helpers + local pseudonym persistence.
 *
 * TWO EXPORT PATHS (clearly separated):
 *
 *  A) PSEUDONYMISED export  → /api/patient/fhir-export/pseudonymised
 *     Requires active gICS consent + a stored pseudonym.
 *     Disabled when consent is revoked.
 *
 *  B) STANDARD FHIR export  → /api/patient/fhir-export
 *     Always available for authenticated patients.
 *     Used for direct EHR / KIS integration.
 *
 * LOCAL PERSISTENCE (AsyncStorage):
 *   The pseudonymSuffix (last 4 chars of the gPAS pseudonym) is persisted
 *   locally so it survives app restarts.
 *
 *   Key: '@caremate/pseudonym_suffix'
 *   Value: 4-character string, e.g. "A3F9"
 *
 *   On re-accept: the backend tries to reuse the existing gPAS pseudonym
 *   (idempotent grant in gICS). The mobile app restores the stored suffix
 *   if the backend returns the same one, or saves the new one if it differs.
 *
 * ENDPOINTS:
 *
 * ① LEGACY  /api/patient/consent  (GET / POST / DELETE)
 *    Backward-compatible MongoDB read. Used as fallback when gICS is
 *    unreachable (local Docker) or returns UNKNOWN.
 *
 * ② NEW gICS/gPAS  /api/consent/*
 *    acceptConsent()    POST /api/consent/accept  → { pseudonymSuffix }
 *    revokeConsent()    POST /api/consent/revoke  → { success }
 *    getConsentStatus() GET  /api/consent/status  → { status }
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient, { IS_LOCAL_BACKEND } from './client';

// ─── Storage key ──────────────────────────────────────────────────────────────

const PSEUDONYM_SUFFIX_KEY = '@caremate/pseudonym_suffix';
const PSEUDONYM_GRANTED_AT_KEY = '@caremate/pseudonym_granted_at';

// ─── Legacy types (inline export card) ───────────────────────────────────────

export interface ConsentStatus {
  status: 'granted' | 'revoked' | 'none';
  pseudonym_masked: string | null;
  granted_at: string | null;
  revoked_at: string | null;
}

export interface GrantResult {
  status: 'granted';
  pseudonym_assigned: boolean;
}

export interface RevokeResult {
  status: 'revoked';
}

// ─── New types (gICS / gPAS flow) ────────────────────────────────────────────

export interface ConsentStatusNew {
  status: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN';
}

export interface AcceptResult {
  /**
   * Last 4 characters of the gPAS pseudonym — safe to display and persist.
   * The full pseudonym never leaves the server.
   */
  pseudonymSuffix: string;
}

export interface RevokeSuccess {
  success: true;
}

// ─── Local pseudonym persistence ──────────────────────────────────────────────

/**
 * Persist the pseudonym suffix locally (survives app restarts).
 * Called immediately after a successful acceptConsent().
 */
export async function savePseudonymLocally(suffix: string): Promise<void> {
  try {
    await AsyncStorage.multiSet([
      [PSEUDONYM_SUFFIX_KEY, suffix],
      [PSEUDONYM_GRANTED_AT_KEY, new Date().toISOString()],
    ]);
  } catch (err) {
    // Non-fatal — the store in memory is the primary source
    console.warn('[Consent] Failed to persist pseudonym suffix locally:', err);
  }
}

/**
 * Retrieve the locally persisted pseudonym suffix.
 * Returns null if never saved or after a revoke.
 */
export async function getLocalPseudonymSuffix(): Promise<string | null> {
  try {
    const value = await AsyncStorage.getItem(PSEUDONYM_SUFFIX_KEY);
    return value ?? null;
  } catch {
    return null;
  }
}

/**
 * Retrieve the timestamp when the pseudonym was last granted locally.
 */
export async function getLocalPseudonymGrantedAt(): Promise<string | null> {
  try {
    const value = await AsyncStorage.getItem(PSEUDONYM_GRANTED_AT_KEY);
    return value ?? null;
  } catch {
    return null;
  }
}

/**
 * Clear the locally persisted pseudonym (called on revokeConsent).
 */
export async function clearLocalPseudonym(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([
      PSEUDONYM_SUFFIX_KEY,
      PSEUDONYM_GRANTED_AT_KEY,
    ]);
  } catch (err) {
    console.warn('[Consent] Failed to clear local pseudonym:', err);
  }
}

// ─── Legacy functions ─────────────────────────────────────────────────────────

export async function getLegacyConsentStatus(): Promise<ConsentStatus> {
  const response = await apiClient.get<ConsentStatus>('/api/patient/consent');
  return response.data;
}

export async function grantConsent(): Promise<GrantResult> {
  const response = await apiClient.post<GrantResult>('/api/patient/consent');
  return response.data;
}

export async function revokeLegacyConsent(): Promise<RevokeResult> {
  const response = await apiClient.delete<RevokeResult>('/api/patient/consent');
  return response.data;
}

// ─── New gICS / gPAS functions ────────────────────────────────────────────────

/**
 * Accept consent via gICS then gPAS.
 * Returns the last 4 digits of the pseudonym (safe to display + persist).
 *
 * The backend is idempotent: if a pseudonym already exists for this patient
 * in gPAS, the same suffix is returned.  The mobile app saves it locally
 * so it can be restored immediately on next launch without a server round-trip.
 */
export async function acceptConsent(): Promise<AcceptResult> {
  try {
    const response = await apiClient.post<AcceptResult>(
      '/api/consent/accept',
      {},
      // On the cloud/Render backend gICS and gPAS are unreachable (Docker-only).
      // A 502 there is permanent — skip the 4-retry back-off so the user
      // sees the hospital-visit message in ~1 s instead of ~30 s.
      IS_LOCAL_BACKEND ? {} : ({ __noRetryOn5xx: true } as object),
    );
    const result = response.data;
    // Persist locally immediately after a successful grant
    await savePseudonymLocally(result.pseudonymSuffix);
    return result;
  } catch (err: unknown) {
    // When on the cloud backend, translate any 5xx into a typed sentinel
    // so the UI can show a calm "visit hospital" message instead of a
    // raw error banner.  Local stacks surface the real error unchanged.
    if (!IS_LOCAL_BACKEND) {
      const axErr  = err as Record<string, unknown>;
      const resp   = axErr?.response as Record<string, unknown> | undefined;
      const status = typeof resp?.status === 'number' ? resp.status : 0;
      const code   = typeof axErr?.code  === 'string' ? axErr.code  : '';
      if (status >= 500 || code === 'ERR_BAD_RESPONSE') {
        throw new Error('TTP_UNAVAILABLE');
      }
    }
    throw err;
  }
}

/**
 * Revoke consent: revokes gICS, deletes from gPAS, removes MongoDB entry.
 * Also clears the local pseudonym so the export button auto-disables.
 */
export async function revokeConsent(): Promise<RevokeSuccess> {
  const response = await apiClient.post<RevokeSuccess>('/api/consent/revoke');
  // Clear local storage regardless of server response
  await clearLocalPseudonym();
  return response.data;
}

/**
 * Check current consent status from gICS.
 */
export async function getConsentStatus(): Promise<ConsentStatusNew> {
  const response = await apiClient.get<ConsentStatusNew>('/api/consent/status');
  return response.data;
}

// ─── Consent document (read-only, display only) ──────────────────────────────

export interface ConsentTemplateModule {
  label: string;
  title: string;       // HTML
  short_text: string;  // plain text
  text: string;         // HTML
  mandatory: boolean;
}

export interface ConsentTemplate {
  label: string;
  title: string;   // HTML
  header: string;  // HTML
  footer: string;  // HTML
  modules: ConsentTemplateModule[];
}

export interface ConsentTemplateResponse {
  domain: string;
  template: ConsentTemplate;
}

/**
 * Fetch the live, gICS-authored consent document for display (title,
 * header, each module's text, footer) — sourced from whatever is
 * currently configured in gICS's admin UI. Purely additive: does not
 * replace or affect acceptConsent()/revokeConsent() above, which keep
 * calling /api/consent/accept and /api/consent/revoke directly.
 */
export async function getConsentTemplate(): Promise<ConsentTemplateResponse> {
  const response = await apiClient.get<ConsentTemplateResponse>('/api/consent/template');
  return response.data;
}

// ─── Export helpers ───────────────────────────────────────────────────────────

/**
 * Fetch a pseudonymised FHIR R4 bundle.
 * Requires: active gICS consent + valid gPAS pseudonym.
 * Throws a 403 ApiError when consent is absent.
 */
export async function fetchPseudonymisedBundle<T = unknown>(): Promise<T> {
  const response = await apiClient.get<T>('/api/patient/fhir-export/pseudonymised');
  return response.data;
}

/**
 * Fetch the standard (identified) FHIR R4 bundle.
 * Always available for authenticated patients — no consent required.
 * Intended for direct EHR / KIS integration.
 */
export async function fetchStandardFhirBundle<T = unknown>(): Promise<T> {
  const response = await apiClient.get<T>('/api/patient/fhir-export');
  return response.data;
}

export default {
  // Legacy
  getLegacyConsentStatus,
  grantConsent,
  revokeLegacyConsent,
  // New gICS / gPAS
  acceptConsent,
  revokeConsent,
  getConsentStatus,
  getConsentTemplate,
  // Local storage
  savePseudonymLocally,
  getLocalPseudonymSuffix,
  getLocalPseudonymGrantedAt,
  clearLocalPseudonym,
  // Export helpers
  fetchPseudonymisedBundle,
  fetchStandardFhirBundle,
};