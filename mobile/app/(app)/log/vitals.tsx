import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Input } from '@/components/ui';
import apiClient from '@/services/api/client';
import API from '@/services/api/endpoints';
import { E, ET } from '@/constants/elderlyTheme';
import { queueVital, getPendingVitals, deletePendingVital } from '@/services/offline/db';
import { submitVital } from '@/services/api/ehr';

function getBPCategory(sys: number, dia: number) {
  if (sys >= 180 || dia >= 120)
    return { label: '⚠️ Crisis — Contact Doctor Now', bg: E.colors.dangerLight, fg: E.colors.danger };
  if (sys >= 130 || dia > 80)
    return { label: '🔴 High Blood Pressure', bg: E.colors.dangerLight, fg: E.colors.danger };
  if (sys >= 120)
    return { label: '🟠 Elevated', bg: E.colors.warningLight, fg: E.colors.warning };
  return { label: '🟢 Normal', bg: E.colors.successLight, fg: E.colors.success };
}

export default function VitalsScreen() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<'idle' | 'success' | 'urgent' | 'error' | 'queued'>('idle');
  const [submitMessage, setSubmitMessage] = useState('');

  const [systolic, setSystolic]   = useState('');
  const [diastolic, setDiastolic] = useState('');
  const [pulse, setPulse]         = useState('');
  const [weight, setWeight]       = useState('');
  const [notes, setNotes]         = useState('');
  const [errors, setErrors]       = useState<Record<string, string>>({});

  const sys = parseInt(systolic);
  const dia = parseInt(diastolic);
  const showCategory = !isNaN(sys) && !isNaN(dia) && sys > 0 && dia > 0;
  const category = showCategory ? getBPCategory(sys, dia) : null;

  const validate = () => {
    const e: Record<string, string> = {};
    if (!systolic)  e.systolic  = 'Required';
    if (!diastolic) e.diastolic = 'Required';
    if (!pulse)     e.pulse     = 'Required';
    if (systolic  && (sys  < 60  || sys  > 300)) e.systolic  = 'Enter a valid value (60–300)';
    if (diastolic && (dia  < 40  || dia  > 200)) e.diastolic = 'Enter a valid value (40–200)';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const syncPendingVitals = async () => {
    const pending = getPendingVitals();
    for (const pv of pending) {
      try {
        await submitVital({
          systolic: pv.systolic,
          diastolic: pv.diastolic,
          pulse: pv.pulse,
          weight_kg: pv.weight_kg ?? undefined,
          notes: pv.notes ?? undefined,
        });
        deletePendingVital(pv.local_id);
      } catch (syncErr: unknown) {
        // Leave in queue to retry later; log for debugging
        console.warn('[vitals] Failed to sync pending vital:', pv.local_id, syncErr);
      }
    }
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setIsLoading(true);
    setSubmitStatus('idle');
    try {
      // Attempt to sync any previously queued vitals first
      await syncPendingVitals();

      const response = await apiClient.post(API.EHR.VITALS, {
        systolic:  sys,
        diastolic: dia,
        pulse:     parseInt(pulse),
        weight_kg: weight ? parseFloat(weight) : undefined,
        notes:     notes || undefined,
      });

      if (response?.data?.urgent) {
        setSubmitStatus('urgent');
        setSubmitMessage('⚠️ Critical reading — please contact your doctor');
      } else {
        setSubmitStatus('success');
        setSubmitMessage('✅ Reading saved successfully');
        // Navigate back after a short delay so the user sees the confirmation
        setTimeout(() => router.back(), 1500);
      }
    } catch (err: any) {
      // Network failure — save locally and notify user
      try {
        queueVital({
          systolic: sys,
          diastolic: dia,
          pulse: parseInt(pulse),
          weight_kg: weight ? parseFloat(weight) : undefined,
          notes: notes || undefined,
        });
        setSubmitStatus('queued');
        setSubmitMessage('📥 Saved locally — will sync when online');
      } catch {
        setSubmitStatus('error');
        setSubmitMessage(err?.message || 'Failed to save reading.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Record Blood Pressure' }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

          {/* ── INSTRUCTION CARD ── */}
          <View style={styles.instructionCard}>
            <Text style={styles.sectionTitle}>📋 Before you measure:</Text>
            {[
              { icon: '🪑', text: 'Sit quietly for 5 minutes' },
              { icon: '💪', text: 'Place the cuff on your left arm' },
              { icon: '🤫', text: 'Do not talk while measuring' },
            ].map((step) => (
              <View key={step.text} style={styles.prepStep}>
                <Text style={styles.prepStepIcon}>{step.icon}</Text>
                <Text style={styles.prepStepText}>{step.text}</Text>
              </View>
            ))}
          </View>

          {/* ── BP INPUTS CARD ── */}
          <View style={styles.card}>
            <View style={styles.bpInputRow}>
              <View style={styles.bpInputCol}>
                <Text style={styles.inputLabel}>Systolic</Text>
                <Input
                  value={systolic}
                  onChangeText={(v) => { setSystolic(v); setErrors(p => ({...p, systolic: ''})); }}
                  keyboardType="number-pad"
                  placeholder="120"
                  error={errors.systolic}
                  containerStyle={styles.inputContainer}
                  inputStyle={styles.bigInputText}
                />
              </View>
              <View style={styles.bpSlash}>
                <Text style={styles.bpSlashText}>/</Text>
              </View>
              <View style={styles.bpInputCol}>
                <Text style={styles.inputLabel}>Diastolic</Text>
                <Input
                  value={diastolic}
                  onChangeText={(v) => { setDiastolic(v); setErrors(p => ({...p, diastolic: ''})); }}
                  keyboardType="number-pad"
                  placeholder="80"
                  error={errors.diastolic}
                  containerStyle={styles.inputContainer}
                  inputStyle={styles.bigInputText}
                />
              </View>
            </View>

            {/* Live BP status badge */}
            {category && (
              <View style={[styles.liveBadge, { backgroundColor: category.bg }]}>
                <Text style={[styles.liveBadgeText, { color: category.fg }]}>{category.label}</Text>
              </View>
            )}
          </View>

          {/* ── OTHER MEASUREMENTS CARD ── */}
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Other Measurements</Text>

            <Text style={styles.inputLabel}>Pulse (Heart Rate)</Text>
            <Input
              value={pulse}
              onChangeText={(v) => { setPulse(v); setErrors(p => ({...p, pulse: ''})); }}
              keyboardType="number-pad"
              placeholder="72"
              error={errors.pulse}
              containerStyle={styles.medInputContainer}
            />

            <Text style={styles.inputLabel}>Weight (kg) — optional</Text>
            <Input
              value={weight}
              onChangeText={setWeight}
              keyboardType="decimal-pad"
              placeholder="70.5"
              containerStyle={styles.medInputContainer}
            />

            <Text style={styles.inputLabel}>Notes — optional</Text>
            <Input
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={3}
              placeholder="How are you feeling?"
              containerStyle={styles.notesContainer}
            />
          </View>

          {/* ── STATUS BANNER ── */}
          {submitStatus !== 'idle' && (() => {
            const bannerStyles: Record<string, { bg: string; text: string }> = {
              success: { bg: E.colors.successLight, text: E.colors.success },
              urgent:  { bg: E.colors.dangerLight,  text: E.colors.danger  },
              queued:  { bg: E.colors.warningLight,  text: E.colors.warning },
              error:   { bg: E.colors.dangerLight,   text: E.colors.danger  },
            };
            const bs = bannerStyles[submitStatus] ?? bannerStyles.error;
            return (
              <View style={[styles.statusBanner, { backgroundColor: bs.bg }]}>
                <Text style={[styles.statusBannerText, { color: bs.text }]}>{submitMessage}</Text>
              </View>
            );
          })()}

          {/* ── SAVE BUTTON ── */}
          <TouchableOpacity
            style={[styles.saveButton, isLoading && styles.saveButtonDisabled]}
            onPress={handleSubmit}
            disabled={isLoading}
          >
            <Text style={styles.saveButtonText}>{isLoading ? 'Saving…' : '✅  Save Reading'}</Text>
          </TouchableOpacity>

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: E.colors.bg },
  content: { paddingBottom: 32 },
  // Instruction card
  instructionCard: {
    backgroundColor: E.colors.surfaceAlt,
    borderRadius: E.radius,
    padding: E.pad,
    margin: 16,
    marginBottom: 0,
    ...E.shadowSm,
  },
  sectionTitle: {
    ...ET.h3,
    marginBottom: 10,
  },
  // Prep steps
  prepStep: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  prepStepIcon: {
    fontSize: 20,
    marginRight: E.padSm,
    width: 28,
    textAlign: 'center',
  },
  prepStepText: {
    ...ET.body,
    flex: 1,
  },
  // Cards
  card: {
    backgroundColor: E.colors.surface,
    borderRadius: E.radius,
    margin: 16,
    marginBottom: 0,
    padding: E.pad,
    ...E.shadow,
  },
  // BP input row (side-by-side)
  bpInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 4,
  },
  bpInputCol: {
    flex: 1,
  },
  bpSlash: {
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 20,
    paddingTop: 24,
  },
  bpSlashText: {
    fontSize: 40,
    color: E.colors.textSecondary,
    fontWeight: '300',
  },
  // Input labels
  inputLabel: {
    ...ET.label,
    marginBottom: 6,
  },
  // Input containers with large height
  inputContainer: {
    marginBottom: 16,
    minHeight: 72,
  },
  bigInputText: {
    fontSize: 28,
    minHeight: 72,
  },
  medInputContainer: {
    marginBottom: 16,
    minHeight: 64,
  },
  notesContainer: {
    marginBottom: 4,
    minHeight: 100,
  },
  // Live badge — row with icon and text
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
    borderRadius: E.radius,
    paddingHorizontal: E.padSm,
    paddingVertical: E.padXs,
    marginTop: 4,
  },
  liveBadgeText: {
    ...ET.bodyBold,
  },
  // Status banner
  statusBanner: {
    height: 64,
    borderRadius: E.radius,
    alignItems: 'center',
    justifyContent: 'center',
    margin: 16,
    marginBottom: 0,
  },
  statusBannerText: {
    ...ET.bodyBold,
    textAlign: 'center',
  },
  // Save button
  saveButton: {
    height: E.tapXL,
    backgroundColor: E.colors.primary,
    borderRadius: E.radius,
    alignItems: 'center',
    justifyContent: 'center',
    margin: 16,
    ...E.shadow,
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
  saveButtonText: {
    ...ET.btnPrimary,
  },
});