/**
 * mobile/services/api/admin.ts
 * Admin-only: standing sync-problem visibility + erasure-request approval.
 *
 * Backend: backend/routes/admin_routes.py — admin-only for every route here
 * (not doctor-or-admin — erasure approval is destructive/irreversible, see
 * that file's module docstring for the full reasoning).
 *
 *   GET  /api/admin/sync-issues                 — read-only, no mutation route
 *   GET  /api/admin/erasure-requests             — approval queue
 *   POST /api/admin/erasure-requests/<id>        — approve or deny one
 */

import apiClient from './client';
import API from './endpoints';

// ─── Sync issues ──────────────────────────────────────────────────────────

export type SyncIssueType = 'missing_pseudonym' | 'gics_query_failure';

export interface SyncIssue {
  patient_id: string;
  issue_type: string;
  detected_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  occurrence_count: number;
  context: Record<string, unknown>;
}

export interface SyncIssuesResponse {
  issues: SyncIssue[];
  open_count: number;
}

export interface GetSyncIssuesParams {
  issue_type?: SyncIssueType;
  include_resolved?: boolean;
}

/**
 * List standing sync problems flagged by the research sync job.
 * Read-only — issues only clear themselves when a later sync stops seeing
 * the condition; there is no manual dismiss/acknowledge endpoint.
 */
export async function getSyncIssues(
  params: GetSyncIssuesParams = {}
): Promise<SyncIssuesResponse> {
  const query: Record<string, string> = {};
  if (params.issue_type) query.issue_type = params.issue_type;
  if (params.include_resolved) query.include_resolved = 'true';

  const response = await apiClient.get<SyncIssuesResponse>(API.ADMIN.SYNC_ISSUES, {
    params: query,
  });
  return response.data;
}

// ─── Erasure requests ─────────────────────────────────────────────────────

export type ErasureRequestStatus = 'pending' | 'approved' | 'denied';
export type ErasureStatusFilter = ErasureRequestStatus | 'all';

export interface ErasureRequest {
  request_id: string;
  patient_id: string;
  research_pseudonym: string;
  requested_at: string;
  status: ErasureRequestStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reason: string | null;
  /** Live-computed research_vitals row count for this pseudonym — the blast radius. */
  affected_row_count: number;
}

export interface ErasureRequestsResponse {
  requests: ErasureRequest[];
}

/**
 * List erasure requests. Defaults to "pending" (the approval queue).
 * Will legitimately return an empty list until the patient-facing creation
 * endpoint exists — this is documented, not a bug.
 */
export async function getErasureRequests(
  status: ErasureStatusFilter = 'pending'
): Promise<ErasureRequestsResponse> {
  const response = await apiClient.get<ErasureRequestsResponse>(
    API.ADMIN.ERASURE_REQUESTS,
    { params: { status } }
  );
  return response.data;
}

export interface ErasureApproveResult {
  request_id: string;
  status: 'approved';
  deleted_count: number;
  reviewed_at: string;
}

export interface ErasureDenyResult {
  request_id: string;
  status: 'denied';
  reason: string | null;
  reviewed_at: string;
}

export type ErasureActionResult = ErasureApproveResult | ErasureDenyResult;

/**
 * Approve or deny a pending erasure request.
 *
 * approve: permanently, synchronously deletes every research_vitals row for
 *          this request's pseudonym. No undo.
 * deny:    touches no data.
 *
 * Throws with response.status === 409 if the request was already actioned
 * (double-click, or another admin got there first) — callers should refetch
 * the list rather than show a generic error.
 */
export async function actionErasureRequest(
  requestId: string,
  action: 'approve' | 'deny',
  reason?: string
): Promise<ErasureActionResult> {
  const response = await apiClient.post<ErasureActionResult>(
    API.ADMIN.ERASURE_REQUEST_ACTION(requestId),
    reason !== undefined ? { action, reason } : { action }
  );
  return response.data;
}

export default {
  getSyncIssues,
  getErasureRequests,
  actionErasureRequest,
};
