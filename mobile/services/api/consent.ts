/**
 * mobile/services/api/consent.ts
 * Consent management API helpers.
 */

import apiClient from './client';

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

export async function getConsentStatus(): Promise<ConsentStatus> {
  const response = await apiClient.get<ConsentStatus>('/api/patient/consent');
  return response.data;
}

export async function grantConsent(): Promise<GrantResult> {
  const response = await apiClient.post<GrantResult>('/api/patient/consent');
  return response.data;
}

export async function revokeConsent(): Promise<RevokeResult> {
  const response = await apiClient.delete<RevokeResult>('/api/patient/consent');
  return response.data;
}

export default { getConsentStatus, grantConsent, revokeConsent };
