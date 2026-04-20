/**
 * Patient Data View Component
 * Location: mobile/components/doctor/PatientDataView.tsx
 *
 * Tabs: Overview | Visits | Medications | Vitals | Documents | Exercises | Messages
 *
 * Changes vs. previous version
 * ─────────────────────────────
 * • Added "Medications" tab — loads all prescriptions for this patient via
 *   GET /api/medications/doctor/patient/:id and displays them as cards with
 *   dosage schedule, coverage, chronic/end-date, and active/inactive badge.
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  TextInput,
  Linking,
  Alert,
  Platform,
  StyleSheet,
} from 'react-native';

import { useRouter } from 'expo-router';
import { Card } from '@/components/ui';
import {
  getDoctorPatientVitals,
  getDoctorPatientVisits,
  getMessageThread,
  getDoctorPatientDocuments,
  getDoctorPatientExercises,
  sendMessage,
  type VitalResponse,
  type VisitResponse,
  type MessageResponse,
  type DocumentResponse,
  type ExerciseResponse,
} from '@/services/api/ehr';
import {
  getDoctorPatientMedications,
  deactivateMedication,
  updateDoctorMedication,
  type MedicationRecord,
} from '@/services/api/medications';
import { apiClient } from '@/services/api/client';
import { API } from '@/services/api/endpoints';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import { E } from '@/constants/elderlyTheme';
import type { DoctorPatient } from '@/services/api/doctor';
import VisitDetailModal, { type VisitDetail } from '@/components/ehr/VisitDetailModal';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type TabType = 'overview' | 'visits' | 'medications' | 'vitals' | 'documents' | 'exercises' | 'messages';

interface MedicalProfile {
  patient_id:              string;
  date_of_birth:           string;
  gender:                  string;
  blood_type:              string;
  height_cm:               number | null;
  weight_kg:               number | null;
  allergies:               string[];
  chronic_conditions:      string[];
  current_medications:     string[];
  smoking_status:          string;
  emergency_contact_name:  string;
  emergency_contact_phone: string;
  notes:                   string;
  updated_at:              string;
  updated_by:              string;
}

const EMPTY_PROFILE: MedicalProfile = {
  patient_id: '', date_of_birth: '', gender: '', blood_type: 'unknown',
  height_cm: null, weight_kg: null, allergies: [], chronic_conditions: [],
  current_medications: [], smoking_status: 'unknown',
  emergency_contact_name: '', emergency_contact_phone: '',
  notes: '', updated_at: '', updated_by: '',
};

async function fetchMedicalProfile(patientId: string): Promise<MedicalProfile> {
  const res = await apiClient.get<MedicalProfile>(
    `/api/doctor/patient/${patientId}/profile`
  );
  return res.data;
}

async function saveMedicalProfile(
  patientId: string,
  data: Partial<MedicalProfile>,
): Promise<MedicalProfile> {
  const SERVER_FIELDS = new Set(['patient_id', 'updated_at', 'updated_by']);
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SERVER_FIELDS.has(key)) continue;
    if (value === null) continue;
    if (value === '') continue;
    payload[key] = value;
  }
  const res = await apiClient.put<MedicalProfile>(
    `/api/doctor/patient/${patientId}/profile`,
    payload,
  );
  return res.data;
}

interface PatientDataViewProps {
  patient: DoctorPatient;
  onBack?: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function PatientDataView({ patient, onBack }: PatientDataViewProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabType>('overview');

  const [vitals, setVitals] = useState<VitalResponse[]>([]);
  const [vitalsLoading, setVitalsLoading] = useState(false);
  const [vitalsLoaded, setVitalsLoaded] = useState(false);
  const [vitalsError, setVitalsError] = useState<string | null>(null);
  const [vitalsRefreshing, setVitalsRefreshing] = useState(false);

  const [visits, setVisits] = useState<VisitResponse[]>([]);
  const [visitsLoading, setVisitsLoading] = useState(false);
  const [visitsLoaded, setVisitsLoaded] = useState(false);
  const [visitsError, setVisitsError] = useState<string | null>(null);
  const [visitsRefreshing, setVisitsRefreshing] = useState(false);
  const [selectedVisit, setSelectedVisit] = useState<VisitDetail | null>(null);

  // ── Medications ──────────────────────────────────────────────────────────
  const [medications, setMedications] = useState<MedicationRecord[]>([]);
  const [medicationsLoading, setMedicationsLoading] = useState(false);
  const [medicationsLoaded, setMedicationsLoaded] = useState(false);
  const [medicationsError, setMedicationsError] = useState<string | null>(null);
  const [medicationsRefreshing, setMedicationsRefreshing] = useState(false);
  const [medFilter, setMedFilter] = useState<'all' | 'active' | 'inactive'>('active');
  const [medicationActionLoadingId, setMedicationActionLoadingId] = useState<string | null>(null);
  const [editingMedicationId, setEditingMedicationId] = useState<string | null>(null);
  const [editingDosage, setEditingDosage] = useState({
    morning: '',
    noon: '',
    evening: '',
    night: '',
  });

  const [messages, setMessages] = useState<MessageResponse[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [messagesRefreshing, setMessagesRefreshing] = useState(false);
  const [messageInput, setMessageInput] = useState('');
  const [messageSending, setMessageSending] = useState(false);

  const [documents, setDocuments] = useState<DocumentResponse[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentsLoaded, setDocumentsLoaded] = useState(false);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [documentsRefreshing, setDocumentsRefreshing] = useState(false);

  const [exercises, setExercises] = useState<ExerciseResponse[]>([]);
  const [exercisesLoading, setExercisesLoading] = useState(false);
  const [exercisesLoaded, setExercisesLoaded] = useState(false);
  const [exercisesError, setExercisesError] = useState<string | null>(null);
  const [exercisesRefreshing, setExercisesRefreshing] = useState(false);

  const [docCategory, setDocCategory] = useState<'all' | 'lab_report' | 'imaging' | 'prescription' | 'other'>('all');
  const [vitalCategory, setVitalCategory] = useState<'overview' | 'bp' | 'hr'>('overview');

  // Medical Profile state
  const [profile, setProfile]               = useState<MedicalProfile>(EMPTY_PROFILE);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileLoaded, setProfileLoaded]   = useState(false);
  const [profileSaving, setProfileSaving]   = useState(false);
  const [profileError, setProfileError]     = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [draft, setDraft]                   = useState<MedicalProfile>(EMPTY_PROFILE);

  // ── Load callbacks ───────────────────────────────────────────────────────

  const loadVitals = useCallback(async () => {
    try {
      setVitalsError(null);
      const data = await getDoctorPatientVitals(patient.id);
      setVitals(data);
    } catch (err: unknown) {
      setVitalsError(err instanceof Error ? err.message : 'Failed to load vitals');
    } finally {
      setVitalsLoading(false);
      setVitalsLoaded(true);
    }
  }, [patient.id]);

  const loadVisits = useCallback(async () => {
    try {
      setVisitsError(null);
      const data = await getDoctorPatientVisits(patient.id);
      setVisits(data);
    } catch (err: unknown) {
      setVisitsError(err instanceof Error ? err.message : 'Failed to load visits');
    } finally {
      setVisitsLoading(false);
      setVisitsLoaded(true);
    }
  }, [patient.id]);

  const loadMedications = useCallback(async () => {
    try {
      setMedicationsError(null);
      const data = await getDoctorPatientMedications(patient.id);
      setMedications(data);
    } catch (err: unknown) {
      setMedicationsError(err instanceof Error ? err.message : 'Failed to load medications');
    } finally {
      setMedicationsLoading(false);
      setMedicationsLoaded(true);
    }
  }, [patient.id]);

  const loadMessages = useCallback(async () => {
    try {
      setMessagesError(null);
      const data = await getMessageThread(patient.id);
      setMessages(data);
    } catch (err: unknown) {
      setMessagesError(err instanceof Error ? err.message : 'Failed to load messages');
    } finally {
      setMessagesLoading(false);
      setMessagesLoaded(true);
    }
  }, [patient.id]);

  const loadDocuments = useCallback(async () => {
    try {
      setDocumentsError(null);
      const data = await getDoctorPatientDocuments(patient.id);
      setDocuments(data);
    } catch (err: unknown) {
      setDocumentsError(err instanceof Error ? err.message : 'Failed to load documents');
    } finally {
      setDocumentsLoading(false);
      setDocumentsLoaded(true);
    }
  }, [patient.id]);

  const loadExercises = useCallback(async () => {
    try {
      setExercisesError(null);
      const data = await getDoctorPatientExercises(patient.id);
      setExercises(data);
    } catch (err: unknown) {
      setExercisesError(err instanceof Error ? err.message : 'Failed to load exercises');
    } finally {
      setExercisesLoading(false);
      setExercisesLoaded(true);
    }
  }, [patient.id]);

  // ── Lazy-load on tab switch ──────────────────────────────────────────────

  useEffect(() => {
    if (activeTab === 'vitals' && !vitalsLoaded && !vitalsLoading) {
      setVitalsLoading(true);
      loadVitals();
    }
  }, [activeTab, loadVitals]);

  useEffect(() => {
    if (activeTab === 'visits' && !visitsLoaded && !visitsLoading) {
      setVisitsLoading(true);
      loadVisits();
    }
  }, [activeTab, loadVisits]);

  useEffect(() => {
    if (activeTab === 'medications' && !medicationsLoaded && !medicationsLoading) {
      setMedicationsLoading(true);
      loadMedications();
    }
  }, [activeTab, loadMedications]);

  useEffect(() => {
    if (activeTab === 'messages' && !messagesLoaded && !messagesLoading) {
      setMessagesLoading(true);
      loadMessages();
    }
  }, [activeTab, loadMessages]);

  useEffect(() => {
    if (activeTab === 'documents' && !documentsLoaded && !documentsLoading) {
      setDocumentsLoading(true);
      loadDocuments();
    }
  }, [activeTab, loadDocuments]);

  useEffect(() => {
    if (activeTab === 'exercises' && !exercisesLoaded && !exercisesLoading) {
      setExercisesLoading(true);
      loadExercises();
    }
  }, [activeTab, loadExercises]);

  useEffect(() => {
    if (activeTab === 'overview' && !profileLoaded && !profileLoading) {
      setProfileLoading(true);
      fetchMedicalProfile(patient.id)
        .then((p) => { setProfile(p); setDraft(p); })
        .catch((e) => setProfileError(e instanceof Error ? e.message : 'Failed to load profile'))
        .finally(() => { setProfileLoading(false); setProfileLoaded(true); });
    }
  }, [activeTab, profileLoaded, profileLoading, patient.id]);

  // ── Handlers ────────────────────────────────────────────────────────────

  const handleSaveProfile = useCallback(async () => {
    setProfileSaving(true);
    setProfileError(null);
    setProfileSuccess(null);
    try {
      const saved = await saveMedicalProfile(patient.id, draft);
      setProfile(saved);
      setDraft(saved);
      setEditingProfile(false);
      setProfileSuccess('Medical profile saved successfully.');
      setTimeout(() => setProfileSuccess(null), 3000);
    } catch (e: unknown) {
      setProfileError(e instanceof Error ? e.message : 'Failed to save profile');
    } finally {
      setProfileSaving(false);
    }
  }, [draft, patient.id]);

  const onRefreshVitals = useCallback(async () => {
    setVitalsRefreshing(true);
    await loadVitals();
    setVitalsRefreshing(false);
  }, [loadVitals]);

  const onRefreshVisits = useCallback(async () => {
    setVisitsRefreshing(true);
    await loadVisits();
    setVisitsRefreshing(false);
  }, [loadVisits]);

  const onRefreshMedications = useCallback(async () => {
    setMedicationsRefreshing(true);
    await loadMedications();
    setMedicationsRefreshing(false);
  }, [loadMedications]);

  const onRefreshMessages = useCallback(async () => {
    setMessagesRefreshing(true);
    await loadMessages();
    setMessagesRefreshing(false);
  }, [loadMessages]);

  const onRefreshDocuments = useCallback(async () => {
    setDocumentsRefreshing(true);
    await loadDocuments();
    setDocumentsRefreshing(false);
  }, [loadDocuments]);

  const onRefreshExercises = useCallback(async () => {
    setExercisesRefreshing(true);
    await loadExercises();
    setExercisesRefreshing(false);
  }, [loadExercises]);

  const handleSendMessage = useCallback(async () => {
    const body = messageInput.trim();
    if (!body || messageSending) return;
    try {
      setMessageSending(true);
      const sent = await sendMessage(patient.id, body);
      setMessages((prev) => [...prev, sent]);
      setMessageInput('');
    } catch (err: unknown) {
      setMessagesError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setMessageSending(false);
    }
  }, [messageInput, messageSending, patient.id]);

  // ── Tabs ─────────────────────────────────────────────────────────────────

  const tabs: { key: TabType; label: string }[] = [
    { key: 'overview',    label: 'Overview' },
    { key: 'visits',      label: 'Visits' },
    { key: 'medications', label: 'Medications' },
    { key: 'vitals',      label: 'Vitals' },
    { key: 'documents',   label: 'Documents' },
    { key: 'exercises',   label: 'Exercises' },
    { key: 'messages',    label: 'Messages' },
  ];

  // ── Medication helpers ───────────────────────────────────────────────────

  const coverageColor = (c: string) => {
    if (c === 'GKV') return { bg: '#E3F2FD', text: '#1565C0', border: '#90CAF9' };
    if (c === 'PKV') return { bg: '#F3E5F5', text: '#6A1B9A', border: '#CE93D8' };
    return { bg: '#F5F5F5', text: '#424242', border: '#BDBDBD' };
  };

  const dosageScheduleLabel = (med: MedicationRecord) =>
    `${med.dosage_morning}-${med.dosage_noon}-${med.dosage_evening}-${med.dosage_night}`;

  const medicationIdOf = useCallback((med: MedicationRecord) => String(med._id ?? med.id ?? ''), []);

  const startDosageEdit = useCallback((med: MedicationRecord) => {
    const medicationId = medicationIdOf(med);
    if (!medicationId) return;
    setMedicationsError(null);
    setEditingMedicationId(medicationId);
    setEditingDosage({
      morning: String(med.dosage_morning ?? 0),
      noon: String(med.dosage_noon ?? 0),
      evening: String(med.dosage_evening ?? 0),
      night: String(med.dosage_night ?? 0),
    });
  }, [medicationIdOf]);

  const cancelDosageEdit = useCallback(() => {
    setEditingMedicationId(null);
    setEditingDosage({ morning: '', noon: '', evening: '', night: '' });
  }, []);

  const saveDosageEdit = useCallback(async (medicationId: string) => {
    const parseDose = (value: string) => {
      const trimmed = value.trim();
      if (!/^\d+$/.test(trimmed)) return null;
      return Number(trimmed);
    };

    const dosage_morning = parseDose(editingDosage.morning);
    const dosage_noon = parseDose(editingDosage.noon);
    const dosage_evening = parseDose(editingDosage.evening);
    const dosage_night = parseDose(editingDosage.night);

    if (
      dosage_morning === null ||
      dosage_noon === null ||
      dosage_evening === null ||
      dosage_night === null
    ) {
      setMedicationsError('Dosage values must be whole numbers (0 or higher).');
      return;
    }

    try {
      setMedicationActionLoadingId(medicationId);
      setMedicationsError(null);
      const updated = await updateDoctorMedication(patient.id, medicationId, {
        dosage_morning,
        dosage_noon,
        dosage_evening,
        dosage_night,
      });
      setMedications((prev) =>
        prev.map((item) => (medicationIdOf(item) === medicationId ? updated : item))
      );
      cancelDosageEdit();
    } catch (err: unknown) {
      setMedicationsError(err instanceof Error ? err.message : 'Failed to update dosage');
    } finally {
      setMedicationActionLoadingId(null);
    }
  }, [cancelDosageEdit, editingDosage.evening, editingDosage.morning, editingDosage.night, editingDosage.noon, medicationIdOf, patient.id]);

  const handleDeactivateMedication = useCallback((med: MedicationRecord) => {
    const medicationId = medicationIdOf(med);
    if (!medicationId) return;
    if (med.is_active === false) return;

    const runDeactivate = async () => {
      try {
        setMedicationActionLoadingId(medicationId);
        setMedicationsError(null);
        await deactivateMedication(patient.id, medicationId);
        setMedications((prev) =>
          prev.map((item) =>
            medicationIdOf(item) === medicationId ? { ...item, is_active: false } : item
          )
        );
        if (editingMedicationId === medicationId) {
          cancelDosageEdit();
        }
      } catch (err: unknown) {
        setMedicationsError(err instanceof Error ? err.message : 'Failed to deactivate medication');
      } finally {
        setMedicationActionLoadingId(null);
      }
    };

    if (Platform.OS === 'web') {
      if (window.confirm(`Deactivate medication\n\nDeactivate ${med.trade_name}?`)) {
        void runDeactivate();
      }
      return;
    }

    Alert.alert(
      'Deactivate medication',
      `Deactivate ${med.trade_name}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Deactivate',
          style: 'destructive',
          onPress: () => {
            void runDeactivate();
          },
        },
      ]
    );
  }, [cancelDosageEdit, editingMedicationId, medicationIdOf, patient.id]);

  const handleReactivateMedication = useCallback((med: MedicationRecord) => {
    const medicationId = medicationIdOf(med);
    if (!medicationId) return;
    if (med.is_active !== false) return;

    const runReactivate = async () => {
      try {
        setMedicationActionLoadingId(medicationId);
        setMedicationsError(null);
        const res = await apiClient.patch<{ medication: MedicationRecord }>(
          `/api/medications/doctor/patient/${patient.id}/${medicationId}/reactivate`
        );
        const updated = res.data.medication;
        setMedications((prev) =>
          prev.map((item) =>
            medicationIdOf(item) === medicationId ? { ...item, ...updated } : item
          )
        );
      } catch (err: unknown) {
        setMedicationsError(err instanceof Error ? err.message : 'Failed to reactivate medication');
      } finally {
        setMedicationActionLoadingId(null);
      }
    };

    if (Platform.OS === 'web') {
      if (window.confirm(`Reactivate medication\n\nReactivate ${med.trade_name}?`)) {
        void runReactivate();
      }
      return;
    }

    Alert.alert(
      'Reactivate medication',
      `Reactivate ${med.trade_name}? A new treatment period will start today.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reactivate', onPress: () => { void runReactivate(); } },
      ]
    );
  }, [medicationIdOf, patient.id]);

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        {onBack && (
          <TouchableOpacity onPress={onBack} style={styles.backButton}>
            <Text style={styles.backText}>‹ Back</Text>
          </TouchableOpacity>
        )}
        <Text style={styles.patientName}>
          {patient.firstName} {patient.lastName}
        </Text>
      </View>

      {/* Tab Bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabBar}
        contentContainerStyle={styles.tabBarContent}
      >
        {tabs.map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* ══════════════ OVERVIEW TAB ══════════════ */}
      {activeTab === 'overview' && (
        <ScrollView style={styles.tabContent} contentContainerStyle={styles.content}>
          {profileSuccess && (
            <View style={styles.profileSuccessBanner}>
              <Text style={styles.profileSuccessText}>✅ {profileSuccess}</Text>
            </View>
          )}
          {profileError && (
            <View style={styles.profileErrorBanner}>
              <Text style={styles.profileErrorText}>⚠️ {profileError}</Text>
            </View>
          )}

          {profileLoading ? (
            <ActivityIndicator color={E.colors.primary} style={styles.loader} />
          ) : editingProfile ? (
            <>
              <View style={styles.profileEditHeader}>
                <Text style={styles.profileSectionHeading}>✏️  Edit Medical Profile</Text>
                <View style={styles.profileEditActions}>
                  <TouchableOpacity
                    style={styles.profileCancelBtn}
                    onPress={() => { setDraft(profile); setEditingProfile(false); setProfileError(null); }}
                  >
                    <Text style={styles.profileCancelBtnText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.profileSaveBtn, profileSaving && styles.profileBtnDisabled]}
                    onPress={handleSaveProfile}
                    disabled={profileSaving}
                  >
                    {profileSaving
                      ? <ActivityIndicator color={colors.surface} size="small" />
                      : <Text style={styles.profileSaveBtnText}>Save</Text>}
                  </TouchableOpacity>
                </View>
              </View>

              {/* Demographics */}
              <View style={styles.profileSection}>
                <Text style={styles.profileSectionLabel}>DEMOGRAPHICS</Text>
                <Text style={styles.profileFieldLabel}>Date of Birth</Text>
                <TextInput
                  style={styles.profileInput}
                  value={draft.date_of_birth}
                  onChangeText={(v) => setDraft(d => ({ ...d, date_of_birth: v }))}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.text.secondary}
                />
                <Text style={styles.profileFieldLabel}>Gender</Text>
                <View style={styles.profileChipRow}>
                  {['male', 'female', 'other', 'prefer_not_to_say'].map(opt => (
                    <TouchableOpacity
                      key={opt}
                      style={[styles.profileChip, draft.gender === opt && styles.profileChipActive]}
                      onPress={() => setDraft(d => ({ ...d, gender: opt }))}
                    >
                      <Text style={[styles.profileChipText, draft.gender === opt && styles.profileChipTextActive]}>
                        {opt.replace('_', ' ')}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.profileFieldLabel}>Blood Type</Text>
                <View style={styles.profileChipRow}>
                  {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown'].map(opt => (
                    <TouchableOpacity
                      key={opt}
                      style={[styles.profileChip, draft.blood_type === opt && styles.profileChipActive]}
                      onPress={() => setDraft(d => ({ ...d, blood_type: opt }))}
                    >
                      <Text style={[styles.profileChipText, draft.blood_type === opt && styles.profileChipTextActive]}>
                        {opt}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={styles.profileRow2}>
                  <View style={styles.profileInputHalf}>
                    <Text style={styles.profileFieldLabel}>Height (cm)</Text>
                    <TextInput
                      style={styles.profileInput}
                      value={draft.height_cm != null ? String(draft.height_cm) : ''}
                      onChangeText={(v) => setDraft(d => ({ ...d, height_cm: v ? parseFloat(v) : null }))}
                      placeholder="e.g. 170"
                      placeholderTextColor={colors.text.secondary}
                      keyboardType="numeric"
                    />
                  </View>
                  <View style={styles.profileInputHalf}>
                    <Text style={styles.profileFieldLabel}>Weight (kg)</Text>
                    <TextInput
                      style={styles.profileInput}
                      value={draft.weight_kg != null ? String(draft.weight_kg) : ''}
                      onChangeText={(v) => setDraft(d => ({ ...d, weight_kg: v ? parseFloat(v) : null }))}
                      placeholder="e.g. 70"
                      placeholderTextColor={colors.text.secondary}
                      keyboardType="numeric"
                    />
                  </View>
                </View>
                <Text style={styles.profileFieldLabel}>Smoking Status</Text>
                <View style={styles.profileChipRow}>
                  {['never', 'former', 'current', 'unknown'].map(opt => (
                    <TouchableOpacity
                      key={opt}
                      style={[styles.profileChip, draft.smoking_status === opt && styles.profileChipActive]}
                      onPress={() => setDraft(d => ({ ...d, smoking_status: opt }))}
                    >
                      <Text style={[styles.profileChipText, draft.smoking_status === opt && styles.profileChipTextActive]}>
                        {opt}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Allergies */}
              <View style={styles.profileSection}>
                <Text style={styles.profileSectionLabel}>ALLERGIES</Text>
                {draft.allergies.map((a, i) => (
                  <View key={i} style={styles.profileListItemRow}>
                    <TextInput
                      style={[styles.profileInput, styles.profileListInput]}
                      value={a}
                      onChangeText={(v) => setDraft(d => ({ ...d, allergies: d.allergies.map((x, j) => j === i ? v : x) }))}
                      placeholder="Allergy name"
                      placeholderTextColor={colors.text.secondary}
                    />
                    <TouchableOpacity
                      style={styles.profileRemoveBtn}
                      onPress={() => setDraft(d => ({ ...d, allergies: d.allergies.filter((_, j) => j !== i) }))}
                    >
                      <Text style={styles.profileRemoveBtnText}>✕</Text>
                    </TouchableOpacity>
                  </View>
                ))}
                <TouchableOpacity
                  style={styles.profileAddRowBtn}
                  onPress={() => setDraft(d => ({ ...d, allergies: [...d.allergies, ''] }))}
                >
                  <Text style={styles.profileAddRowBtnText}>＋ Add Allergy</Text>
                </TouchableOpacity>
              </View>

              {/* Chronic Conditions */}
              <View style={styles.profileSection}>
                <Text style={styles.profileSectionLabel}>CHRONIC CONDITIONS</Text>
                {draft.chronic_conditions.map((c, i) => (
                  <View key={i} style={styles.profileListItemRow}>
                    <TextInput
                      style={[styles.profileInput, styles.profileListInput]}
                      value={c}
                      onChangeText={(v) => setDraft(d => ({ ...d, chronic_conditions: d.chronic_conditions.map((x, j) => j === i ? v : x) }))}
                      placeholder="Condition name"
                      placeholderTextColor={colors.text.secondary}
                    />
                    <TouchableOpacity
                      style={styles.profileRemoveBtn}
                      onPress={() => setDraft(d => ({ ...d, chronic_conditions: d.chronic_conditions.filter((_, j) => j !== i) }))}
                    >
                      <Text style={styles.profileRemoveBtnText}>✕</Text>
                    </TouchableOpacity>
                  </View>
                ))}
                <TouchableOpacity
                  style={styles.profileAddRowBtn}
                  onPress={() => setDraft(d => ({ ...d, chronic_conditions: [...d.chronic_conditions, ''] }))}
                >
                  <Text style={styles.profileAddRowBtnText}>＋ Add Condition</Text>
                </TouchableOpacity>
              </View>

              {/* Current Medications (free-text) */}
              <View style={styles.profileSection}>
                <Text style={styles.profileSectionLabel}>CURRENT MEDICATIONS (notes)</Text>
                {draft.current_medications.map((m, i) => (
                  <View key={i} style={styles.profileListItemRow}>
                    <TextInput
                      style={[styles.profileInput, styles.profileListInput]}
                      value={m}
                      onChangeText={(v) => setDraft(d => ({ ...d, current_medications: d.current_medications.map((x, j) => j === i ? v : x) }))}
                      placeholder="Medication name"
                      placeholderTextColor={colors.text.secondary}
                    />
                    <TouchableOpacity
                      style={styles.profileRemoveBtn}
                      onPress={() => setDraft(d => ({ ...d, current_medications: d.current_medications.filter((_, j) => j !== i) }))}
                    >
                      <Text style={styles.profileRemoveBtnText}>✕</Text>
                    </TouchableOpacity>
                  </View>
                ))}
                <TouchableOpacity
                  style={styles.profileAddRowBtn}
                  onPress={() => setDraft(d => ({ ...d, current_medications: [...d.current_medications, ''] }))}
                >
                  <Text style={styles.profileAddRowBtnText}>＋ Add Medication</Text>
                </TouchableOpacity>
              </View>

              {/* Emergency Contact */}
              <View style={styles.profileSection}>
                <Text style={styles.profileSectionLabel}>EMERGENCY CONTACT</Text>
                <Text style={styles.profileFieldLabel}>Name</Text>
                <TextInput
                  style={styles.profileInput}
                  value={draft.emergency_contact_name}
                  onChangeText={(v) => setDraft(d => ({ ...d, emergency_contact_name: v }))}
                  placeholder="Full name"
                  placeholderTextColor={colors.text.secondary}
                />
                <Text style={styles.profileFieldLabel}>Phone</Text>
                <TextInput
                  style={styles.profileInput}
                  value={draft.emergency_contact_phone}
                  onChangeText={(v) => setDraft(d => ({ ...d, emergency_contact_phone: v }))}
                  placeholder="+49 000 000000"
                  placeholderTextColor={colors.text.secondary}
                  keyboardType="phone-pad"
                />
              </View>

              {/* Clinical Notes */}
              <View style={styles.profileSection}>
                <Text style={styles.profileSectionLabel}>CLINICAL NOTES</Text>
                <TextInput
                  style={[styles.profileInput, styles.profileTextarea]}
                  value={draft.notes}
                  onChangeText={(v) => setDraft(d => ({ ...d, notes: v }))}
                  placeholder="General observations, follow-up reminders…"
                  placeholderTextColor={colors.text.secondary}
                  multiline
                  numberOfLines={4}
                />
              </View>

              {/* Bottom save button */}
              <TouchableOpacity
                style={[styles.profileSaveBtn, profileSaving && styles.profileBtnDisabled, { marginTop: 8 }]}
                onPress={handleSaveProfile}
                disabled={profileSaving}
              >
                {profileSaving
                  ? <ActivityIndicator color={colors.surface} />
                  : <Text style={styles.profileSaveBtnText}>💾  Save Medical Profile</Text>}
              </TouchableOpacity>
            </>
          ) : (
            /* VIEW MODE */
            <>
              {/* Patient identity card */}
              <View style={styles.profileIdentityCard}>
                <View style={styles.profileAvatar}>
                  <Text style={styles.profileAvatarText}>
                    {patient.firstName?.[0]?.toUpperCase()}{patient.lastName?.[0]?.toUpperCase()}
                  </Text>
                </View>
                <View style={styles.profileIdentityInfo}>
                  <Text style={styles.profilePatientName}>{patient.firstName} {patient.lastName}</Text>
                  <Text style={styles.profilePatientEmail}>{patient.email}</Text>
                  {profile.date_of_birth ? (
                    <Text style={styles.profilePatientMeta}>
                      🎂 {profile.date_of_birth}
                      {profile.gender ? `  ·  ${profile.gender}` : ''}
                    </Text>
                  ) : null}
                </View>
              </View>

              {/* Quick-stats row */}
              <View style={styles.profileQuickStats}>
                {[
                  { icon: '🩸', label: 'Blood Type', value: profile.blood_type !== 'unknown' ? profile.blood_type : '—' },
                  { icon: '📏', label: 'Height',     value: profile.height_cm ? `${profile.height_cm} cm` : '—' },
                  { icon: '⚖️', label: 'Weight',     value: profile.weight_kg ? `${profile.weight_kg} kg` : '—' },
                  { icon: '🚬', label: 'Smoking',    value: profile.smoking_status !== 'unknown' ? profile.smoking_status : '—' },
                ].map((stat, i, arr) => (
                  <React.Fragment key={stat.label}>
                    <View style={styles.profileQuickStat}>
                      <Text style={styles.profileQuickStatIcon}>{stat.icon}</Text>
                      <Text style={styles.profileQuickStatValue}>{stat.value}</Text>
                      <Text style={styles.profileQuickStatLabel}>{stat.label}</Text>
                    </View>
                    {i < arr.length - 1 && <View style={styles.profileQuickStatDivider} />}
                  </React.Fragment>
                ))}
              </View>

              {/* Allergies */}
              <View style={styles.profileSection}>
                <Text style={styles.profileSectionLabel}>ALLERGIES</Text>
                {profile.allergies.length === 0
                  ? <Text style={styles.profileEmpty}>None recorded</Text>
                  : <View style={styles.profileTagCloud}>
                      {profile.allergies.map((a, i) => (
                        <View key={i} style={styles.profileTagDanger}>
                          <Text style={styles.profileTagDangerText}>⚠ {a}</Text>
                        </View>
                      ))}
                    </View>
                }
              </View>

              {/* Chronic Conditions */}
              <View style={styles.profileSection}>
                <Text style={styles.profileSectionLabel}>CHRONIC CONDITIONS</Text>
                {profile.chronic_conditions.length === 0
                  ? <Text style={styles.profileEmpty}>None recorded</Text>
                  : profile.chronic_conditions.map((c, i) => (
                      <View key={i} style={styles.profileListRow}>
                        <View style={styles.profileListDot} />
                        <Text style={styles.profileListText}>{c}</Text>
                      </View>
                    ))
                }
              </View>

              {/* Current Medications (free-text notes) */}
              <View style={styles.profileSection}>
                <Text style={styles.profileSectionLabel}>CURRENT MEDICATIONS (notes)</Text>
                {profile.current_medications.length === 0
                  ? <Text style={styles.profileEmpty}>None recorded</Text>
                  : profile.current_medications.map((m, i) => (
                      <View key={i} style={styles.profileListRow}>
                        <Text style={styles.profileMedIcon}>💊</Text>
                        <Text style={styles.profileListText}>{m}</Text>
                      </View>
                    ))
                }
              </View>

              {/* Emergency Contact */}
              {(profile.emergency_contact_name || profile.emergency_contact_phone) && (
                <View style={styles.profileSection}>
                  <Text style={styles.profileSectionLabel}>EMERGENCY CONTACT</Text>
                  <View style={styles.profileEmergencyCard}>
                    <Text style={styles.profileEmergencyIcon}>🆘</Text>
                    <View>
                      {profile.emergency_contact_name ? (
                        <Text style={styles.profileEmergencyName}>{profile.emergency_contact_name}</Text>
                      ) : null}
                      {profile.emergency_contact_phone ? (
                        <Text style={styles.profileEmergencyPhone}>{profile.emergency_contact_phone}</Text>
                      ) : null}
                    </View>
                  </View>
                </View>
              )}

              {/* Clinical Notes */}
              {profile.notes ? (
                <View style={styles.profileSection}>
                  <Text style={styles.profileSectionLabel}>CLINICAL NOTES</Text>
                  <View style={styles.profileNotesBox}>
                    <Text style={styles.profileNotesText}>{profile.notes}</Text>
                  </View>
                </View>
              ) : null}

              {profile.updated_at ? (
                <Text style={styles.profileUpdatedAt}>
                  Last updated: {profile.updated_at.slice(0, 10)}
                </Text>
              ) : null}

              <TouchableOpacity
                style={styles.profileEditBtn}
                onPress={() => { setDraft(profile); setEditingProfile(true); setProfileError(null); }}
              >
                <Text style={styles.profileEditBtnText}>✏️  Edit Medical Profile</Text>
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      )}

      {/* ══════════════ VISITS TAB ══════════════ */}
      {activeTab === 'visits' && (
        <>
          {/* Detail modal — rendered outside the ScrollView so it sits above everything */}
          <VisitDetailModal
            visit={selectedVisit}
            onClose={() => setSelectedVisit(null)}
            doctorName={`Dr. ${patient.firstName ?? ''} ${patient.lastName ?? ''}`.trim()}
            medications={
              selectedVisit
                ? medications.filter(
                    (m) => m.visit_id === selectedVisit.id,
                  )
                : []
            }
          />

          <ScrollView
            style={styles.tabContent}
            contentContainerStyle={styles.content}
            refreshControl={
              <RefreshControl refreshing={visitsRefreshing} onRefresh={onRefreshVisits} colors={[E.colors.primary]} />
            }
          >
            <TouchableOpacity
              style={styles.addButton}
              onPress={() =>
                router.push({
                  pathname: '/(app)/ehr/visit-form',
                  params: { patient_id: patient.id, patient_name: `${patient.firstName} ${patient.lastName}` },
                } as any)
              }
            >
              <Text style={styles.addButtonText}>➕  Add Visit</Text>
            </TouchableOpacity>
            {visitsLoading ? (
              <ActivityIndicator color={E.colors.primary} style={styles.loader} />
            ) : visitsError ? (
              <Text style={styles.errorText}>⚠️ {visitsError}</Text>
            ) : visits.length === 0 ? (
              <Text style={styles.emptyText}>No visits found.</Text>
            ) : (
              visits.map((visit, index) => {
                const visitMedCount = medications.filter((m) => m.visit_id === visit.id).length;
                return (
                  <TouchableOpacity
                    key={visit.id ?? index}
                    activeOpacity={0.75}
                    onPress={() => setSelectedVisit(visit as VisitDetail)}
                  >
                    <Card variant="outlined" padding="medium" style={styles.card}>
                      {/* Header row: date + chevron */}
                      <View style={styles.visitCardHeader}>
                        <Text style={styles.dateText}>{visit.visit_date}</Text>
                        <Text style={styles.visitChevron}>›</Text>
                      </View>
                      {visit.chief_complaint ? (
                        <>
                          <Text style={styles.fieldLabel}>Chief Complaint</Text>
                          <Text style={styles.fieldValue}>{visit.chief_complaint}</Text>
                        </>
                      ) : null}
                      {visit.diagnosis_text ? (
                        <>
                          <Text style={styles.fieldLabel}>Diagnosis</Text>
                          <Text style={styles.fieldValue}>{visit.diagnosis_text}</Text>
                        </>
                      ) : null}
                      {visit.diagnosis_icd10 ? (
                        <>
                          <Text style={styles.fieldLabel}>ICD-10</Text>
                          <Text style={styles.fieldValue}>{visit.diagnosis_icd10}</Text>
                        </>
                      ) : null}
                      {/* Medication count badge */}
                      {visitMedCount > 0 ? (
                        <View style={styles.visitMedBadge}>
                          <Text style={styles.visitMedBadgeText}>
                            💊 {visitMedCount} prescription{visitMedCount !== 1 ? 's' : ''} — tap to view
                          </Text>
                        </View>
                      ) : null}
                    </Card>
                  </TouchableOpacity>
                );
              })
            )}
          </ScrollView>
        </>
      )}

      {/* ══════════════ MEDICATIONS TAB ══════════════ */}
      {activeTab === 'medications' && (
        <View style={styles.tabContent}>
          {/* Filter sub-tabs: All / Active / Inactive */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.docSubTabBar}
            contentContainerStyle={styles.docSubTabBarContent}
          >
            {(
              [
                { key: 'active',   label: '✅ Active',   count: medications.filter(m => m.is_active !== false).length },
                { key: 'inactive', label: '⏸ Inactive', count: medications.filter(m => m.is_active === false).length },
                { key: 'all',      label: '💊 All',      count: medications.length },
              ] as const
            ).map((f) => (
              <TouchableOpacity
                key={f.key}
                style={[styles.docSubTab, medFilter === f.key && styles.docSubTabActive]}
                onPress={() => setMedFilter(f.key)}
              >
                <Text style={[styles.docSubTabText, medFilter === f.key && styles.docSubTabTextActive]}>
                  {f.label}
                </Text>
                {f.count > 0 && (
                  <View style={[styles.docSubTabBadge, medFilter === f.key && styles.docSubTabBadgeActive]}>
                    <Text style={[styles.docSubTabBadgeText, medFilter === f.key && styles.docSubTabBadgeTextActive]}>
                      {f.count}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            ))}
          </ScrollView>

          <ScrollView
            style={styles.tabContent}
            contentContainerStyle={styles.content}
            refreshControl={
              <RefreshControl refreshing={medicationsRefreshing} onRefresh={onRefreshMedications} colors={[E.colors.primary]} />
            }
          >
            {medicationsLoading ? (
              <ActivityIndicator color={E.colors.primary} style={styles.loader} />
            ) : medicationsError ? (
              <Text style={styles.errorText}>⚠️ {medicationsError}</Text>
            ) : (() => {
              const filtered =
                medFilter === 'active'   ? medications.filter(m => m.is_active !== false) :
                medFilter === 'inactive' ? medications.filter(m => m.is_active === false) :
                medications;

              if (filtered.length === 0) {
                return (
                  <View style={styles.medEmpty}>
                    <Text style={styles.medEmptyIcon}>💊</Text>
                    <Text style={styles.medEmptyTitle}>
                      No {medFilter !== 'all' ? medFilter : ''} medications
                    </Text>
                    <Text style={styles.medEmptyBody}>
                      Prescriptions added via the Visit form appear here.
                    </Text>
                  </View>
                );
              }

              return filtered.map((med, index) => {
                const isActive   = med.is_active !== false;
                const isChronic  = med.is_chronic;
                const coverage   = coverageColor(med.coverage ?? '');
                const schedule   = dosageScheduleLabel(med);
                const slots      = [
                  { label: 'Mo', amount: med.dosage_morning },
                  { label: 'Mi', amount: med.dosage_noon },
                  { label: 'Ab', amount: med.dosage_evening },
                  { label: 'Na', amount: med.dosage_night },
                ];

                return (
                  <View
                    key={med._id ?? med.id ?? index}
                    style={[styles.medCard, !isActive && styles.medCardInactive]}
                  >
                    {/* ── Header row ── */}
                    <View style={styles.medCardHeader}>
                      <View style={styles.medCardTitleBlock}>
                        <Text style={styles.medTradeName}>{med.trade_name}</Text>
                        <Text style={styles.medSubstance}>
                          {med.active_substance}
                          {med.strength ? ` · ${med.strength}` : ''}
                          {med.form     ? ` · ${med.form}` : ''}
                        </Text>
                      </View>
                      <View style={[
                        styles.medActiveBadge,
                        isActive ? styles.medActiveBadgeOn : styles.medActiveBadgeOff,
                      ]}>
                        <Text style={[
                          styles.medActiveBadgeText,
                          isActive ? styles.medActiveBadgeTextOn : styles.medActiveBadgeTextOff,
                        ]}>
                          {isActive ? 'Active' : 'Inactive'}
                        </Text>
                      </View>
                    </View>

                    {/* ── Dosage schedule pills ── */}
                    <View style={styles.medScheduleRow}>
                      {slots.map((slot) => {
                        const active = slot.amount > 0;
                        return (
                          <View
                            key={slot.label}
                            style={[styles.medSlotPill, active ? styles.medSlotPillActive : styles.medSlotPillInactive]}
                          >
                            <Text style={[styles.medSlotLabel, active ? styles.medSlotLabelActive : styles.medSlotLabelInactive]}>
                              {slot.label}
                            </Text>
                            <Text style={[styles.medSlotAmount, active ? styles.medSlotAmountActive : styles.medSlotAmountInactive]}>
                              {slot.amount}
                            </Text>
                          </View>
                        );
                      })}
                      <Text style={styles.medScheduleUnit}>{med.dosage_unit}</Text>
                    </View>

                    {/* ── Meta row: coverage + norm size + PZN ── */}
                    <View style={styles.medMetaRow}>
                      {med.coverage && (
                        <View style={[styles.medBadge, { backgroundColor: coverage.bg, borderColor: coverage.border }]}>
                          <Text style={[styles.medBadgeText, { color: coverage.text }]}>
                            {med.coverage}
                          </Text>
                        </View>
                      )}
                      {med.norm_size && (
                        <View style={styles.medBadgeNeutral}>
                          <Text style={styles.medBadgeNeutralText}>{med.norm_size}</Text>
                        </View>
                      )}
                      {med.aut_idem && (
                        <View style={styles.medBadgeNeutral}>
                          <Text style={styles.medBadgeNeutralText}>Aut-idem</Text>
                        </View>
                      )}
                      <Text style={styles.medPZN}>PZN {med.pzn}</Text>
                    </View>

                    {/* ── Dates ── */}
                    <View style={styles.medDatesRow}>
                      <Text style={styles.medDateText}>
                        Start: {med.start_date ?? '—'}
                      </Text>
                      <Text style={styles.medDateSep}>·</Text>
                      <Text style={[styles.medDateText, isChronic && styles.medChronicText]}>
                        {isChronic ? 'Dauermedikation' : `Ende: ${med.end_date ?? '—'}`}
                      </Text>
                    </View>
                    {!isActive && (med as any).deactivated_at ? (
                      <Text style={styles.medDeactivatedLabel}>
                        ⏸ Deactivated: {(med as any).deactivated_at}
                      </Text>
                    ) : null}

                    {/* ── Dosage note ── */}
                    {med.dosage_note ? (
                      <Text style={styles.medNote}>{med.dosage_note}</Text>
                    ) : null}

                    <View style={styles.medActionRow}>
                      <TouchableOpacity
                        style={[styles.medActionBtn, styles.medEditBtn]}
                        onPress={() => startDosageEdit(med)}
                        disabled={medicationActionLoadingId === medicationIdOf(med)}
                      >
                        <Text style={styles.medEditBtnText}>Edit dosage</Text>
                      </TouchableOpacity>
                      {isActive ? (
                        <TouchableOpacity
                          style={[styles.medActionBtn, styles.medDeactivateBtn,
                            medicationActionLoadingId === medicationIdOf(med) && styles.medActionBtnDisabled]}
                          onPress={() => handleDeactivateMedication(med)}
                          disabled={medicationActionLoadingId === medicationIdOf(med)}
                        >
                          <Text style={styles.medDeactivateBtnText}>
                            {medicationActionLoadingId === medicationIdOf(med) ? 'Deactivating…' : 'Deactivate'}
                          </Text>
                        </TouchableOpacity>
                      ) : (
                        <TouchableOpacity
                          style={[styles.medActionBtn, styles.medReactivateBtn,
                            medicationActionLoadingId === medicationIdOf(med) && styles.medActionBtnDisabled]}
                          onPress={() => handleReactivateMedication(med)}
                          disabled={medicationActionLoadingId === medicationIdOf(med)}
                        >
                          <Text style={styles.medReactivateBtnText}>
                            {medicationActionLoadingId === medicationIdOf(med) ? 'Reactivating…' : '▶ Reactivate'}
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>

                    {editingMedicationId === medicationIdOf(med) && (
                      <View style={styles.medEditPanel}>
                        <Text style={styles.medEditTitle}>Dosage schedule (Mo-Mi-Ab-Na)</Text>
                        <View style={styles.medEditInputsRow}>
                          <TextInput
                            style={styles.medEditInput}
                            keyboardType="number-pad"
                            value={editingDosage.morning}
                            onChangeText={(value) => setEditingDosage((prev) => ({ ...prev, morning: value }))}
                            placeholder="Mo"
                          />
                          <TextInput
                            style={styles.medEditInput}
                            keyboardType="number-pad"
                            value={editingDosage.noon}
                            onChangeText={(value) => setEditingDosage((prev) => ({ ...prev, noon: value }))}
                            placeholder="Mi"
                          />
                          <TextInput
                            style={styles.medEditInput}
                            keyboardType="number-pad"
                            value={editingDosage.evening}
                            onChangeText={(value) => setEditingDosage((prev) => ({ ...prev, evening: value }))}
                            placeholder="Ab"
                          />
                          <TextInput
                            style={styles.medEditInput}
                            keyboardType="number-pad"
                            value={editingDosage.night}
                            onChangeText={(value) => setEditingDosage((prev) => ({ ...prev, night: value }))}
                            placeholder="Na"
                          />
                        </View>
                        <View style={styles.medEditActionRow}>
                          <TouchableOpacity
                            style={[styles.medActionBtn, styles.medEditCancelBtn]}
                            onPress={cancelDosageEdit}
                            disabled={medicationActionLoadingId === medicationIdOf(med)}
                          >
                            <Text style={styles.medEditCancelBtnText}>Cancel</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.medActionBtn, styles.medEditSaveBtn]}
                            onPress={() => saveDosageEdit(medicationIdOf(med))}
                            disabled={medicationActionLoadingId === medicationIdOf(med)}
                          >
                            <Text style={styles.medEditSaveBtnText}>
                              {medicationActionLoadingId === medicationIdOf(med) ? 'Saving…' : 'Save'}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    )}
                  </View>
                );
              });
            })()}
          </ScrollView>
        </View>
      )}

      {/* ══════════════ VITALS TAB ══════════════ */}
      {activeTab === 'vitals' && (
        <View style={styles.tabContent}>
          <View style={styles.docSubTabBar}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.docSubTabBarContent}
            >
              {(
                [
                  { key: 'overview', label: '📊 Overview' },
                  { key: 'bp',       label: '🩺 Blood Pressure' },
                  { key: 'hr',       label: '💓 Heart Rate' },
                ] as const
              ).map((cat) => (
                <TouchableOpacity
                  key={cat.key}
                  style={[styles.docSubTab, vitalCategory === cat.key && styles.docSubTabActive]}
                  onPress={() => setVitalCategory(cat.key)}
                >
                  <Text style={[styles.docSubTabText, vitalCategory === cat.key && styles.docSubTabTextActive]}>
                    {cat.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          <ScrollView
            style={styles.tabContent}
            contentContainerStyle={styles.content}
            refreshControl={
              <RefreshControl refreshing={vitalsRefreshing} onRefresh={onRefreshVitals} colors={[E.colors.primary]} />
            }
          >
            {vitalsLoading ? (
              <ActivityIndicator color={E.colors.primary} style={styles.loader} />
            ) : vitalsError ? (
              <Text style={styles.errorText}>⚠️ {vitalsError}</Text>
            ) : vitals.length === 0 ? (
              <Text style={styles.emptyText}>No vitals recorded yet.</Text>
            ) : (() => {
              const latest = vitals[0];

              const bpStatus = (sys: number, dia: number): { label: string; color: string; bg: string } => {
                if (sys >= 180 || dia >= 120) return { label: 'Hypertensive Crisis', color: '#B71C1C', bg: '#FFEBEE' };
                if (sys >= 140 || dia >= 90)  return { label: 'Stage 2 High',        color: '#C62828', bg: '#FFCDD2' };
                if (sys >= 130 || dia >= 80)  return { label: 'Stage 1 High',        color: '#E65100', bg: '#FFF3E0' };
                if (sys >= 120)               return { label: 'Elevated',            color: '#F57F17', bg: '#FFFDE7' };
                return                               { label: 'Normal',              color: '#2E7D32', bg: '#E8F5E9' };
              };

              const hrStatus = (pulse: number): { label: string; color: string; bg: string } => {
                if (pulse > 130) return { label: 'Very High', color: '#B71C1C', bg: '#FFEBEE' };
                if (pulse > 100) return { label: 'High',      color: '#E65100', bg: '#FFF3E0' };
                if (pulse < 40)  return { label: 'Very Low',  color: '#B71C1C', bg: '#FFEBEE' };
                if (pulse < 60)  return { label: 'Low',       color: '#F57F17', bg: '#FFFDE7' };
                return                  { label: 'Normal',    color: '#2E7D32', bg: '#E8F5E9' };
              };

              const fmtDate = (ts?: string) => {
                if (!ts) return '—';
                try {
                  return new Date(ts).toLocaleString(undefined, {
                    day: 'numeric', month: 'short', year: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  });
                } catch { return ts; }
              };

              const trend = (curr: number | null | undefined, prev: number | null | undefined) => {
                if (curr == null || prev == null) return '';
                if (curr > prev) return ' ↑';
                if (curr < prev) return ' ↓';
                return ' →';
              };

              if (vitalCategory === 'overview') {
                const prev = vitals[1];
                const latestBP = latest.systolic != null && latest.diastolic != null ? bpStatus(latest.systolic, latest.diastolic) : null;
                const latestHR = latest.pulse != null ? hrStatus(latest.pulse) : null;

                return (
                  <>
                    {latest.urgent && (
                      <View style={styles.urgentBanner}>
                        <Text style={styles.urgentBannerText}>⚠️  Latest reading flagged as URGENT</Text>
                      </View>
                    )}
                    <View style={styles.vitalSummaryRow}>
                      {latestBP && (
                        <View style={[styles.vitalSummaryCard, { borderTopColor: latestBP.color }]}>
                          <Text style={styles.vitalSummaryIcon}>🩺</Text>
                          <Text style={styles.vitalSummaryLabel}>Blood Pressure</Text>
                          <Text style={[styles.vitalSummaryValue, { color: latestBP.color }]}>
                            {latest.systolic}/{latest.diastolic}
                          </Text>
                          <Text style={styles.vitalSummaryUnit}>mmHg</Text>
                          <View style={[styles.vitalStatusPill, { backgroundColor: latestBP.bg }]}>
                            <Text style={[styles.vitalStatusPillText, { color: latestBP.color }]}>{latestBP.label}</Text>
                          </View>
                          {prev?.systolic != null && (
                            <Text style={styles.vitalTrend}>vs prev:{trend(latest.systolic, prev.systolic)} sys</Text>
                          )}
                        </View>
                      )}
                      {latestHR && (
                        <View style={[styles.vitalSummaryCard, { borderTopColor: latestHR.color }]}>
                          <Text style={styles.vitalSummaryIcon}>💓</Text>
                          <Text style={styles.vitalSummaryLabel}>Heart Rate</Text>
                          <Text style={[styles.vitalSummaryValue, { color: latestHR.color }]}>{latest.pulse}</Text>
                          <Text style={styles.vitalSummaryUnit}>bpm</Text>
                          <View style={[styles.vitalStatusPill, { backgroundColor: latestHR.bg }]}>
                            <Text style={[styles.vitalStatusPillText, { color: latestHR.color }]}>{latestHR.label}</Text>
                          </View>
                          {prev?.pulse != null && (
                            <Text style={styles.vitalTrend}>vs prev:{trend(latest.pulse, prev.pulse)}</Text>
                          )}
                        </View>
                      )}
                    </View>
                    <View style={styles.vitalStatsRow}>
                      <View style={styles.vitalStatItem}>
                        <Text style={styles.vitalStatValue}>{vitals.length}</Text>
                        <Text style={styles.vitalStatLabel}>Total Readings</Text>
                      </View>
                      <View style={styles.vitalStatDivider} />
                      <View style={styles.vitalStatItem}>
                        <Text style={styles.vitalStatValue}>{vitals.filter(v => v.urgent).length}</Text>
                        <Text style={styles.vitalStatLabel}>Urgent</Text>
                      </View>
                      <View style={styles.vitalStatDivider} />
                      <View style={styles.vitalStatItem}>
                        <Text style={styles.vitalStatValue}>{fmtDate(latest.timestamp).split(',')[0]}</Text>
                        <Text style={styles.vitalStatLabel}>Last Reading</Text>
                      </View>
                    </View>
                    <Text style={styles.vitalSectionTitle}>All Readings</Text>
                    {vitals.map((v, i) => {
                      const bp = v.systolic != null && v.diastolic != null ? bpStatus(v.systolic, v.diastolic) : null;
                      return (
                        <View key={v.id ?? i} style={[styles.vitalTimelineCard, v.urgent && styles.vitalTimelineCardUrgent]}>
                          <View style={styles.vitalTimelineLeft}>
                            <Text style={styles.vitalTimelineDate}>{fmtDate(v.timestamp)}</Text>
                            {v.urgent && <Text style={styles.vitalUrgentTag}>⚠️ Urgent</Text>}
                          </View>
                          <View style={styles.vitalTimelineRight}>
                            {v.systolic != null && (
                              <View style={styles.vitalTimelineMetric}>
                                <Text style={[styles.vitalTimelineMetricVal, bp ? { color: bp.color } : {}]}>
                                  {v.systolic}/{v.diastolic}
                                </Text>
                                <Text style={styles.vitalTimelineMetricUnit}>mmHg</Text>
                              </View>
                            )}
                            {v.pulse != null && (
                              <View style={styles.vitalTimelineMetric}>
                                <Text style={styles.vitalTimelineMetricVal}>{v.pulse}</Text>
                                <Text style={styles.vitalTimelineMetricUnit}>bpm</Text>
                              </View>
                            )}
                          </View>
                        </View>
                      );
                    })}
                  </>
                );
              }

              if (vitalCategory === 'bp') {
                const bpReadings = vitals.filter(v => v.systolic != null && v.diastolic != null);
                if (bpReadings.length === 0) return <Text style={styles.emptyText}>No blood pressure data.</Text>;
                const latestBP = bpStatus(bpReadings[0].systolic!, bpReadings[0].diastolic!);
                return (
                  <>
                    <View style={[styles.vitalHeroCard, { borderColor: latestBP.color }]}>
                      <Text style={styles.vitalHeroLabel}>Latest Blood Pressure</Text>
                      <Text style={[styles.vitalHeroValue, { color: latestBP.color }]}>
                        {bpReadings[0].systolic}
                        <Text style={styles.vitalHeroUnit}>/{bpReadings[0].diastolic} mmHg</Text>
                      </Text>
                      <View style={[styles.vitalStatusPill, { backgroundColor: latestBP.bg }]}>
                        <Text style={[styles.vitalStatusPillText, { color: latestBP.color }]}>{latestBP.label}</Text>
                      </View>
                      <Text style={styles.vitalHeroDate}>{fmtDate(bpReadings[0].timestamp)}</Text>
                    </View>
                    <View style={styles.bpLegend}>
                      <Text style={styles.bpLegendTitle}>Reference Ranges</Text>
                      {[
                        { label: 'Normal',              range: '< 120/80',    color: '#2E7D32' },
                        { label: 'Elevated',            range: '120–129/<80', color: '#F57F17' },
                        { label: 'Stage 1 High',        range: '130–139/80–89', color: '#E65100' },
                        { label: 'Stage 2 High',        range: '≥ 140/≥90',  color: '#C62828' },
                        { label: 'Hypertensive Crisis', range: '> 180/>120',  color: '#B71C1C' },
                      ].map(r => (
                        <View key={r.label} style={styles.bpLegendRow}>
                          <View style={[styles.bpLegendDot, { backgroundColor: r.color }]} />
                          <Text style={styles.bpLegendLabel}>{r.label}</Text>
                          <Text style={styles.bpLegendRange}>{r.range}</Text>
                        </View>
                      ))}
                    </View>
                    <Text style={styles.vitalSectionTitle}>History</Text>
                    {bpReadings.map((v, i) => {
                      const st = bpStatus(v.systolic!, v.diastolic!);
                      const prev = bpReadings[i + 1];
                      return (
                        <View key={v.id ?? i} style={[styles.vitalHistoryRow, { borderLeftColor: st.color }]}>
                          <View style={styles.vitalHistoryLeft}>
                            <Text style={[styles.vitalHistoryMain, { color: st.color }]}>
                              {v.systolic}/{v.diastolic} mmHg
                            </Text>
                            <Text style={styles.vitalHistoryDate}>{fmtDate(v.timestamp)}</Text>
                          </View>
                          <View style={styles.vitalHistoryRight}>
                            <View style={[styles.vitalStatusPill, { backgroundColor: st.bg }]}>
                              <Text style={[styles.vitalStatusPillText, { color: st.color }]}>{st.label}</Text>
                            </View>
                            {prev?.systolic != null && (
                              <Text style={styles.vitalTrend}>{trend(v.systolic, prev.systolic)} sys vs prev</Text>
                            )}
                            {v.urgent && <Text style={styles.vitalUrgentTag}>⚠️ Urgent</Text>}
                          </View>
                        </View>
                      );
                    })}
                  </>
                );
              }

              if (vitalCategory === 'hr') {
                const hrReadings = vitals.filter(v => v.pulse != null);
                if (hrReadings.length === 0) return <Text style={styles.emptyText}>No heart rate data.</Text>;
                const latestHR = hrStatus(hrReadings[0].pulse!);
                return (
                  <>
                    <View style={[styles.vitalHeroCard, { borderColor: latestHR.color }]}>
                      <Text style={styles.vitalHeroLabel}>Latest Heart Rate</Text>
                      <Text style={[styles.vitalHeroValue, { color: latestHR.color }]}>
                        {hrReadings[0].pulse}
                        <Text style={styles.vitalHeroUnit}> bpm</Text>
                      </Text>
                      <View style={[styles.vitalStatusPill, { backgroundColor: latestHR.bg }]}>
                        <Text style={[styles.vitalStatusPillText, { color: latestHR.color }]}>{latestHR.label}</Text>
                      </View>
                      <Text style={styles.vitalHeroDate}>{fmtDate(hrReadings[0].timestamp)}</Text>
                    </View>
                    <Text style={styles.vitalSectionTitle}>History</Text>
                    {hrReadings.map((v, i) => {
                      const st = hrStatus(v.pulse!);
                      const prev = hrReadings[i + 1];
                      return (
                        <View key={v.id ?? i} style={[styles.vitalHistoryRow, { borderLeftColor: st.color }]}>
                          <View style={styles.vitalHistoryLeft}>
                            <Text style={[styles.vitalHistoryMain, { color: st.color }]}>{v.pulse} bpm</Text>
                            <Text style={styles.vitalHistoryDate}>{fmtDate(v.timestamp)}</Text>
                          </View>
                          <View style={styles.vitalHistoryRight}>
                            <View style={[styles.vitalStatusPill, { backgroundColor: st.bg }]}>
                              <Text style={[styles.vitalStatusPillText, { color: st.color }]}>{st.label}</Text>
                            </View>
                            {prev?.pulse != null && (
                              <Text style={styles.vitalTrend}>{trend(v.pulse, prev.pulse)} vs prev</Text>
                            )}
                            {v.urgent && <Text style={styles.vitalUrgentTag}>⚠️ Urgent</Text>}
                          </View>
                        </View>
                      );
                    })}
                  </>
                );
              }

              return null;
            })()}
          </ScrollView>
        </View>
      )}

      {/* ══════════════ MESSAGES TAB ══════════════ */}
      {activeTab === 'messages' && (
        <View style={styles.messagesContainer}>
          <ScrollView
            style={styles.tabContent}
            contentContainerStyle={styles.content}
            refreshControl={
              <RefreshControl refreshing={messagesRefreshing} onRefresh={onRefreshMessages} colors={[E.colors.primary]} />
            }
          >
            {messagesLoading ? (
              <ActivityIndicator color={E.colors.primary} style={styles.loader} />
            ) : messagesError ? (
              <Text style={styles.errorText}>⚠️ {messagesError}</Text>
            ) : messages.length === 0 ? (
              <Text style={styles.emptyText}>No messages yet.</Text>
            ) : (
              messages.map((msg, index) => {
                const isDoctor = msg.sender_type === 'doctor';
                return (
                  <View
                    key={msg.id ?? index}
                    style={[styles.messageBubble, isDoctor ? styles.messageBubbleDoctor : styles.messageBubblePatient]}
                  >
                    <Text style={[styles.messageBody, isDoctor && styles.messageBodyDoctor]}>{msg.body}</Text>
                    <Text style={[styles.messageTime, isDoctor && styles.messageTimeDoctor]}>{msg.created_at}</Text>
                  </View>
                );
              })
            )}
          </ScrollView>
          <View style={styles.messageInputRow}>
            <TextInput
              style={styles.messageInput}
              placeholder="Type a message…"
              placeholderTextColor={colors.text.secondary}
              value={messageInput}
              onChangeText={setMessageInput}
              multiline
            />
            <TouchableOpacity
              style={[styles.sendButton, (!messageInput.trim() || messageSending) && styles.sendButtonDisabled]}
              onPress={handleSendMessage}
              disabled={!messageInput.trim() || messageSending}
            >
              {messageSending
                ? <ActivityIndicator color={colors.surface} size="small" />
                : <Text style={styles.sendButtonText}>Send</Text>}
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ══════════════ DOCUMENTS TAB ══════════════ */}
      {activeTab === 'documents' && (
        <View style={styles.tabContent}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.docSubTabBar}
            contentContainerStyle={styles.docSubTabBarContent}
          >
            {(
              [
                { key: 'all',          label: '📂 All',           count: documents.length },
                { key: 'lab_report',   label: '🧪 Lab Reports',   count: documents.filter(d => d.category === 'lab_report').length },
                { key: 'imaging',      label: '🩻 Imaging',       count: documents.filter(d => d.category === 'imaging').length },
                { key: 'prescription', label: '💊 Prescriptions', count: documents.filter(d => d.category === 'prescription').length },
                { key: 'other',        label: '📄 Other',         count: documents.filter(d => !['lab_report','imaging','prescription'].includes(d.category)).length },
              ] as const
            ).map((cat) => (
              <TouchableOpacity
                key={cat.key}
                style={[styles.docSubTab, docCategory === cat.key && styles.docSubTabActive]}
                onPress={() => setDocCategory(cat.key)}
              >
                <Text style={[styles.docSubTabText, docCategory === cat.key && styles.docSubTabTextActive]}>
                  {cat.label}
                </Text>
                {cat.count > 0 && (
                  <View style={[styles.docSubTabBadge, docCategory === cat.key && styles.docSubTabBadgeActive]}>
                    <Text style={[styles.docSubTabBadgeText, docCategory === cat.key && styles.docSubTabBadgeTextActive]}>
                      {cat.count}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            ))}
          </ScrollView>

          <ScrollView
            style={styles.tabContent}
            contentContainerStyle={styles.content}
            refreshControl={
              <RefreshControl refreshing={documentsRefreshing} onRefresh={onRefreshDocuments} colors={[E.colors.primary]} />
            }
          >
            {documentsLoading ? (
              <ActivityIndicator color={E.colors.primary} style={styles.loader} />
            ) : documentsError ? (
              <Text style={styles.errorText}>⚠️ {documentsError}</Text>
            ) : (() => {
              const filtered = docCategory === 'all'
                ? documents
                : docCategory === 'other'
                  ? documents.filter(d => !['lab_report','imaging','prescription'].includes(d.category))
                  : documents.filter(d => d.category === docCategory);
              if (filtered.length === 0) return <Text style={styles.emptyText}>No {docCategory === 'all' ? '' : docCategory.replace('_', ' ')} documents found.</Text>;
              const icons: Record<string, string> = { lab_report: '🧪', imaging: '🩻', prescription: '💊', other: '📄' };
              return filtered.map((doc, index) => (
                <Card key={doc.id ?? index} variant="outlined" padding="medium" style={styles.card}>
                  <View style={styles.docHeader}>
                    <Text style={styles.docIcon}>{icons[doc.category] ?? '📄'}</Text>
                    <View style={styles.docInfo}>
                      <Text style={styles.fieldValue}>{doc.description || '(No description)'}</Text>
                      <Text style={styles.fieldLabel}>{doc.created_at}</Text>
                    </View>
                  </View>
                  <TouchableOpacity
                    style={styles.viewDocButton}
                    onPress={() => Linking.openURL(doc.url).catch(() => Alert.alert('Error', 'Unable to open document.'))}
                  >
                    <Text style={styles.viewDocButtonText}>View</Text>
                  </TouchableOpacity>
                </Card>
              ));
            })()}
          </ScrollView>
        </View>
      )}

      {/* ══════════════ EXERCISES TAB ══════════════ */}
      {activeTab === 'exercises' && (
        <ScrollView
          style={styles.tabContent}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={exercisesRefreshing} onRefresh={onRefreshExercises} colors={[E.colors.primary]} />
          }
        >
          <TouchableOpacity
            style={styles.addButton}
            onPress={() =>
              router.push({
                pathname: '/(app)/ehr/exercise-form',
                params: { patient_id: patient.id, patient_name: `${patient.firstName} ${patient.lastName}` },
              } as any)
            }
          >
            <Text style={styles.addButtonText}>➕  Add Exercise</Text>
          </TouchableOpacity>
          {exercisesLoading ? (
            <ActivityIndicator color={E.colors.primary} style={styles.loader} />
          ) : exercisesError ? (
            <Text style={styles.errorText}>⚠️ {exercisesError}</Text>
          ) : exercises.length === 0 ? (
            <Text style={styles.emptyText}>No exercises assigned.</Text>
          ) : (
            exercises.map((ex, index) => (
              <Card key={ex.id ?? index} variant="outlined" padding="medium" style={styles.card}>
                <Text style={styles.fieldValue}>{ex.title}</Text>
                <Text style={styles.fieldLabel}>{ex.category}</Text>
                {ex.description ? <Text style={styles.fieldValue}>{ex.description}</Text> : null}
                <View style={styles.exerciseDetails}>
                  <Text style={styles.fieldLabel}>🕐 {ex.frequency}</Text>
                  {ex.duration_minutes != null && <Text style={styles.fieldLabel}>⏱ {ex.duration_minutes} min</Text>}
                  {ex.repetitions != null && ex.sets != null && <Text style={styles.fieldLabel}>🔄 {ex.repetitions}×{ex.sets}</Text>}
                </View>
                {ex.notes ? (
                  <>
                    <Text style={styles.fieldLabel}>Notes</Text>
                    <Text style={styles.fieldValue}>{ex.notes}</Text>
                  </>
                ) : null}
              </Card>
            ))
          )}
        </ScrollView>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backButton: { marginBottom: spacing.xs },
  backText: { ...typography.body, color: E.colors.primary, fontWeight: '600' },
  patientName: { ...typography.h2, color: colors.text.primary },
  tabBar: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    height: 44,
    flexShrink: 0,
    flexGrow: 0,
  },
  tabBarContent: { flexDirection: 'row', alignItems: 'center', height: 44 },
  tab: { height: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.md },
  tabActive: { borderBottomWidth: 2, borderBottomColor: E.colors.primary },
  tabText: { ...typography.body, color: colors.text.secondary },
  tabTextActive: { color: E.colors.primary, fontWeight: '600' },
  tabContent: { flex: 1 },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  card: { marginBottom: spacing.md },
  loader: { marginTop: spacing.xl },
  errorText: { ...typography.body, color: colors.danger, textAlign: 'center', marginTop: spacing.xl },
  emptyText: { ...typography.body, color: colors.text.secondary, textAlign: 'center', marginTop: spacing.xl },
  fieldLabel: { ...typography.small, color: colors.text.secondary, marginTop: spacing.sm },
  fieldValue: { ...typography.body, color: colors.text.primary },
  dateText: { ...typography.body, color: colors.text.primary, fontWeight: '600', marginBottom: spacing.xs },

  // Visit card enhancements
  visitCardHeader: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
  },
  visitChevron: {
    fontSize:   22,
    color:      colors.text.secondary,
    fontWeight: '300',
    lineHeight: 26,
  },
  visitMedBadge: {
    marginTop:        spacing.sm,
    backgroundColor:  E.colors.primary + '12',
    borderRadius:     borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical:  4,
    alignSelf:        'flex-start',
  },
  visitMedBadgeText: {
    ...typography.small,
    color:      E.colors.primary,
    fontWeight: '600',
  },

  // Messages
  messagesContainer: { flex: 1 },
  messageBubble: {
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    maxWidth: '80%',
  },
  messageBubbleDoctor: { alignSelf: 'flex-end', backgroundColor: E.colors.primary },
  messageBubblePatient: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  messageBody: { ...typography.body, color: colors.text.primary },
  messageBodyDoctor: { color: colors.surface },
  messageTime: { ...typography.small, color: colors.text.secondary, marginTop: spacing.xs },
  messageTimeDoctor: { color: colors.surface, opacity: 0.8 },
  messageInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  messageInput: {
    flex: 1,
    ...typography.body,
    color: colors.text.primary,
    backgroundColor: colors.background,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginRight: spacing.sm,
    maxHeight: 100,
  },
  sendButton: {
    backgroundColor: E.colors.primary,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 64,
  },
  sendButtonDisabled: { opacity: 0.5 },
  sendButtonText: { ...typography.body, color: colors.surface, fontWeight: '600' },

  // Documents
  docHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: spacing.sm },
  docIcon: { fontSize: 22, marginRight: spacing.sm },
  docInfo: { flex: 1 },
  viewDocButton: {
    backgroundColor: E.colors.primary,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    alignSelf: 'flex-start',
  },
  viewDocButtonText: { ...typography.small, color: colors.surface, fontWeight: '600' },

  // Add buttons
  addButton: {
    backgroundColor: E.colors.primary,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  addButtonText: { ...typography.body, color: colors.surface, fontWeight: '700' },

  // Exercises
  exerciseDetails: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },

  // Sub-tabs (shared by Documents, Medications, Vitals)
  docSubTabBar: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexGrow: 0,
    flexShrink: 0,
    maxHeight: 48,
  },
  docSubTabBarContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    height: 48,
    gap: spacing.xs,
  },
  docSubTab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: 20,
    gap: 4,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  docSubTabActive: { backgroundColor: E.colors.primary, borderColor: E.colors.primary },
  docSubTabText: { ...typography.small, color: colors.text.secondary, fontWeight: '500' },
  docSubTabTextActive: { color: colors.surface, fontWeight: '700' },
  docSubTabBadge: {
    backgroundColor: colors.border,
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  docSubTabBadgeActive: { backgroundColor: 'rgba(255,255,255,0.3)' },
  docSubTabBadgeText: { ...typography.small, fontSize: 10, color: colors.text.secondary, fontWeight: '700' },
  docSubTabBadgeTextActive: { color: colors.surface },

  // ── Medications tab ──────────────────────────────────────────────────────
  medEmpty: { alignItems: 'center', paddingTop: 60, gap: 12 },
  medEmptyIcon: { fontSize: 48 },
  medEmptyTitle: { ...typography.h3, color: colors.text.primary, textAlign: 'center' },
  medEmptyBody: { ...typography.body, color: colors.text.secondary, textAlign: 'center', paddingHorizontal: spacing.xl },

  medCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: 10,
  },
  medCardInactive: {
    opacity: 0.65,
    backgroundColor: colors.background,
  },
  medCardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  medCardTitleBlock: { flex: 1, gap: 2 },
  medTradeName: { ...typography.body, color: colors.text.primary, fontWeight: '700' },
  medSubstance: { ...typography.small, color: colors.text.secondary },

  medActiveBadge: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 3,
    alignSelf: 'flex-start',
    flexShrink: 0,
  },
  medActiveBadgeOn:  { backgroundColor: '#E8F5E9' },
  medActiveBadgeOff: { backgroundColor: '#F5F5F5' },
  medActiveBadgeText: { fontSize: 11, fontWeight: '700' },
  medActiveBadgeTextOn:  { color: '#2E7D32' },
  medActiveBadgeTextOff: { color: '#757575' },

  // Dosage schedule pills (Mo-Mi-Ab-Na)
  medScheduleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  medSlotPill: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    paddingVertical: 6,
    alignItems: 'center',
    gap: 2,
  },
  medSlotPillActive:   { backgroundColor: '#E8F5E9', borderColor: '#4CAF50' },
  medSlotPillInactive: { backgroundColor: colors.background, borderColor: colors.border },
  medSlotLabel: { fontSize: 10, fontWeight: '700' },
  medSlotLabelActive:   { color: '#2E7D32' },
  medSlotLabelInactive: { color: colors.text.secondary },
  medSlotAmount: { ...typography.body, fontWeight: '700' },
  medSlotAmountActive:   { color: '#2E7D32' },
  medSlotAmountInactive: { color: colors.text.secondary },
  medScheduleUnit: { ...typography.small, color: colors.text.secondary, marginLeft: 2 },

  // Meta badges row
  medMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  medBadge: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  medBadgeText: { fontSize: 11, fontWeight: '700' },
  medBadgeNeutral: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: colors.background,
  },
  medBadgeNeutralText: { fontSize: 11, fontWeight: '600', color: colors.text.secondary },
  medPZN: { ...typography.small, color: colors.text.secondary, fontFamily: 'monospace', marginLeft: 'auto' as any },

  // Dates row
  medDatesRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  medDateText: { ...typography.small, color: colors.text.secondary },
  medDateSep:  { ...typography.small, color: colors.border },
  medChronicText: { color: E.colors.primary, fontWeight: '600' },

  medNote: { ...typography.small, color: colors.text.secondary, fontStyle: 'italic' },
  medActionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  medActionBtn: {
    flex: 1,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  medEditBtn: {
    backgroundColor: '#E3F2FD',
    borderColor: '#90CAF9',
  },
  medEditBtnText: {
    ...typography.small,
    color: '#1565C0',
    fontWeight: '700',
  },
  medDeactivateBtn: {
    backgroundColor: '#FFEBEE',
    borderColor: '#FFCDD2',
  },
  medDeactivateBtnText: {
    ...typography.small,
    color: '#C62828',
    fontWeight: '700',
  },
  medReactivateBtn: {
    backgroundColor: '#E8F5E9',
    borderColor: '#A5D6A7',
  },
  medReactivateBtnText: {
    ...typography.small,
    color: '#2E7D32',
    fontWeight: '700',
  },
  medDeactivatedLabel: {
    ...typography.small,
    color: colors.text.secondary,
    fontStyle: 'italic',
    marginTop: 2,
  },
  medActionBtnDisabled: {
    opacity: 0.5,
  },
  medEditPanel: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.background,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  medEditTitle: {
    ...typography.small,
    color: colors.text.secondary,
    fontWeight: '700',
  },
  medEditInputsRow: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  medEditInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
    color: colors.text.primary,
    textAlign: 'center',
  },
  medEditActionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  medEditCancelBtn: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },
  medEditCancelBtnText: {
    ...typography.small,
    color: colors.text.secondary,
    fontWeight: '700',
  },
  medEditSaveBtn: {
    backgroundColor: E.colors.primary,
    borderColor: E.colors.primary,
  },
  medEditSaveBtnText: {
    ...typography.small,
    color: colors.surface,
    fontWeight: '700',
  },

  // ── Vitals enhanced ──────────────────────────────────────────────────────
  urgentBanner: {
    backgroundColor: '#FFEBEE',
    borderRadius: borderRadius.md,
    borderLeftWidth: 4,
    borderLeftColor: '#B71C1C',
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  urgentBannerText: { ...typography.body, color: '#B71C1C', fontWeight: '700' },
  vitalSummaryRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  vitalSummaryCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopWidth: 4,
    padding: spacing.md,
    alignItems: 'center',
    gap: 4,
  },
  vitalSummaryIcon: { fontSize: 22 },
  vitalSummaryLabel: { ...typography.small, color: colors.text.secondary, fontWeight: '600', textAlign: 'center' },
  vitalSummaryValue: { fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  vitalSummaryUnit: { ...typography.small, color: colors.text.secondary },
  vitalTrend: { ...typography.small, color: colors.text.secondary, marginTop: 2 },
  vitalStatsRow: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
    alignItems: 'center',
  },
  vitalStatItem: { flex: 1, alignItems: 'center', gap: 2 },
  vitalStatDivider: { width: 1, height: 36, backgroundColor: colors.border },
  vitalStatValue: { ...typography.h2, color: colors.text.primary, fontWeight: '700' },
  vitalStatLabel: { ...typography.small, color: colors.text.secondary, textAlign: 'center' },
  vitalStatusPill: { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' },
  vitalStatusPillText: { fontSize: 11, fontWeight: '700' },
  vitalSectionTitle: {
    ...typography.body,
    color: colors.text.secondary,
    fontWeight: '700',
    marginBottom: spacing.sm,
    marginTop: spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontSize: 11,
  },
  vitalTimelineCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  vitalTimelineCardUrgent: { borderColor: '#EF9A9A', backgroundColor: '#FFF8F8' },
  vitalTimelineLeft: { flex: 1, gap: 2 },
  vitalTimelineDate: { ...typography.small, color: colors.text.secondary },
  vitalUrgentTag: { fontSize: 11, color: '#B71C1C', fontWeight: '700' },
  vitalTimelineRight: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  vitalTimelineMetric: { alignItems: 'center' },
  vitalTimelineMetricVal: { ...typography.body, fontWeight: '700' },
  vitalTimelineMetricUnit: { fontSize: 10, color: colors.text.secondary },
  vitalHeroCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 2,
    padding: spacing.lg,
    alignItems: 'center',
    marginBottom: spacing.md,
    gap: 4,
  },
  vitalHeroLabel: {
    ...typography.small, color: colors.text.secondary, fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  vitalHeroValue: { fontSize: 48, fontWeight: '800', letterSpacing: -1 },
  vitalHeroUnit: { fontSize: 18, fontWeight: '400' },
  vitalHeroDate: { ...typography.small, color: colors.text.secondary, marginTop: 6 },
  bpLegend: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: 6,
  },
  bpLegendTitle: {
    ...typography.small, color: colors.text.secondary, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2,
  },
  bpLegendRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  bpLegendDot: { width: 10, height: 10, borderRadius: 5 },
  bpLegendLabel: { ...typography.small, color: colors.text.primary, flex: 1, fontWeight: '500' },
  bpLegendRange: { ...typography.small, color: colors.text.secondary },
  vitalHistoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  vitalHistoryLeft: { flex: 1, gap: 3 },
  vitalHistoryMain: { ...typography.body, fontWeight: '700' },
  vitalHistoryDate: { ...typography.small, color: colors.text.secondary },
  vitalHistoryRight: { alignItems: 'flex-end', gap: 4 },

  // ── Medical Profile ──────────────────────────────────────────────────────
  profileSuccessBanner: {
    backgroundColor: '#E8F5E9', borderRadius: borderRadius.md,
    borderLeftWidth: 4, borderLeftColor: '#2E7D32', padding: spacing.md, marginBottom: spacing.md,
  },
  profileSuccessText: { ...typography.body, color: '#2E7D32', fontWeight: '600' },
  profileErrorBanner: {
    backgroundColor: colors.danger + '12', borderRadius: borderRadius.md,
    borderLeftWidth: 4, borderLeftColor: colors.danger, padding: spacing.md, marginBottom: spacing.md,
  },
  profileErrorText: { ...typography.body, color: colors.danger },
  profileIdentityCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    borderRadius: borderRadius.md, borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, marginBottom: spacing.md, gap: spacing.md,
  },
  profileAvatar: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: E.colors.primary, alignItems: 'center', justifyContent: 'center',
  },
  profileAvatarText: { ...typography.h2, color: colors.surface, fontWeight: '700' },
  profileIdentityInfo: { flex: 1, gap: 2 },
  profilePatientName: { ...typography.h3, color: colors.text.primary, fontWeight: '700' },
  profilePatientEmail: { ...typography.small, color: colors.text.secondary },
  profilePatientMeta: { ...typography.small, color: colors.text.secondary, marginTop: 2 },
  profileQuickStats: {
    flexDirection: 'row', backgroundColor: colors.surface, borderRadius: borderRadius.md,
    borderWidth: 1, borderColor: colors.border, padding: spacing.sm, marginBottom: spacing.md, alignItems: 'center',
  },
  profileQuickStat: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: spacing.xs },
  profileQuickStatIcon: { fontSize: 18 },
  profileQuickStatValue: { ...typography.body, color: colors.text.primary, fontWeight: '700', textAlign: 'center' },
  profileQuickStatLabel: { ...typography.small, color: colors.text.secondary, textAlign: 'center' },
  profileQuickStatDivider: { width: 1, height: 40, backgroundColor: colors.border },
  profileSection: {
    backgroundColor: colors.surface, borderRadius: borderRadius.md, borderWidth: 1,
    borderColor: colors.border, padding: spacing.md, marginBottom: spacing.md, gap: 8,
  },
  profileSectionLabel: {
    fontSize: 10, fontWeight: '700', color: colors.text.secondary,
    letterSpacing: 1, textTransform: 'uppercase', marginBottom: 2,
  },
  profileEmpty: { ...typography.small, color: colors.text.secondary, fontStyle: 'italic' },
  profileTagCloud: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  profileTagDanger: {
    backgroundColor: '#FFEBEE', borderRadius: 20, paddingHorizontal: 10,
    paddingVertical: 4, borderWidth: 1, borderColor: '#EF9A9A',
  },
  profileTagDangerText: { ...typography.small, color: '#B71C1C', fontWeight: '600' },
  profileListRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  profileListDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: E.colors.primary, marginTop: 6 },
  profileMedIcon: { fontSize: 14, marginTop: 1 },
  profileListText: { ...typography.body, color: colors.text.primary, flex: 1 },
  profileEmergencyCard: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFF8E1',
    borderRadius: borderRadius.sm, padding: spacing.sm, gap: spacing.sm, borderWidth: 1, borderColor: '#FFE082',
  },
  profileEmergencyIcon: { fontSize: 22 },
  profileEmergencyName: { ...typography.body, color: colors.text.primary, fontWeight: '700' },
  profileEmergencyPhone: { ...typography.body, color: colors.text.secondary },
  profileNotesBox: {
    backgroundColor: colors.background, borderRadius: borderRadius.sm,
    padding: spacing.sm, borderLeftWidth: 3, borderLeftColor: E.colors.primary,
  },
  profileNotesText: { ...typography.body, color: colors.text.primary },
  profileUpdatedAt: { ...typography.small, color: colors.text.secondary, textAlign: 'right', marginBottom: spacing.sm },
  profileEditBtn: {
    backgroundColor: E.colors.primary, borderRadius: borderRadius.md,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md, alignItems: 'center', marginTop: spacing.xs,
  },
  profileEditBtnText: { ...typography.body, color: colors.surface, fontWeight: '700' },
  profileEditHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md,
  },
  profileSectionHeading: { ...typography.h3, color: colors.text.primary, fontWeight: '700' },
  profileEditActions: { flexDirection: 'row', gap: spacing.sm },
  profileCancelBtn: {
    borderRadius: borderRadius.md, borderWidth: 1, borderColor: colors.border,
    paddingVertical: spacing.xs, paddingHorizontal: spacing.md, justifyContent: 'center',
  },
  profileCancelBtnText: { ...typography.body, color: colors.text.secondary, fontWeight: '600' },
  profileSaveBtn: {
    backgroundColor: E.colors.primary, borderRadius: borderRadius.md,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
    alignItems: 'center', justifyContent: 'center', minWidth: 72, height: 40,
  },
  profileSaveBtnText: { ...typography.body, color: colors.surface, fontWeight: '700' },
  profileBtnDisabled: { opacity: 0.55 },
  profileFieldLabel: { ...typography.small, color: colors.text.secondary, fontWeight: '600', marginBottom: 2 },
  profileInput: {
    ...typography.body, color: colors.text.primary, backgroundColor: colors.background,
    borderRadius: borderRadius.sm, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, minHeight: 40,
  },
  profileTextarea: { minHeight: 90, textAlignVertical: 'top', paddingTop: spacing.sm },
  profileRow2: { flexDirection: 'row', gap: spacing.sm },
  profileInputHalf: { flex: 1 },
  profileChipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  profileChip: {
    borderRadius: 20, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: spacing.sm, paddingVertical: 4,
  },
  profileChipActive: { backgroundColor: E.colors.primary, borderColor: E.colors.primary },
  profileChipText: { ...typography.small, color: colors.text.secondary, fontWeight: '500' },
  profileChipTextActive: { color: colors.surface, fontWeight: '700' },
  profileListItemRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  profileListInput: { flex: 1 },
  profileRemoveBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: colors.danger + '15', alignItems: 'center', justifyContent: 'center',
  },
  profileRemoveBtnText: { ...typography.small, color: colors.danger, fontWeight: '700' },
  profileAddRowBtn: {
    alignSelf: 'flex-start', paddingVertical: 4, paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.sm, borderWidth: 1, borderStyle: 'dashed',
    borderColor: E.colors.primary, marginTop: 2,
  },
  profileAddRowBtnText: { ...typography.small, color: E.colors.primary, fontWeight: '600' },
});