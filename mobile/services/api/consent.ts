/**
 * mobile/services/api/consent.ts
 * Consent management API helpers.
 *
 * Two sets of functions are exported:
 *
 * ① LEGACY endpoints — /api/patient/consent (GET/POST/DELETE)
 *    Used by the inline pseudonymised export card on the consent screen.
 *    These remain for backward compatibility.
 *
 * ② NEW gICS/gPAS endpoints — /api/consent/* (GET/POST)
 *    Used by the main consent flow (accept / revoke / status).
 *    acceptConsent()   POST /api/consent/accept  → { pseudonymSuffix }
 *    revokeConsent()   POST /api/consent/revoke  → { success }
 *    getConsentStatus() GET /api/consent/status  → { status }
 */

import apiClient from './client';

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
  /** Last 4 characters of the gPAS pseudonym — safe to display in the UI. */
  pseudonymSuffix: string;
}

export interface RevokeSuccess {
  success: true;
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
 * Accept consent: submits to gICS then gPAS.
 * Returns only the last 4 digits of the pseudonym (safe to display).
 */
export async function acceptConsent(): Promise<AcceptResult> {
  const response = await apiClient.post<AcceptResult>('/api/consent/accept');
  return response.data;
}

/**
 * Revoke consent: revokes gICS, deletes from gPAS, removes from MongoDB.
 */
export async function revokeConsent(): Promise<RevokeSuccess> {
  const response = await apiClient.post<RevokeSuccess>('/api/consent/revoke');
  return response.data;
}

/**
 * Check current consent status from gICS.
 */
export async function getConsentStatus(): Promise<ConsentStatusNew> {
  const response = await apiClient.get<ConsentStatusNew>('/api/consent/status');
  return response.data;
}

export default {
  // Legacy
  getLegacyConsentStatus,
  grantConsent,
  revokeLegacyConsent,
  // New
  acceptConsent,
  revokeConsent,
  getConsentStatus,
};