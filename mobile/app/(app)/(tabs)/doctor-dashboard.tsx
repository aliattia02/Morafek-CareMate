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
import { E, ET } from '@/constants/elderlyTheme';
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
            colors={[E.colors.primary]}
          />
        }
      >
        {/* ── Welcome ── */}
        <View style={styles.welcomeSection}>
          <View style={styles.welcomeRow}>
            <View style={styles.welcomeAvatar}>
              <Text style={styles.welcomeAvatarText}>
                {(user?.firstName?.[0] ?? 'D').toUpperCase()}
              </Text>
            </View>
            <View style={styles.welcomeText}>
              <Text style={styles.greeting}>{greeting()}</Text>
              <Text style={styles.userName}>Dr. {user?.firstName || 'Doctor'}</Text>
              <Text style={styles.roleTag}>👨‍⚕️ Doctor Dashboard</Text>
            </View>
          </View>
          {/* Stats row — floats out of teal header */}
          <View style={styles.statsRow}>
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{patients.length}</Text>
              <Text style={styles.statLabel}>Patients</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{clinics.length}</Text>
              <Text style={styles.statLabel}>Clinics</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statValue}>0</Text>
              <Text style={styles.statLabel}>Updates</Text>
            </View>
          </View>
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
                    <View style={styles.ownerBadge}>
                      <Text style={styles.ownerBadgeText}>Owner</Text>
                    </View>
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
        <View style={styles.patientListSection}>
          <View style={styles.patientListHeader}>
            <Text style={styles.patientListTitle}>👥 My Patients</Text>
          </View>
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
    backgroundColor: E.colors.bg,
  },
  container: {
    flex: 1,
  },

  // Welcome — teal header
  welcomeSection: {
    backgroundColor: E.colors.primary,
    paddingTop: E.pad,
    paddingHorizontal: E.pad,
    paddingBottom: 56, // extra space for statsRow overflow
  },
  welcomeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: E.padSm,
  },
  welcomeAvatar: {
    width: 56,
    height: 56,
    borderRadius: E.radiusFull,
    backgroundColor: E.colors.textInverse,
    alignItems: 'center',
    justifyContent: 'center',
  },
  welcomeAvatarText: {
    ...ET.h2,
    color: E.colors.primary,
    fontWeight: '700',
  },
  welcomeText: {
    flex: 1,
  },
  greeting: {
    ...ET.body,
    color: E.colors.primaryLight,
  },
  userName: {
    ...ET.h1,
    color: E.colors.textInverse,
  },
  roleTag: {
    ...ET.small,
    color: E.colors.primaryLight,
    marginTop: 2,
  },

  // Stats row — white pill floating below teal header
  statsRow: {
    flexDirection: 'row',
    backgroundColor: E.colors.surface,
    borderRadius: E.radius,
    marginTop: E.padSm,
    paddingVertical: E.padSm,
    ...E.shadow,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    ...ET.h2,
    color: E.colors.primary,
  },
  statLabel: {
    ...ET.caption,
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    height: 32,
    backgroundColor: E.colors.border,
    alignSelf: 'center',
  },

  // Clinics section
  clinicsSection: {
    backgroundColor: E.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: E.colors.border,
    paddingTop: E.pad,
    paddingBottom: E.padSm,
  },
  clinicsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: E.pad,
    marginBottom: E.padSm,
  },
  clinicsTitle: {
    ...ET.bodyBold,
  },
  manageBtn: {
    paddingVertical: 4,
    paddingHorizontal: E.padSm,
    backgroundColor: E.colors.primaryLight,
    borderRadius: E.radiusSm,
  },
  manageBtnText: {
    ...ET.caption,
    color: E.colors.primary,
    fontWeight: '600',
  },

  // Empty state
  clinicsEmpty: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: E.pad,
    padding: E.pad,
    borderRadius: E.radius,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: E.colors.border,
    backgroundColor: E.colors.bg,
  },
  clinicsEmptyIcon: {
    fontSize: 28,
    marginRight: E.padSm,
  },
  clinicsEmptyText: {
    flex: 1,
  },
  clinicsEmptyTitle: {
    ...ET.bodyBold,
  },
  clinicsEmptySub: {
    ...ET.small,
  },
  clinicsEmptyArrow: {
    fontSize: 22,
    color: E.colors.textSecondary,
  },

  // Clinic chips
  clinicsList: {
    paddingHorizontal: E.pad,
    gap: E.padSm,
  },
  clinicChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: E.colors.bg,
    borderWidth: 1,
    borderColor: E.colors.border,
    borderRadius: E.radius,
    paddingVertical: E.padSm,
    paddingHorizontal: E.padSm,
    maxWidth: 200,
  },
  clinicChipAvatar: {
    width: 36,
    height: 36,
    borderRadius: E.radiusFull,
    backgroundColor: E.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: E.padSm,
  },
  clinicChipAvatarText: {
    ...ET.bodyBold,
    color: E.colors.textInverse,
  },
  clinicChipBody: {
    flex: 1,
  },
  clinicChipName: {
    ...ET.small,
    fontWeight: '600',
    color: E.colors.textPrimary,
  },
  clinicChipCount: {
    ...ET.caption,
  },
  // Owner badge pill
  ownerBadge: {
    backgroundColor: E.colors.primaryLight,
    borderRadius: E.radiusFull,
    paddingHorizontal: E.padXs,
    paddingVertical: 2,
    marginLeft: E.padXs,
  },
  ownerBadgeText: {
    ...ET.caption,
    color: E.colors.primary,
    fontWeight: '600',
  },

  // Error
  errorContainer: {
    margin: E.pad,
    padding: E.pad,
    backgroundColor: E.colors.dangerLight,
    borderRadius: E.radiusSm,
    borderLeftWidth: 4,
    borderLeftColor: E.colors.danger,
  },
  errorText: {
    ...ET.body,
    color: E.colors.danger,
  },

  // Patient list section card
  patientListSection: {
    backgroundColor: E.colors.surface,
    borderRadius: E.radius,
    margin: E.pad,
    overflow: 'hidden',
    ...E.shadow,
  },
  patientListHeader: {
    paddingHorizontal: E.pad,
    paddingVertical: E.padSm,
    borderBottomWidth: 1,
    borderBottomColor: E.colors.divider,
  },
  patientListTitle: {
    ...ET.h3,
  },
});