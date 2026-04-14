/**
 * EHR API Service
 * Location: mobile/services/api/ehr.ts
 *
 * Main Functions: submitVital, getMyVitals,
 *                 getMyVisits,
 *                 getMessages, sendMessage, getUnreadCount,
 *                 getPatientVitals, getPatientVisits, getPatientMessages
 */

import { Platform } from 'react-native';
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
  encounter_fhir_id?: string;
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

export type DocumentCategory = 'lab_report' | 'imaging' | 'prescription' | 'other';

export interface DocumentResponse {
  id: string;
  category: DocumentCategory;
  description: string;
  url: string;
  created_at: string;
}

export type ExerciseCategory = 'mobility' | 'strength' | 'balance' | 'breathing' | 'other';

export interface ExerciseResponse {
  id: string;
  title: string;
  description: string;
  category: ExerciseCategory;
  frequency: string;
  duration_minutes?: number;
  repetitions?: number;
  sets?: number;
  video_url?: string;
  image_url?: string;
  notes?: string;
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

// Aliases used by doctor-facing components
export const getDoctorPatientVitals = getPatientVitals;
export const getDoctorPatientVisits = getPatientVisits;
export const getMessageThread = getPatientMessages;

// ─────────────────────────────────────────────────────────────────────────────
// Documents
// ─────────────────────────────────────────────────────────────────────────────

export async function getMyDocuments(): Promise<DocumentResponse[]> {
  const response = await apiClient.get<DocumentResponse[]>(API.EHR.DOCUMENTS);
  return response.data;
}

export async function getDoctorPatientDocuments(patientId: string): Promise<DocumentResponse[]> {
  const response = await apiClient.get<DocumentResponse[]>(
    API.EHR.PATIENT_DOCUMENTS(patientId)
  );
  return response.data;
}

export async function getDoctorPatientExercises(patientId: string): Promise<ExerciseResponse[]> {
  const response = await apiClient.get<ExerciseResponse[]>(
    API.EHR.PATIENT_EXERCISES(patientId)
  );
  return response.data;
}

export async function uploadDocument(
  file: { uri: string; name: string; type: string },
  category: DocumentCategory,
  description: string
): Promise<DocumentResponse> {
  const formData = new FormData();

  if (Platform.OS === 'web') {
    // On web, the uri is a base64 data URI or an object URL.
    // FormData does not accept the native { uri, name, type } shape on web —
    // we must fetch the actual bytes and append a real Blob.
    const fetchResponse = await fetch(file.uri);
    const blob = await fetchResponse.blob();
    formData.append('file', blob, file.name);
  } else {
    // On iOS / Android, React Native's FormData accepts this object shape.
    formData.append('file', { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
  }

  formData.append('category', category);
  formData.append('description', description);

  const response = await apiClient.post<DocumentResponse>(API.EHR.DOCUMENTS, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
}

export async function deleteDocument(documentId: string): Promise<void> {
  await apiClient.delete(API.EHR.DOCUMENT(documentId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Exercises
// ─────────────────────────────────────────────────────────────────────────────

export async function markExerciseDone(
  exerciseId: string,
  done: boolean
): Promise<void> {
  await apiClient.post(API.EHR.EXERCISE_DONE(exerciseId), { done });
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
  getMyDocuments,
  getDoctorPatientDocuments,
  getDoctorPatientExercises,
  uploadDocument,
  deleteDocument,
  markExerciseDone,
};