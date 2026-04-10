/**
 * Patient Home Screen
 * Location: mobile/app/(app)/(tabs)/index.tsx
 *
 * Patients only — doctors are redirected to doctor-dashboard.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuthStore } from '@/store/auth.store';
import { Card } from '@/components/ui';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import { getMyVitals, getMyVisits, type VitalResponse, type VisitResponse } from '@/services/api/ehr';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function PatientHomeScreen() {
  const router = useRouter();
  const { user } = useAuthStore();

  const [vital, setVital] = useState<VitalResponse | null>(null);
  const [visit, setVisit] = useState<VisitResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Redirect doctors immediately
  useEffect(() => {
    if (user?.user_type === 'doctor' || user?.user_type === 'admin') {
      router.replace('/(app)/(tabs)/doctor-dashboard');
    }
  }, [user?.user_type]);

  if (user?.user_type === 'doctor' || user?.user_type === 'admin') {
    return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  }

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [vitals, visits] = await Promise.all([getMyVitals(1), getMyVisits()]);
      setVital(vitals[0] ?? null);
      setVisit(visits[0] ?? null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load data';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
          />
        }
      >
        {/* Welcome Section */}
        <View style={styles.welcomeSection}>
          <Text style={styles.greetingText}>{greeting()}</Text>
          <Text style={styles.userName}>{user?.firstName || 'Patient'}</Text>
        </View>

        {/* Error */}
        {error && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>⚠️ {error}</Text>
          </View>
        )}

        {/* Last Vital Card */}
        <Card variant="outlined" padding="medium" style={styles.card}>
          <Text style={styles.cardTitle}>💓 Last Blood Pressure Reading</Text>
          {loading ? (
            <ActivityIndicator color={colors.primary} style={styles.loader} />
          ) : vital ? (
            <>
              <View style={styles.vitalRow}>
                <Text style={styles.vitalValue}>
                  {vital.systolic}/{vital.diastolic}
                  <Text style={styles.vitalUnit}> mmHg</Text>
                </Text>
                <Text style={styles.vitalValue}>
                  {vital.pulse}
                  <Text style={styles.vitalUnit}> bpm</Text>
                </Text>
                {vital.urgent && (
                  <View style={styles.crisisBadge}>
                    <Text style={styles.crisisBadgeText}>⚠️ Crisis</Text>
                  </View>
                )}
              </View>
              <Text style={styles.vitalTimestamp}>{vital.timestamp}</Text>
            </>
          ) : (
            <Text style={styles.emptyText}>No readings yet.</Text>
          )}
          <TouchableOpacity
            style={styles.button}
            onPress={() => router.push('/(app)/log/vitals')}
          >
            <Text style={styles.buttonText}>+ Add Reading</Text>
          </TouchableOpacity>
        </Card>

        {/* Last Visit Card */}
        <Card variant="outlined" padding="medium" style={styles.card}>
          <Text style={styles.cardTitle}>🏥 Last Visit</Text>
          {loading ? (
            <ActivityIndicator color={colors.primary} style={styles.loader} />
          ) : visit ? (
            <>
              <Text style={styles.visitDate}>{visit.visit_date}</Text>
              {visit.diagnosis_text ? (
                <Text style={styles.visitDiagnosis}>{visit.diagnosis_text}</Text>
              ) : null}
            </>
          ) : (
            <Text style={styles.emptyText}>No visits recorded.</Text>
          )}
        </Card>

        {/* Quick Actions */}
        <View style={styles.quickActions}>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => router.push('/(app)/ehr/visits')}
          >
            <Text style={styles.actionButtonText}>📋 My Visits</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => router.push('/(app)/ehr/messages')}
          >
            <Text style={styles.actionButtonText}>💬 Messages</Text>
          </TouchableOpacity>
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
  content: {
    paddingBottom: spacing.xl,
  },
  welcomeSection: {
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  greetingText: {
    ...typography.body,
    color: colors.text.secondary,
  },
  userName: {
    ...typography.h1,
    color: colors.text.primary,
  },
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
  card: {
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  cardTitle: {
    ...typography.h3,
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  loader: {
    marginVertical: spacing.sm,
  },
  vitalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginBottom: spacing.xs,
  },
  vitalValue: {
    ...typography.h2,
    color: colors.text.primary,
  },
  vitalUnit: {
    ...typography.body,
    color: colors.text.secondary,
  },
  vitalTimestamp: {
    ...typography.small,
    color: colors.text.secondary,
    marginBottom: spacing.sm,
  },
  crisisBadge: {
    backgroundColor: colors.danger,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  crisisBadgeText: {
    ...typography.small,
    color: '#fff',
    fontWeight: '700',
  },
  emptyText: {
    ...typography.body,
    color: colors.text.secondary,
    marginBottom: spacing.sm,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  buttonText: {
    ...typography.body,
    color: '#fff',
    fontWeight: '600',
  },
  visitDate: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  visitDiagnosis: {
    ...typography.body,
    color: colors.text.secondary,
  },
  quickActions: {
    flexDirection: 'row',
    gap: spacing.md,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  actionButton: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  actionButtonText: {
    ...typography.body,
    color: colors.primary,
    fontWeight: '600',
  },
});