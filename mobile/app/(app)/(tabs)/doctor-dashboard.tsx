/**
 * Doctor Dashboard Screen
 * Shows patient list and patient data for doctors
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  RefreshControl,
  ScrollView,
  TouchableOpacity,
  FlatList,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import { useAuthStore } from '@/store/auth.store';
import { PatientList, PatientDataView } from '@/components/doctor';
import { getPatients, type DoctorPatient } from '@/services/api/doctor';
import { getMyClinics, type Clinic } from '@/services/api/clinics';

export default function DoctorDashboardScreen() {
  const router = useRouter();
  const { user } = useAuthStore();

  const [patients,         setPatients]         = useState<DoctorPatient[]>([]);
  const [selectedPatient,  setSelectedPatient]  = useState<DoctorPatient | null>(null);
  const [isLoading,        setIsLoading]        = useState(true);
  const [error,            setError]            = useState<string | null>(null);
  const [refreshing,       setRefreshing]       = useState(false);
  const [clinics,          setClinics]          = useState<Clinic[]>([]);

  // ── data loading ───────────────────────────────────────────────────────────

  const loadPatients = useCallback(async () => {
    try {
      setError(null);
      const data = await getPatients();
      setPatients(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load patients';
      setError(message);
      console.error('Error loading patients:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadClinics = useCallback(async () => {
    try {
      const data = await getMyClinics();
      setClinics(data);
    } catch {
      // silently degrade — clinics are informational on the dashboard
    }
  }, []);

  useEffect(() => {
    loadPatients();
    loadClinics();
  }, [loadPatients, loadClinics]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadPatients(), loadClinics()]);
    setRefreshing(false);
  }, [loadPatients, loadClinics]);

  // ── handlers ───────────────────────────────────────────────────────────────

  const handleSelectPatient = (patient: DoctorPatient) => setSelectedPatient(patient);
  const handleBack          = () => setSelectedPatient(null);

  const greeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  };

  // ── patient detail view ────────────────────────────────────────────────────

  if (selectedPatient) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['bottom']}>
        <PatientDataView patient={selectedPatient} onBack={handleBack} />
      </SafeAreaView>
    );
  }

  // ── main dashboard ─────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView
        style={styles.container}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
          />
        }
      >
        {/* ── Welcome ── */}
        <View style={styles.welcomeSection}>
          <Text style={styles.greeting}>{greeting()}</Text>
          <Text style={styles.userName}>Dr. {user?.firstName || 'Doctor'}</Text>
          <Text style={styles.roleTag}>👨‍⚕️ Doctor Dashboard</Text>
        </View>

        {/* ── Clinics strip ── */}
        <View style={styles.clinicsSection}>
          <View style={styles.clinicsHeader}>
            <Text style={styles.clinicsTitle}>🏥  My Clinics</Text>
            <TouchableOpacity
              onPress={() => router.push('/(app)/settings/clinics')}
              style={styles.manageBtn}
            >
              <Text style={styles.manageBtnText}>Manage ›</Text>
            </TouchableOpacity>
          </View>

          {clinics.length === 0 ? (
            /* Empty state — tappable to go straight to clinic creation */
            <TouchableOpacity
              style={styles.clinicsEmpty}
              onPress={() => router.push('/(app)/settings/clinics')}
              activeOpacity={0.75}
            >
              <Text style={styles.clinicsEmptyIcon}>🏥</Text>
              <View style={styles.clinicsEmptyText}>
                <Text style={styles.clinicsEmptyTitle}>No clinics yet</Text>
                <Text style={styles.clinicsEmptySub}>Tap to create or join a clinic</Text>
              </View>
              <Text style={styles.clinicsEmptyArrow}>›</Text>
            </TouchableOpacity>
          ) : (
            <FlatList
              horizontal
              data={clinics}
              keyExtractor={c => c.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.clinicsList}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.clinicChip}
                  onPress={() => router.push('/(app)/settings/clinics')}
                  activeOpacity={0.8}
                >
                  <View style={styles.clinicChipAvatar}>
                    <Text style={styles.clinicChipAvatarText}>
                      {item.name.charAt(0).toUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.clinicChipBody}>
                    <Text style={styles.clinicChipName} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={styles.clinicChipCount}>
                      {item.doctor_count} doctor{item.doctor_count !== 1 ? 's' : ''}
                    </Text>
                  </View>
                  {item.created_by === user?.id && (
                    <View style={styles.ownerDot} />
                  )}
                </TouchableOpacity>
              )}
            />
          )}
        </View>

        {/* ── Error ── */}
        {error && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>⚠️ {error}</Text>
          </View>
        )}

        {/* ── Patient list ── */}
        <View style={styles.patientListContainer}>
          <PatientList
            patients={patients}
            selectedPatient={selectedPatient}
            onSelectPatient={handleSelectPatient}
            isLoading={isLoading}
          />
        </View>
      </ScrollView>
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

  // Welcome
  welcomeSection: {
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  greeting: {
    ...typography.body,
    color: colors.text.secondary,
  },
  userName: {
    ...typography.h1,
    color: colors.text.primary,
  },
  roleTag: {
    ...typography.caption,
    color: colors.primary,
    marginTop: spacing.xs,
  },

  // Clinics section
  clinicsSection: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  clinicsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  clinicsTitle: {
    ...typography.body,
    fontWeight: '700',
    color: colors.text.primary,
  },
  manageBtn: {
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.primary + '15',
    borderRadius: borderRadius.sm,
  },
  manageBtnText: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: '600',
  },

  // Empty state
  clinicsEmpty: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.md,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  clinicsEmptyIcon: {
    fontSize: 28,
    marginRight: spacing.sm,
  },
  clinicsEmptyText: {
    flex: 1,
  },
  clinicsEmptyTitle: {
    ...typography.body,
    fontWeight: '600',
    color: colors.text.primary,
  },
  clinicsEmptySub: {
    ...typography.small,
    color: colors.text.secondary,
  },
  clinicsEmptyArrow: {
    fontSize: 22,
    color: colors.text.secondary,
  },

  // Clinic chips
  clinicsList: {
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  clinicChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    maxWidth: 200,
  },
  clinicChipAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  clinicChipAvatarText: {
    ...typography.body,
    color: colors.text.inverse,
    fontWeight: '700',
  },
  clinicChipBody: {
    flex: 1,
  },
  clinicChipName: {
    ...typography.small,
    fontWeight: '600',
    color: colors.text.primary,
  },
  clinicChipCount: {
    ...typography.caption,
    color: colors.text.secondary,
  },
  // Small dot to indicate "you created this"
  ownerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
    marginLeft: spacing.xs,
    alignSelf: 'flex-start',
    marginTop: 4,
  },

  // Error
  errorContainer: {
    margin: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.danger + '10',
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorText: {
    ...typography.body,
    color: colors.danger,
  },

  // Patient list
  patientListContainer: {
    flex: 1,
    minHeight: 400,
  },
});