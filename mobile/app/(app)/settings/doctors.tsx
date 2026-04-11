/**
 * Doctor Management Screen
 * Location: mobile/app/(app)/settings/doctors.tsx
 *
 * Flow:
 *   1. Patient sees a clinic picker (horizontal pill strip) — "All" is always
 *      the first option.
 *   2. Selecting a clinic filters the doctor list shown below.
 *   3. Authorization/revocation logic is unchanged (doctor-level, not clinic-scoped).
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Platform,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DoctorList } from '@/components/doctor/DoctorList';
import { Card, Loading } from '@/components/ui';
import {
  getAllDoctors,
  getAuthorizedDoctors,
  authorizeDoctor,
  revokeDoctor,
  type Doctor,
  type AuthorizedDoctor,
} from '@/services/api/doctor-management';
import { getClinics, type Clinic } from '@/services/api/clinics';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// ─────────────────────────────────────────────────────────────────────────────
// Cross-platform confirm helper
// ─────────────────────────────────────────────────────────────────────────────

const showAlert = (
  title: string,
  message: string,
  buttons: { text: string; style?: 'cancel' | 'destructive' | 'default'; onPress?: () => void }[]
) => {
  if (Platform.OS === 'web') {
    const confirmed = window.confirm(`${title}\n\n${message}`);
    if (confirmed) {
      const confirmButton = buttons.find(b => b.style !== 'cancel');
      confirmButton?.onPress?.();
    }
  } else {
    Alert.alert(title, message, buttons);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Clinic pill strip
// ─────────────────────────────────────────────────────────────────────────────

const ALL_CLINICS_ID = '__all__';

interface ClinicStripProps {
  clinics: Clinic[];
  selectedId: string;
  onSelect: (id: string) => void;
  isLoading: boolean;
}

function ClinicStrip({ clinics, selectedId, onSelect, isLoading }: ClinicStripProps) {
  const items = [{ id: ALL_CLINICS_ID, name: '🏥  All Clinics' }, ...clinics];

  return (
    <View style={stripStyles.wrapper}>
      <Text style={stripStyles.label}>Filter by clinic</Text>
      {isLoading ? (
        <ActivityIndicator color={colors.primary} style={{ marginVertical: spacing.sm }} />
      ) : (
        <FlatList
          horizontal
          data={items}
          keyExtractor={item => item.id}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={stripStyles.list}
          renderItem={({ item }) => {
            const active = item.id === selectedId;
            return (
              <TouchableOpacity
                style={[stripStyles.pill, active && stripStyles.pillActive]}
                onPress={() => onSelect(item.id)}
                activeOpacity={0.75}
              >
                <Text style={[stripStyles.pillText, active && stripStyles.pillTextActive]}>
                  {item.name}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      )}
    </View>
  );
}

const stripStyles = StyleSheet.create({
  wrapper: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  label: {
    ...typography.caption,
    color: colors.text.secondary,
    marginBottom: spacing.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  list: {
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  pill: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.full,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pillActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  pillText: {
    ...typography.small,
    color: colors.text.secondary,
    fontWeight: '500',
  },
  pillTextActive: {
    color: colors.text.inverse,
    fontWeight: '600',
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Main screen
// ─────────────────────────────────────────────────────────────────────────────

export default function DoctorManagementScreen() {
  const [allDoctors,        setAllDoctors]        = useState<Doctor[]>([]);
  const [authorizedDoctors, setAuthorizedDoctors] = useState<AuthorizedDoctor[]>([]);
  const [clinics,           setClinics]           = useState<Clinic[]>([]);
  const [selectedClinicId,  setSelectedClinicId]  = useState<string>(ALL_CLINICS_ID);

  const [isLoading,        setIsLoading]        = useState(true);
  const [clinicsLoading,   setClinicsLoading]   = useState(true);
  const [isProcessing,     setIsProcessing]     = useState(false);
  const [error,            setError]            = useState<string | null>(null);

  // ── data fetching ──────────────────────────────────────────────────────────

  const loadDoctors = useCallback(async (clinicId: string) => {
    try {
      setIsLoading(true);
      setError(null);

      const [available, authorized] = await Promise.all([
        // Pass clinic_id when a specific clinic is selected
        getAllDoctors(clinicId !== ALL_CLINICS_ID ? clinicId : undefined),
        getAuthorizedDoctors(),
      ]);

      setAllDoctors(available);
      setAuthorizedDoctors(authorized);
    } catch (err: any) {
      setError(err.message || 'Failed to load doctors');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadClinics = useCallback(async () => {
    try {
      setClinicsLoading(true);
      const data = await getClinics();
      setClinics(data);
    } catch {
      // Clinics are optional — silently degrade if unavailable
    } finally {
      setClinicsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadClinics();
  }, [loadClinics]);

  // Reload doctors whenever the selected clinic changes
  useEffect(() => {
    loadDoctors(selectedClinicId);
  }, [selectedClinicId, loadDoctors]);

  // ── authorize / revoke ────────────────────────────────────────────────────

  const handleAuthorize = (doctorId: string) => {
    const doctor = allDoctors.find(d => d.id === doctorId);
    if (!doctor) return;

    showAlert(
      'Authorize Doctor',
      `Allow Dr. ${doctor.firstName} ${doctor.lastName} to view your health data?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Authorize',
          style: 'default',
          onPress: async () => {
            try {
              setIsProcessing(true);
              await authorizeDoctor(doctorId);
              await loadDoctors(selectedClinicId);
              showAlert('Success', 'Doctor authorized successfully', [{ text: 'OK' }]);
            } catch (err: any) {
              showAlert('Error', err.message || 'Failed to authorize doctor', [{ text: 'OK' }]);
            } finally {
              setIsProcessing(false);
            }
          },
        },
      ]
    );
  };

  const handleRevoke = (doctorId: string) => {
    const doctor = authorizedDoctors.find(d => d.id === doctorId);
    if (!doctor) return;

    showAlert(
      'Revoke Access',
      `Remove Dr. ${doctor.firstName} ${doctor.lastName}'s access to your health data?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke',
          style: 'destructive',
          onPress: async () => {
            try {
              setIsProcessing(true);
              await revokeDoctor(doctorId);
              await loadDoctors(selectedClinicId);
              showAlert('Success', 'Doctor access revoked', [{ text: 'OK' }]);
            } catch (err: any) {
              showAlert('Error', err.message || 'Failed to revoke access', [{ text: 'OK' }]);
            } finally {
              setIsProcessing(false);
            }
          },
        },
      ]
    );
  };

  // ── selected clinic label for section title ────────────────────────────────

  const clinicLabel =
    selectedClinicId === ALL_CLINICS_ID
      ? null
      : clinics.find(c => c.id === selectedClinicId)?.name ?? null;

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Manage Doctors', headerShown: true }} />

      {/* Clinic picker lives outside the scroll so it stays sticky */}
      <ClinicStrip
        clinics={clinics}
        selectedId={selectedClinicId}
        onSelect={setSelectedClinicId}
        isLoading={clinicsLoading}
      />

      {isLoading ? (
        <Loading text="Loading doctors..." />
      ) : (
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>

          {/* Info card */}
          <Card variant="filled" padding="medium" style={styles.infoCard}>
            <Text style={styles.infoTitle}>🏥 Doctor Authorization</Text>
            <Text style={styles.infoText}>
              {clinicLabel
                ? `Showing doctors from ${clinicLabel}. `
                : 'Showing all available doctors. '}
              Select a clinic above to narrow the list. Only doctors you authorize
              can view your health data.
            </Text>
          </Card>

          {/* Error */}
          {error && (
            <Card variant="outlined" padding="medium" style={styles.errorCard}>
              <Text style={styles.errorText}>⚠️ {error}</Text>
            </Card>
          )}

          {/* Stats */}
          <Card variant="outlined" padding="medium" style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <View>
                <Text style={styles.summaryLabel}>Authorized Doctors</Text>
                <Text style={styles.summaryValue}>{authorizedDoctors.length}</Text>
              </View>
              <View>
                <Text style={styles.summaryLabel}>
                  {clinicLabel ? `In ${clinicLabel}` : 'Available Doctors'}
                </Text>
                <Text style={styles.summaryValue}>{allDoctors.length}</Text>
              </View>
            </View>
          </Card>

          {/* Authorized doctors */}
          {authorizedDoctors.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Your Authorized Doctors</Text>
              <Text style={styles.sectionSubtitle}>
                These doctors can currently view your health data
              </Text>
              <DoctorList
                doctors={authorizedDoctors}
                authorizedDoctorIds={authorizedDoctors.map(d => d.id)}
                onAuthorize={handleAuthorize}
                onRevoke={handleRevoke}
                isLoading={isProcessing}
              />
            </View>
          )}

          {/* Available / filtered doctors */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              {clinicLabel
                ? `Doctors at ${clinicLabel}`
                : authorizedDoctors.length > 0
                  ? 'Add More Doctors'
                  : 'Available Doctors'}
            </Text>
            <Text style={styles.sectionSubtitle}>
              {clinicLabel
                ? 'Browse doctors from this clinic and authorize the ones you trust'
                : 'Search and authorize doctors to view your data'}
            </Text>
            <DoctorList
              doctors={allDoctors.filter(
                d => !authorizedDoctors.find(ad => ad.id === d.id)
              )}
              authorizedDoctorIds={[]}
              onAuthorize={handleAuthorize}
              onRevoke={handleRevoke}
              isLoading={isProcessing}
            />
          </View>

          {/* Privacy notice */}
          <Card variant="filled" padding="small" style={styles.privacyCard}>
            <Text style={styles.privacyText}>
              🔒 Your privacy is protected. You can revoke access at any time.
            </Text>
          </Card>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
  },
  content: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  infoCard: {
    marginBottom: spacing.md,
  },
  infoTitle: {
    ...typography.body,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  infoText: {
    ...typography.small,
    color: colors.text.secondary,
    lineHeight: 20,
  },
  errorCard: {
    marginBottom: spacing.md,
    borderColor: colors.danger,
  },
  errorText: {
    ...typography.small,
    color: colors.danger,
  },
  summaryCard: {
    marginBottom: spacing.lg,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  summaryLabel: {
    ...typography.small,
    color: colors.text.secondary,
    marginBottom: spacing.xs,
    textAlign: 'center',
  },
  summaryValue: {
    ...typography.h2,
    color: colors.primary,
    textAlign: 'center',
  },
  section: {
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    ...typography.h3,
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  sectionSubtitle: {
    ...typography.small,
    color: colors.text.secondary,
    marginBottom: spacing.md,
  },
  privacyCard: {
    marginTop: spacing.md,
  },
  privacyText: {
    ...typography.small,
    color: colors.text.secondary,
    textAlign: 'center',
  },
});