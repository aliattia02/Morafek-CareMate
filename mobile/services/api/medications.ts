import apiClient from './client';
import { API } from './endpoints';

export type NormSize = 'N1' | 'N2' | 'N3';
export type CoverageType = 'GKV' | 'PKV' | 'Selbstzahler';
export type DosageUnit = 'Tablette' | 'Kapsel' | 'ml' | 'IE' | 'Hub' | 'Tropfen';

export interface MedicationRecord {
  _id?: string;
  id?: string;
  patient_id: string;
  doctor_id?: string;
  visit_id?: string | null;
  pzn: string;
  trade_name: string;
  active_substance: string;
  form: string;
  strength: string;
  norm_size: NormSize;
  aut_idem: boolean;
  coverage: CoverageType;
  is_chronic: boolean;
  start_date: string;
  end_date?: string | null;
  duration_days?: number | null;
  dosage_morning: number;
  dosage_noon: number;
  dosage_evening: number;
  dosage_night: number;
  dosage_label?: string;
  dosage_unit: DosageUnit;
  dosage_note?: string;
  is_active?: boolean;
  created_at?: string;
}

export interface CreateDoctorMedicationRequest {
  pzn: string;
  trade_name: string;
  active_substance: string;
  form: string;
  strength: string;
  norm_size: NormSize;
  aut_idem: boolean;
  coverage: CoverageType;
  is_chronic: boolean;
  start_date: string;
  end_date?: string;
  duration_days?: number;
  dosage_morning: number;
  dosage_noon: number;
  dosage_evening: number;
  dosage_night: number;
  dosage_unit: DosageUnit;
  dosage_note?: string;
  is_active?: boolean;
  visit_id?: string;
}

export type UpdateDoctorMedicationRequest = Partial<CreateDoctorMedicationRequest>;

export interface MedicationIntake {
  _id?: string;
  id?: string;
  medication_id?: string;
  patient_id?: string;
  date?: string;
  slot?: 'morning' | 'noon' | 'evening' | 'night';
  status: 'pending' | 'taken' | 'skipped';
  note?: string;
  confirmed_at?: string | null;
}

export interface TodayMedicationSlotItem {
  medication: {
    id: string;
    trade_name: string;
    active_substance?: string;
    dosage_label?: string;
  };
  intake_id: string;
  status: 'pending' | 'taken' | 'skipped';
  dosage: number;
  unit: string;
}

export interface TodayMedicationResponse {
  date: string;
  slots: {
    morning: TodayMedicationSlotItem[];
    noon: TodayMedicationSlotItem[];
    evening: TodayMedicationSlotItem[];
    night: TodayMedicationSlotItem[];
  };
  summary: {
    total: number;
    taken: number;
    pending: number;
    skipped: number;
  };
}

export async function createDoctorMedication(
  patientId: string,
  payload: CreateDoctorMedicationRequest
): Promise<MedicationRecord> {
  const response = await apiClient.post<MedicationRecord>(
    API.MEDICATIONS.DOCTOR_PATIENT(patientId),
    payload
  );
  return response.data;
}

export async function getDoctorPatientMedications(
  patientId: string,
  params?: { active_only?: boolean }
): Promise<MedicationRecord[]> {
  const response = await apiClient.get<MedicationRecord[]>(
    API.MEDICATIONS.DOCTOR_PATIENT(patientId),
    { params }
  );
  return response.data;
}

export async function updateDoctorMedication(
  patientId: string,
  medicationId: string,
  payload: UpdateDoctorMedicationRequest
): Promise<MedicationRecord> {
  const response = await apiClient.put<MedicationRecord>(
    API.MEDICATIONS.DOCTOR_PATIENT_MED(patientId, medicationId),
    payload
  );
  return response.data;
}

export async function deleteDoctorMedication(
  patientId: string,
  medicationId: string
): Promise<{ message?: string }> {
  const response = await apiClient.delete<{ message?: string }>(
    API.MEDICATIONS.DOCTOR_PATIENT_MED(patientId, medicationId)
  );
  return response.data;
}

export async function getDoctorPatientVisitMedications(
  patientId: string,
  visitId: string
): Promise<MedicationRecord[]> {
  const response = await apiClient.get<MedicationRecord[]>(
    API.MEDICATIONS.DOCTOR_PATIENT_VISIT(patientId, visitId)
  );
  return response.data;
}

export async function getMyMedications(): Promise<MedicationRecord[]> {
  const response = await apiClient.get<MedicationRecord[]>(API.MEDICATIONS.MY);
  return response.data;
}

export async function getTodayMedications(): Promise<TodayMedicationResponse> {
  const response = await apiClient.get<TodayMedicationResponse>(API.MEDICATIONS.TODAY);
  return response.data;
}

export async function confirmMedicationIntake(
  intakeId: string,
  payload: { status?: 'pending' | 'taken' | 'skipped'; note?: string }
): Promise<MedicationIntake> {
  const response = await apiClient.post<MedicationIntake>(API.MEDICATIONS.INTAKE(intakeId), payload);
  return response.data;
}

export async function getMedicationAdherence(params?: { period_days?: number }): Promise<Record<string, unknown>> {
  const response = await apiClient.get<Record<string, unknown>>(API.MEDICATIONS.ADHERENCE, { params });
  return response.data;
}

export async function getMedicationHistory(params?: { page?: number; per_page?: number }): Promise<Record<string, unknown>> {
  const response = await apiClient.get<Record<string, unknown>>(API.MEDICATIONS.HISTORY, { params });
  return response.data;
}

export default {
  createDoctorMedication,
  getDoctorPatientMedications,
  updateDoctorMedication,
  deleteDoctorMedication,
  getDoctorPatientVisitMedications,
  getMyMedications,
  getTodayMedications,
  confirmMedicationIntake,
  getMedicationAdherence,
  getMedicationHistory,
};
