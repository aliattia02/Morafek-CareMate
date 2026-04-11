/**
 * services/api/clinics.ts
 * -----------------------
 * API helpers for clinic discovery and doctor membership.
 * Used by patients (browsing) and doctors (join/leave).
 */

import { apiClient } from './client';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Clinic {
  id:           string;
  name:         string;
  address:      string;
  phone:        string;
  description:  string;
  created_by:   string;
  created_at:   string;
  doctor_count: number;
}

export interface ClinicDetail extends Clinic {
  doctors: ClinicDoctor[];
}

export interface ClinicDoctor {
  id:        string;
  firstName: string;
  lastName:  string;
  email:     string;
}

export interface CreateClinicPayload {
  name:         string;
  address?:     string;
  phone?:       string;
  description?: string;
}

export interface UpdateClinicPayload {
  name?:        string;
  address?:     string;
  phone?:       string;
  description?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Patient-facing: browse clinics and their doctors
// ─────────────────────────────────────────────────────────────────────────────

/** Fetch all clinics (sorted by name). */
export async function getClinics(): Promise<Clinic[]> {
  const response = await apiClient.get<Clinic[]>('/api/clinics');
  return response.data;
}

/** Fetch a single clinic with its doctor list. */
export async function getClinicById(clinicId: string): Promise<ClinicDetail> {
  const response = await apiClient.get<ClinicDetail>(`/api/clinics/${clinicId}`);
  return response.data;
}

/** Fetch the doctors who belong to a specific clinic. */
export async function getClinicDoctors(clinicId: string): Promise<ClinicDoctor[]> {
  const response = await apiClient.get<ClinicDoctor[]>(`/api/clinics/${clinicId}/doctors`);
  return response.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Doctor-facing: manage own clinic memberships
// ─────────────────────────────────────────────────────────────────────────────

/** Get all clinics the current doctor belongs to. */
export async function getMyClinics(): Promise<Clinic[]> {
  const response = await apiClient.get<Clinic[]>('/api/doctor/clinics');
  return response.data;
}

/** Create a new clinic (doctor or admin). The creator is auto-added as a member. */
export async function createClinic(payload: CreateClinicPayload): Promise<Clinic> {
  const response = await apiClient.post<Clinic>('/api/clinics', payload);
  return response.data;
}

/** Update clinic details (creator or admin). */
export async function updateClinic(
  clinicId: string,
  payload: UpdateClinicPayload,
): Promise<Clinic> {
  const response = await apiClient.put<Clinic>(`/api/clinics/${clinicId}`, payload);
  return response.data;
}

/** Join a clinic as a doctor. */
export async function joinClinic(clinicId: string): Promise<void> {
  await apiClient.post(`/api/clinics/${clinicId}/join`);
}

/** Leave a clinic as a doctor. */
export async function leaveClinic(clinicId: string): Promise<void> {
  await apiClient.post(`/api/clinics/${clinicId}/leave`);
}
