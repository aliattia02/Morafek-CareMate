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

export type Medication = MedicationRecord;

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

export interface MedicationAdherenceDay {
  date: string;
  total: number;
  taken: number;
  skipped: number;
  pending: number;
  rate: number;
}

export interface MedicationAdherenceResponse {
  days: MedicationAdherenceDay[];
  overall_rate: number;
}

export interface MedicationHistoryItem {
  id?: string;
  intake_id?: string;
  medication_id?: string;
  medication_name?: string;
  date: string;
  slot: 'morning' | 'noon' | 'evening' | 'night';
  status: 'pending' | 'taken' | 'skipped';
  note?: string;
  confirmed_at?: string | null;
}

export interface MedicationHistoryResponse {
  items: MedicationHistoryItem[];
  page?: number;
  per_page?: number;
  total?: number;
  total_pages?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Doctor: create medication
// FIX: backend route is POST /api/medications/patient/ (no patientId in URL).
//      patient_id must be sent in the request body.
// ─────────────────────────────────────────────────────────────────────────────

export async function createDoctorMedication(
  patientId: string,
  payload: CreateDoctorMedicationRequest
): Promise<MedicationRecord> {
  const response = await apiClient.post<MedicationRecord>(
    API.MEDICATIONS.DOCTOR_CREATE,          // POST /api/medications/patient/
    { ...payload, patient_id: patientId }   // patient_id goes in the body
  );
  return response.data;
}

export async function prescribeMedication(
  patientId: string,
  payload: CreateDoctorMedicationRequest
): Promise<MedicationRecord> {
  return createDoctorMedication(patientId, payload);
}

// ─────────────────────────────────────────────────────────────────────────────
// Doctor: list / update / delete
// FIX: all three use DOCTOR_PATIENT(patientId) which now resolves to
//      /api/medications/doctor/patient/:id  (note the /doctor/ prefix)
// ─────────────────────────────────────────────────────────────────────────────

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

export async function getPatientMedications(
  patientId: string,
  activeOnly?: boolean
): Promise<MedicationRecord[]> {
  return getDoctorPatientMedications(
    patientId,
    activeOnly === undefined ? undefined : { active_only: activeOnly }
  );
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

export async function updateMedication(
  patientId: string,
  medId: string,
  payload: UpdateDoctorMedicationRequest
): Promise<MedicationRecord> {
  return updateDoctorMedication(patientId, medId, payload);
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

export async function deactivateMedication(
  patientId: string,
  medId: string
): Promise<{ message?: string }> {
  return deleteDoctorMedication(patientId, medId);
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

export async function getMedicationsByVisit(
  patientId: string,
  visitId: string
): Promise<MedicationRecord[]> {
  return getDoctorPatientVisitMedications(patientId, visitId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Patient-facing
// ─────────────────────────────────────────────────────────────────────────────

export async function getMyMedications(): Promise<MedicationRecord[]> {
  const response = await apiClient.get<MedicationRecord[]>(API.MEDICATIONS.MY);
  return response.data;
}

export async function getTodayMedications(): Promise<TodayMedicationResponse> {
  const response = await apiClient.get<TodayMedicationResponse>(API.MEDICATIONS.TODAY);
  return response.data;
}

export async function getTodaySchedule(): Promise<TodayMedicationResponse> {
  return getTodayMedications();
}

// ─────────────────────────────────────────────────────────────────────────────
// Intake confirmation
// FIX: backend route is POST /api/medications/intake/ (no intakeId in URL).
//      intake_id must be sent in the request body.
// ─────────────────────────────────────────────────────────────────────────────

export async function confirmMedicationIntake(
  intakeId: string,
  payload: { status?: 'pending' | 'taken' | 'skipped'; note?: string }
): Promise<MedicationIntake> {
  const response = await apiClient.post<MedicationIntake>(
    API.MEDICATIONS.INTAKE,                  // POST /api/medications/intake/
    { ...payload, intake_id: intakeId }      // intake_id goes in the body
  );
  return response.data;
}

export async function confirmIntake(
  intakeId: string,
  status: 'pending' | 'taken' | 'skipped',
  note?: string
): Promise<MedicationIntake> {
  return confirmMedicationIntake(intakeId, { status, note });
}

// ─────────────────────────────────────────────────────────────────────────────
// Adherence & history
// ─────────────────────────────────────────────────────────────────────────────

export async function getMedicationAdherence(
  params?: { period_days?: number }
): Promise<MedicationAdherenceResponse> {
  const response = await apiClient.get<MedicationAdherenceResponse>(API.MEDICATIONS.ADHERENCE, { params });
  return response.data;
}

export async function getAdherence(): Promise<MedicationAdherenceResponse> {
  return getMedicationAdherence();
}

export async function getMedicationHistory(
  pageOrParams?: number | { page?: number; per_page?: number },
  perPage?: number,
  medicationId?: string
): Promise<MedicationHistoryResponse> {
  const params =
    typeof pageOrParams === 'object'
      ? pageOrParams
      : {
          page: pageOrParams,
          per_page: perPage,
          medication_id: medicationId,
        };

  const response = await apiClient.get<MedicationHistoryResponse>(API.MEDICATIONS.HISTORY, { params });
  return response.data;
}

export default {
  prescribeMedication,
  getPatientMedications,
  updateMedication,
  deactivateMedication,
  getMedicationsByVisit,
  getTodaySchedule,
  confirmIntake,
  getAdherence,
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