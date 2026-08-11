/**
 * mobile/services/api/research.ts
 * Researcher-triggered consent-eligibility + vitals-mirror sync.
 *
 * Backend: backend/routes/research_routes.py
 *   POST /api/research/sync         — role: researcher — runs the sync now
 *   GET  /api/research/sync/status  — role: researcher — last-run stats only
 *
 * The sync is on-demand, not scheduled (see data-store-separation-reference.md
 * §7.3) — a researcher clicks "Sync now" before importing data, rather than a
 * background job running on an interval. POST /api/research/sync is therefore
 * a synchronous, potentially multi-second call that scales with patient count.
 */

import apiClient from './client';
import API from './endpoints';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ResearchSyncError {
  patient_id: string;
  gics_error: string;
}

export interface ResearchSyncResult {
  synced_at: string;
  synced_by: string;
  total_patients: number;
  processing_count: number;
  error_count: number;
  newly_eligible: number;
  newly_ineligible: number;
  unchanged: number;
  vitals_mirrored: number;
  vitals_considered: number;
  no_pseudonym_count: number;
  errors: ResearchSyncError[];
  duration_seconds: number;
}

export interface ResearchSyncStatus {
  last_synced_at: string | null;
  synced_by: string | null;
  total_patients: number | null;
  newly_eligible: number | null;
  newly_ineligible: number | null;
  error_count: number | null;
  vitals_mirrored: number | null;
  vitals_considered: number | null;
  no_pseudonym_count: number | null;
  stale_minutes: number | null;
}

// ─── API calls ──────────────────────────────────────────────────────────────

/**
 * Trigger the consent-eligibility refresh + vitals mirror sync now.
 * Throws on 502 (gICS completely unreachable — check err.response.data.error)
 * or 403 (not a researcher). A 200 with error_count > 0 is a partial success —
 * see errors[] for which patients failed, the rest still synced.
 */
export async function triggerResearchSync(): Promise<ResearchSyncResult> {
  const response = await apiClient.post<ResearchSyncResult>(API.RESEARCH.SYNC);
  return response.data;
}

/**
 * Fetch stats from the most recent sync without triggering a new one.
 * All fields are null if no sync has ever run.
 */
export async function getResearchSyncStatus(): Promise<ResearchSyncStatus> {
  const response = await apiClient.get<ResearchSyncStatus>(API.RESEARCH.SYNC_STATUS);
  return response.data;
}

export default {
  triggerResearchSync,
  getResearchSyncStatus,
};
