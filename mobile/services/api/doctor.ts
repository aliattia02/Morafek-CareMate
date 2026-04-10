/**
 * Doctor API Service
 * Location: mobile/services/api/doctor.ts
 *
 * Main Functions: getPatients
 */

import apiClient from './client';
import { API } from './endpoints';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DoctorPatient {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  activeConditions?: string[];
  activeMedications?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Patient list
// ─────────────────────────────────────────────────────────────────────────────

export const getPatients = async (): Promise<DoctorPatient[]> => {
  const response = await apiClient.get<DoctorPatient[]>(API.DOCTOR.PATIENTS);
  return response.data;
};

export default {
  getPatients,
};