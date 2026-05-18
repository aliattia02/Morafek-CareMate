/**
 * health-connect.ts — Health Connect API service
 * Location: mobile/services/api/health-connect.ts
 *
 * Wraps all /api/healthconnect/* backend endpoints.
 * Mirrors watch-sync.ts structure but strips all OAuth logic — Health Connect
 * is permission-based at the OS level, so there is no connect/disconnect flow.
 *
 * Add these to your endpoints.ts:
 *
 *   HEALTH_CONNECT: {
 *     SYNC:   '/api/healthconnect/sync',
 *     STATUS: '/api/healthconnect/status',
 *     DATA:   '/api/healthconnect/data',
 *   }
 */

import apiClient from './client';
import type {
  HCFHIRObservation,
  HCStatusResponse,
  HCSyncResponse,
} from '@/types/health-connect.types';

// ─── Endpoint constants ───────────────────────────────────────────────────────

const HC = {
  SYNC:   '/api/healthconnect/sync',
  STATUS: '/api/healthconnect/status',
  DATA:   '/api/healthconnect/data',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/healthconnect/sync
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send an array of FHIR R4 Observations (produced by health-connect-mapper.ts)
 * to the backend for upsert into ehr_vitals.
 *
 * The backend validates each Observation's structure, checks that the LOINC
 * code is in the allowed list, and verifies the patient_id against the JWT.
 *
 * @param observations - Array of HC-produced FHIR Observations (may be empty)
 * @returns Sync result with inserted/skipped counts
 */
export async function syncHealthConnectData(
  observations: HCFHIRObservation[],
): Promise<HCSyncResponse> {
  const { data } = await apiClient.post<HCSyncResponse>(HC.SYNC, {
    observations,
  });
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/healthconnect/status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch Health Connect sync status for the authenticated patient.
 *
 * Returns last_sync datetime, per-type record counts, and whether any HC
 * data exists. This is a fast read from the ehr_vitals collection.
 *
 * @returns Status object with has_data, last_sync, and counts by data type
 */
export async function getHealthConnectStatus(): Promise<HCStatusResponse> {
  const { data } = await apiClient.get<HCStatusResponse>(HC.STATUS);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/healthconnect/data
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GDPR/DSGVO erasure endpoint — delete all Health Connect sourced
 * observations for the authenticated patient from ehr_vitals.
 *
 * This is separate from the full account deletion at /api/auth/delete-account
 * (which already wipes all of ehr_vitals). This endpoint is for selective
 * withdrawal of Health Connect consent without deleting the entire account.
 *
 * @returns Count of deleted observations
 */
export async function deleteHealthConnectData(): Promise<{
  message: string;
  deleted_count: number;
}> {
  const { data } = await apiClient.delete<{
    message: string;
    deleted_count: number;
  }>(HC.DATA);
  return data;
}
