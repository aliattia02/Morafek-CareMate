/**
 * Visit Form Screen (Doctor only)
 * Location: mobile/app/(app)/ehr/visit-form.tsx
 *
 * Changes vs. previous version
 * ─────────────────────────────
 * • Replaced the plain "ICD-10-GM Code" TextInput with the new
 *   <ICD10SearchInput> component that provides:
 *     – Live local search over all 14 370 ICD-10-GM 2026 terminal codes
 *     – ✨ AI-Assist button → POST /api/ehr/icd10-suggest returns ranked
 *       suggestions based on chief_complaint + diagnosis_hint
 *     – Auto-fills BOTH diagnosisIcd10 AND diagnosisText on selection
 *
 * • The rest of the form (chief complaint, visit date, notes, submission
 *   logic, web-compatible success/error banners) is unchanged.
 */

import React, { useRef, useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, Input, Button } from '@/components/ui';
import { useAuthStore }        from '@/store/auth.store';
import { apiClient }           from '@/services/api/client';
import { API }                 from '@/services/api/endpoints';
import { createDoctorMedication } from '@/services/api/medications';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

import ICD10SearchInput, { ICD10Selection } from '@/components/ehr/ICD10SearchInput';
import MedicationPrescriptionPanel, {
  MedicationPrescriptionPanelRef,
} from '@/components/ehr/MedicationPrescriptionPanel';

const todayISO = (): string => new Date().toISOString().split('T')[0];

