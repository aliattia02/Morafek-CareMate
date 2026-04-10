/**
 * Visit Form Screen (Doctor only)
 * Location: mobile/app/(app)/ehr/visit-form.tsx
 *
 * Allows a doctor to record a patient visit with chief complaint,
 * ICD-10-GM code (optional), diagnosis, visit date, and notes.
 *
 * Web-compatibility note:
 *   Alert.alert with callbacks does NOT work on Expo Web (maps to the
 *   synchronous window.alert which drops onPress).  All feedback is
 *   shown via inline banners + automatic navigation instead.
 *
 * Backend change:
 *   diagnosis_icd10 is now optional — the backend no longer rejects
 *   requests where it is absent or empty.
 */

import React, { useState } from 'react';
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
import { useAuthStore } from '@/store/auth.store';
import { apiClient } from '@/services/api/client';
import { API } from '@/services/api/endpoints';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

const todayISO = (): string => new Date().toISOString().split('T')[0];

export default function VisitFormScreen() {
  const router = useRouter();
  const { user } = useAuthStore();
  const { patient_id, patient_name } = useLocalSearchParams<{
    patient_id?: string;
    patient_name?: string;
  }>();

  const [chiefComplaint, setChiefComplaint] = useState('');
  const [diagnosisIcd10, setDiagnosisIcd10] = useState('');
  const [diagnosisText, setDiagnosisText]   = useState('');
  const [visitDate, setVisitDate]           = useState(todayISO());
  const [notes, setNotes]                   = useState('');
  const [errors, setErrors]                 = useState<Record<string, string>>({});
  const [submitting, setSubmitting]         = useState(false);
  const [successMsg, setSuccessMsg]         = useState<string | null>(null);
  const [submitError, setSubmitError]       = useState<string | null>(null);

  // Redirect non-doctors to home
  if (user?.user_type !== 'doctor') {
    router.replace('/');
    return null;
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!chiefComplaint.trim()) newErrors.chiefComplaint = 'Chief complaint is required';
    if (!diagnosisText.trim())  newErrors.diagnosisText  = 'Diagnosis description is required';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    if (!patient_id) {
      setSubmitError('Missing patient ID. Please go back and try again.');
      return;
    }

    try {
      setSubmitting(true);
      setSubmitError(null);

      await apiClient.post(API.EHR.PATIENT_VISITS(patient_id), {
        chief_complaint: chiefComplaint.trim(),
        // FIX: send empty string instead of undefined so the backend doesn't
        // reject missing optional field — it now accepts '' for diagnosis_icd10.
        diagnosis_icd10: diagnosisIcd10.trim(),
        diagnosis_text:  diagnosisText.trim(),
        notes:           notes.trim() || undefined,
        visit_date:      visitDate.trim() || todayISO(),
      });

      // FIX: web-compatible success feedback — no Alert.alert.
      // Show an inline green banner then navigate back after 1.5 s.
      const name = patient_name ? ` for ${patient_name}` : '';
      setSuccessMsg(`✅  Visit${name} has been recorded successfully.`);
      setTimeout(() => router.back(), 1500);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save visit';
      setSubmitError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: patient_name ? `Visit – ${patient_name}` : 'New Visit' }} />
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Inline success banner ── */}
          {successMsg && (
            <View style={styles.successBanner}>
              <Text style={styles.successText}>{successMsg}</Text>
            </View>
          )}

          {/* ── Inline error banner ── */}
          {submitError && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorBannerText}>⚠️  {submitError}</Text>
            </View>
          )}

          <Card variant="elevated" padding="large" style={styles.card}>
            <Text style={styles.title}>Record Visit</Text>
            {patient_name ? (
              <Text style={styles.subtitle}>Patient: {patient_name}</Text>
            ) : null}

            <Input
              label="Chief Complaint"
              value={chiefComplaint}
              onChangeText={(v) => {
                setChiefComplaint(v);
                setErrors((prev) => ({ ...prev, chiefComplaint: '' }));
              }}
              placeholder="Primary reason for the visit"
              error={errors.chiefComplaint}
              required
            />

            {/* ICD-10 is optional — no required prop, no validation error */}
            <Input
              label="ICD-10-GM Code (optional)"
              value={diagnosisIcd10}
              onChangeText={setDiagnosisIcd10}
              placeholder="e.g. I10, E11.9"
              autoCapitalize="characters"
            />

            <Input
              label="Diagnosis Description"
              value={diagnosisText}
              onChangeText={(v) => {
                setDiagnosisText(v);
                setErrors((prev) => ({ ...prev, diagnosisText: '' }));
              }}
              placeholder="Describe the diagnosis"
              error={errors.diagnosisText}
              required
            />

            <Input
              label="Visit Date"
              value={visitDate}
              onChangeText={setVisitDate}
              placeholder="YYYY-MM-DD"
              helperText="Format: YYYY-MM-DD"
            />

            <Input
              label="Notes"
              value={notes}
              onChangeText={setNotes}
              placeholder="Additional notes (optional)"
              multiline
              numberOfLines={4}
            />

            <View style={styles.buttonRow}>
              <Button
                title={submitting ? 'Saving…' : 'Save Visit'}
                onPress={handleSubmit}
                loading={submitting}
                disabled={!!successMsg}  // disable after success so user can't double-submit
                fullWidth
              />
            </View>
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

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

  // Success banner
  successBanner: {
    backgroundColor: (colors as any).successLight ?? '#E8F5E9',
    borderRadius: borderRadius.md,
    borderLeftWidth: 4,
    borderLeftColor: (colors as any).success ?? '#2E7D32',
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  successText: {
    ...typography.body,
    color: (colors as any).success ?? '#2E7D32',
    fontWeight: '600',
  },

  // Error banner
  errorBanner: {
    backgroundColor: colors.danger + '12',
    borderRadius: borderRadius.md,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  errorBannerText: {
    ...typography.body,
    color: colors.danger,
  },
});