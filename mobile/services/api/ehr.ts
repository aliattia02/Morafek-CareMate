/**
 * EHR API Service
 * Location: mobile/services/api/ehr.ts
 *
 * Main Functions: submitVital, getMyVitals,
 *                 getMyVisits,
 *                 getMessages, sendMessage, getUnreadCount,
 *                 getPatientVitals, getPatientVisits, getPatientMessages
 */

import apiClient from './client';
import { API } from './endpoints';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface VitalResponse {
  id: string;
  systolic: number;
  diastolic: number;
  pulse: number;
  urgent: boolean;
  timestamp: string;
}

export interface VisitResponse {
  id: string;
  visit_date: string;
  chief_complaint: string;
  diagnosis_icd10: string;
  diagnosis_text: string;
  notes: string;
  doctor_id: string;
}

export interface MessageResponse {
  id: string;
  sender_id: string;
  recipient_id: string;
  sender_type: 'patient' | 'doctor';
  body: string;
  read: boolean;
  created_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vitals
// ─────────────────────────────────────────────────────────────────────────────

export async function submitVital(data: {
  systolic: number;
  diastolic: number;
  pulse: number;
  weight_kg?: number;
  notes?: string;
}): Promise<VitalResponse> {
  const response = await apiClient.post<VitalResponse>(API.EHR.VITALS, data);
  return response.data;
}

export async function getMyVitals(limit = 50): Promise<VitalResponse[]> {
  const response = await apiClient.get<VitalResponse[]>(API.EHR.VITALS, {
    params: { limit },
  });
  return response.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Visits
// ─────────────────────────────────────────────────────────────────────────────

export async function getMyVisits(): Promise<VisitResponse[]> {
  const response = await apiClient.get<VisitResponse[]>(API.EHR.VISITS);
  return response.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────────────

export async function getMessages(otherId: string): Promise<MessageResponse[]> {
  const response = await apiClient.get<MessageResponse[]>(API.EHR.MESSAGES(otherId));
  return response.data;
}

export async function sendMessage(
  otherId: string,
  body: string
): Promise<MessageResponse> {
  const response = await apiClient.post<MessageResponse>(API.EHR.MESSAGES(otherId), {
    body,
  });
  return response.data;
}

export async function getUnreadCount(): Promise<{ count: number }> {
  const response = await apiClient.get<{ count: number }>(API.EHR.UNREAD_COUNT);
  return response.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Doctor-proxied patient data (doctor view)
// ─────────────────────────────────────────────────────────────────────────────

export async function getPatientVitals(
  patientId: string,
  params?: { limit?: number }
): Promise<VitalResponse[]> {
  const response = await apiClient.get<VitalResponse[]>(
    API.EHR.PATIENT_VITALS(patientId),
    { params }
  );
  return response.data;
}

export async function getPatientVisits(patientId: string): Promise<VisitResponse[]> {
  const response = await apiClient.get<VisitResponse[]>(
    API.EHR.PATIENT_VISITS(patientId)
  );
  return response.data;
}

export async function getPatientMessages(patientId: string): Promise<MessageResponse[]> {
  const response = await apiClient.get<MessageResponse[]>(
    API.EHR.PATIENT_MESSAGES(patientId)
  );
  return response.data;
}

export default {
  submitVital,
  getMyVitals,
  getMyVisits,
  getMessages,
  sendMessage,
  getUnreadCount,
  getPatientVitals,
  getPatientVisits,
  getPatientMessages,
};