export default function VisitFormScreen() {
  const router = useRouter();
  const { user } = useAuthStore();
  const { patient_id, patient_name } = useLocalSearchParams<{
    patient_id?:   string;
    patient_name?: string;
  }>();

  const [chiefComplaint, setChiefComplaint] = useState('');
  const [diagnosisIcd10, setDiagnosisIcd10] = useState('');
  const [diagnosisText,  setDiagnosisText]  = useState('');
  const [visitDate,      setVisitDate]      = useState(todayISO());
  const [notes,          setNotes]          = useState('');
  const [errors,         setErrors]         = useState<Record<string, string>>({});
  const [submitting,     setSubmitting]     = useState(false);
  const [successMsg,     setSuccessMsg]     = useState<string | null>(null);
  const [submitError,    setSubmitError]    = useState<string | null>(null);
  const medicationPanelRef = useRef<MedicationPrescriptionPanelRef>(null);

  // Redirect non-doctors to home (must be in useEffect — cannot navigate during render)
  useEffect(() => {
    if (user?.user_type !== 'doctor') {
      router.replace('/');
    }
  }, [user?.user_type]);

  if (user?.user_type !== 'doctor') {
    return null;
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!chiefComplaint.trim()) newErrors.chiefComplaint = 'Leitsymptom ist erforderlich';
    if (!diagnosisText.trim())  newErrors.diagnosisText  = 'Diagnosebeschreibung ist erforderlich';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // ── ICD-10 selection callback ────────────────────────────────────────────
  const handleICD10Select = ({ code, description }: ICD10Selection) => {
    setDiagnosisIcd10(code);
    // Only overwrite diagnosisText if the doctor hasn't typed something custom
    if (!diagnosisText.trim() || diagnosisText === diagnosisIcd10) {
      setDiagnosisText(description);
      setErrors((prev) => ({ ...prev, diagnosisText: '' }));
    }
  };

  // ── Submit ───────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!validate()) return;
    if (!patient_id) {
      setSubmitError('Patienten-ID fehlt. Bitte gehen Sie zurück und versuchen Sie es erneut.');
      return;
    }

    let medicationPayload = null;
    if (medicationPanelRef.current?.hasEnabledPrescription()) {
      medicationPayload = medicationPanelRef.current.getPayload();
      if (!medicationPayload) {
        setSubmitError('Bitte prüfen Sie die Medikationsangaben.');
        return;
      }
    }

    try {
      setSubmitting(true);
      setSubmitError(null);

      const visitRes = await apiClient.post<{ id?: string; _id?: string }>(
        API.EHR.PATIENT_VISITS(patient_id),
        {
        chief_complaint: chiefComplaint.trim(),
        diagnosis_icd10: diagnosisIcd10.trim(),
        diagnosis_text:  diagnosisText.trim(),
        notes:           notes.trim() || undefined,
        visit_date:      visitDate.trim() || todayISO(),
        }
      );

      const visitId = visitRes.data?.id ?? visitRes.data?._id;
      if (medicationPayload) {
        await createDoctorMedication(patient_id, {
          ...medicationPayload,
          visit_id: visitId || undefined,
        });
      }

      const name = patient_name ? ` für ${patient_name}` : '';
      setSuccessMsg(
        medicationPayload
          ? `✅  Besuch${name} und Medikation wurden erfolgreich gespeichert.`
          : `✅  Besuch${name} wurde erfolgreich gespeichert.`
      );
      setTimeout(() => router.back(), 1500);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Fehler beim Speichern';
      setSubmitError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen
        options={{ title: patient_name ? `Besuch – ${patient_name}` : 'Neuer Besuch' }}
      />
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Success banner ── */}
          {successMsg && (
            <View style={styles.successBanner}>
              <Text style={styles.successText}>{successMsg}</Text>
            </View>
          )}

          {/* ── Error banner ── */}
          {submitError && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorBannerText}>⚠️  {submitError}</Text>
            </View>
          )}

          <Card variant="elevated" padding="large" style={styles.card}>
            <Text style={styles.title}>Besuch dokumentieren</Text>
            {patient_name ? (
              <Text style={styles.subtitle}>Patient: {patient_name}</Text>
            ) : null}

            {/* ── Chief Complaint ── */}
            <Input
              label="Leitsymptom / Vorstellungsgrund"
              value={chiefComplaint}
              onChangeText={(v) => {
                setChiefComplaint(v);
                setErrors((prev) => ({ ...prev, chiefComplaint: '' }));
              }}
              placeholder="Hauptgrund für den Besuch"
              error={errors.chiefComplaint}
              required
            />

            {/* ── ICD-10 Search (replaces plain TextInput) ── */}
            {/*
             *  The picker:
             *    • queries the local ICD-10-GM 2026 database (14 370 codes)
             *    • offers ✨ KI-Assist that calls POST /api/ehr/icd10-suggest
             *    • on selection auto-fills code + description
             *
             *  It is wrapped in a View with zIndex so the dropdown floats
             *  above sibling inputs.
             */}
            <View style={styles.icdPickerWrapper}>
              <ICD10SearchInput
                value={diagnosisIcd10}
                onSelect={handleICD10Select}
                chiefComplaint={chiefComplaint}
                diagnosisHint={diagnosisText}
                aiAssist
              />
            </View>

            {/* ── Diagnosis Description ── */}
            <Input
              label="Diagnosebeschreibung"
              value={diagnosisText}
              onChangeText={(v) => {
                setDiagnosisText(v);
                setErrors((prev) => ({ ...prev, diagnosisText: '' }));
              }}
              placeholder="Diagnose beschreiben (oder aus ICD-Suche übernehmen)"
              error={errors.diagnosisText}
              required
            />

            <MedicationPrescriptionPanel
              ref={medicationPanelRef}
              startDateDefault={visitDate}
            />

            {/* ── Visit Date ── */}
            <Input
              label="Besuchsdatum"
              value={visitDate}
              onChangeText={setVisitDate}
              placeholder="JJJJ-MM-TT"
              helperText="Format: JJJJ-MM-TT"
            />

            {/* ── Notes ── */}
            <Input
              label="Notizen"
              value={notes}
              onChangeText={setNotes}
              placeholder="Zusätzliche Notizen (optional)"
              multiline
              numberOfLines={4}
            />

            <View style={styles.buttonRow}>
              <Button
                title={submitting ? 'Wird gespeichert…' : 'Besuch speichern'}
                onPress={handleSubmit}
                loading={submitting}
                disabled={!!successMsg}
                fullWidth
              />
            </View>
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  keyboardView: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    padding: spacing.lg,
  },
  card:     { marginBottom: spacing.lg },
  title:    { ...typography.h2, color: colors.text.primary, marginBottom: spacing.xs },
  subtitle: { ...typography.body, color: colors.text.secondary, marginBottom: spacing.lg },
  buttonRow: { marginTop: spacing.md },

  // ICD picker needs elevated zIndex so the dropdown floats over siblings
  icdPickerWrapper: {
    zIndex:    10,
    elevation: 10,  // Android
  },

  // Success banner
  successBanner: {
    backgroundColor: (colors as any).successLight ?? '#E8F5E9',
    borderRadius:    borderRadius.md,
    borderLeftWidth: 4,
    borderLeftColor: (colors as any).success ?? '#2E7D32',
    padding:         spacing.md,
    marginBottom:    spacing.md,
  },
  successText: {
    ...typography.body,
    color:      (colors as any).success ?? '#2E7D32',
    fontWeight: '600',
  },

  // Error banner
  errorBanner: {
    backgroundColor: colors.danger + '12',
    borderRadius:    borderRadius.md,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
    padding:         spacing.md,
    marginBottom:    spacing.md,
  },
  errorBannerText: {
    ...typography.body,
    color: colors.danger,
  },
});
