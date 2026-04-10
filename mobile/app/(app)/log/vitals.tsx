import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card, Input, Button } from '@/components/ui';
import apiClient from '@/services/api/client';
import API from '@/services/api/endpoints';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import { queueVital, getPendingVitals, deletePendingVital } from '@/services/offline/db';
import { submitVital } from '@/services/api/ehr';

function getBPCategory(sys: number, dia: number) {
  if (sys >= 180 || dia >= 120)
    return { label: '⚠️ Crisis — seek help immediately', color: colors.danger };
  if (sys >= 130 || dia > 80)
    return { label: '🔴 High Blood Pressure', color: colors.danger };
  if (sys >= 120)
    return { label: '🟠 Elevated', color: colors.warning };
  return { label: '🟢 Normal', color: colors.success };
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
      } catch {
        // Leave in queue to retry later
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
        setSubmitMessage('⚠️ Blood pressure is critically high. Please contact your doctor immediately.');
      } else {
        setSubmitStatus('success');
        setSubmitMessage('✅ Reading saved successfully.');
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
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

          <Card variant="outlined" padding="medium" style={styles.card}>
            <Text style={styles.sectionTitle}>Blood Pressure</Text>

            <View style={styles.row}>
              <View style={styles.half}>
                <Input
                  label="Systolic"
                  value={systolic}
                  onChangeText={(v) => { setSystolic(v); setErrors(p => ({...p, systolic: ''})); }}
                  keyboardType="numeric"
                  placeholder="120"
                  error={errors.systolic}
                  style={styles.bigInput}
                />
              </View>
              <View style={styles.halfLast}>
                <Input
                  label="Diastolic"
                  value={diastolic}
                  onChangeText={(v) => { setDiastolic(v); setErrors(p => ({...p, diastolic: ''})); }}
                  keyboardType="numeric"
                  placeholder="80"
                  error={errors.diastolic}
                  style={styles.bigInput}
                />
              </View>
            </View>

            {category && (
              <View style={[styles.badge, { borderColor: category.color }]}>
                <Text style={[styles.badgeText, { color: category.color }]}>
                  {category.label}
                </Text>
              </View>
            )}
          </Card>

          <Card variant="outlined" padding="medium" style={styles.card}>
            <Text style={styles.sectionTitle}>Other Measurements</Text>
            <Input
              label="Pulse (bpm)"
              value={pulse}
              onChangeText={(v) => { setPulse(v); setErrors(p => ({...p, pulse: ''})); }}
              keyboardType="numeric"
              placeholder="72"
              error={errors.pulse}
            />
            <Input
              label="Weight (kg) — optional"
              value={weight}
              onChangeText={setWeight}
              keyboardType="decimal-pad"
              placeholder="70.5"
            />
            <Input
              label="Notes — optional"
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={3}
              placeholder="How are you feeling?"
            />
          </Card>

          {submitStatus !== 'idle' ? (
            <View style={[
              styles.statusBanner,
              submitStatus === 'success' ? styles.statusSuccess : null,
              submitStatus === 'urgent'  ? styles.statusUrgent  : null,
              submitStatus === 'error'   ? styles.statusError   : null,
              submitStatus === 'queued'  ? styles.statusQueued  : null,
            ]}>
              <Text style={styles.statusText}>{submitMessage}</Text>
            </View>
          ) : null}

          <Button title="Save Reading" onPress={handleSubmit} loading={isLoading} fullWidth />

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:         { flex: 1, backgroundColor: colors.background },
  content:      { padding: spacing.md, paddingBottom: spacing.xl },
  card:         { marginBottom: spacing.md },
  sectionTitle: { ...typography.h3, color: colors.text.primary, marginBottom: spacing.md },
  row:          { flexDirection: 'row' },
  half:         { flex: 1, marginRight: spacing.md },
  halfLast:     { flex: 1 },
  bigInput:     { minHeight: 56 },
  badge: {
    borderWidth: 1,
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    marginTop: spacing.sm,
    alignItems: 'center',
  },
  badgeText: { ...typography.body, fontWeight: '600' },
  statusBanner: {
    borderRadius: borderRadius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    alignItems: 'center',
  },
  statusSuccess: { backgroundColor: colors.success + '20' },
  statusUrgent:  { backgroundColor: colors.danger  + '20' },
  statusError:   { backgroundColor: colors.danger  + '15' },
  statusQueued:  { backgroundColor: colors.warning + '20' },
  statusText:    { ...typography.body, fontWeight: '600', textAlign: 'center' },
});