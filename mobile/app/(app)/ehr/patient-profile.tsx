/**
 * Patient Profile Screen
 * Location: mobile/app/(app)/ehr/patient-profile.tsx
 *
 * Read-only view of the patient's medical profile stored in MongoDB:
 *   - Blood type
 *   - Allergies
 *   - Chronic conditions
 *   - Emergency contact
 *
 * Data source: GET /api/patient/profile
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { apiClient } from '@/services/api/client';
import { API } from '@/services/api/endpoints';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface EhrProfile {
  blood_type:         string;
  allergies:          string[];
  chronic_conditions: string[];
  emergency_contact:  string;
}

interface PatientProfileData {
  first_name:          string;
  last_name:           string;
  email:               string;
  profile_picture_url: string;
  ehr_profile:         EhrProfile;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function SectionCard({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardIcon}>{icon}</Text>
        <Text style={styles.cardTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value || '—'}</Text>
    </View>
  );
}

function TagList({ items, emptyText }: { items: string[]; emptyText: string }) {
  if (!items || items.length === 0) {
    return <Text style={styles.emptyTagText}>{emptyText}</Text>;
  }
  return (
    <View style={styles.tagContainer}>
      {items.map((item, index) => (
        <View key={index} style={styles.tag}>
          <Text style={styles.tagText}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function PatientProfileScreen() {
  const [profile,    setProfile]    = useState<PatientProfileData | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await apiClient.get<PatientProfileData>(API.PATIENT.PROFILE);
      setProfile(res.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load profile');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const ehr = profile?.ehr_profile;

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Medical Profile' }} />

      {loading ? (
        <ActivityIndicator
          color={colors.primary}
          size="large"
          style={styles.loader}
        />
      ) : error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[colors.primary]}
            />
          }
        >
          {/* Header banner */}
          <View style={styles.headerCard}>
            <Text style={styles.headerTitle}>🩺 Medical Profile</Text>
            <Text style={styles.headerSubtitle}>
              {profile?.first_name} {profile?.last_name}
            </Text>
          </View>

          {/* Blood Type */}
          <SectionCard icon="🩸" title="Blood Type">
            <Text style={styles.bloodTypeValue}>
              {ehr?.blood_type || 'Not recorded'}
            </Text>
          </SectionCard>

          {/* Allergies */}
          <SectionCard icon="⚠️" title="Allergies">
            <TagList
              items={ehr?.allergies ?? []}
              emptyText="No allergies recorded"
            />
          </SectionCard>

          {/* Chronic Conditions */}
          <SectionCard icon="🏥" title="Chronic Conditions">
            <TagList
              items={ehr?.chronic_conditions ?? []}
              emptyText="No chronic conditions recorded"
            />
          </SectionCard>

          {/* Emergency Contact */}
          <SectionCard icon="📞" title="Emergency Contact">
            <InfoRow label="Contact" value={ehr?.emergency_contact ?? ''} />
          </SectionCard>
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
  loader: {
    flex: 1,
    marginTop: 40,
  },
  errorContainer: {
    flex: 1,
    padding: spacing.lg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    ...typography.body,
    color: colors.danger,
    textAlign: 'center',
  },
  scroll: { flex: 1 },
  content: {
    padding: spacing.md,
    paddingBottom: 40,
    gap: 12,
  },

  // Header
  headerCard: {
    backgroundColor: colors.primary + '12',
    borderRadius: borderRadius.md,
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
    padding: spacing.md,
    gap: 4,
  },
  headerTitle: {
    ...typography.h3,
    color: colors.text.primary,
    fontWeight: '700',
  },
  headerSubtitle: {
    ...typography.body,
    color: colors.text.secondary,
  },

  // Section card
  card: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 10,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  cardIcon: { fontSize: 20 },
  cardTitle: {
    ...typography.h3,
    color: colors.text.primary,
  },

  // Blood type
  bloodTypeValue: {
    ...typography.h2,
    color: colors.primary,
    fontWeight: '700',
  },

  // Info row (label + value)
  infoRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  infoLabel: {
    ...typography.small,
    color: colors.text.secondary,
    fontWeight: '600',
    width: 72,
    paddingTop: 2,
    flexShrink: 0,
  },
  infoValue: {
    ...typography.body,
    color: colors.text.primary,
    flex: 1,
  },

  // Tag list
  tagContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  tag: {
    backgroundColor: colors.primary + '15',
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  tagText: {
    ...typography.small,
    color: colors.primary,
    fontWeight: '600',
  },
  emptyTagText: {
    ...typography.body,
    color: colors.text.secondary,
    fontStyle: 'italic',
  },
});
