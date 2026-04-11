/**
 * Patient Profile Screen
 * Location: mobile/app/(app)/ehr/patient-profile.tsx
 *
 * Read-only view of the patient's full medical profile as filled in by
 * their doctor. Data source: GET /api/patient/medical-profile
 *
 * Displays:
 *   - Demographics  (DOB, gender, blood type, height, weight, smoking)
 *   - Allergies
 *   - Chronic conditions
 *   - Current medications
 *   - Emergency contact
 *   - Clinical notes
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
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface MedicalProfile {
  // Identity
  first_name: string;
  last_name:  string;
  email:      string;
  // Medical
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

function TagList({
  items,
  emptyText,
  variant = 'default',
}: {
  items: string[];
  emptyText: string;
  variant?: 'default' | 'danger' | 'med';
}) {
  if (!items || items.length === 0) {
    return <Text style={styles.emptyTagText}>{emptyText}</Text>;
  }
  const tagStyle      = variant === 'danger' ? styles.tagDanger      : variant === 'med' ? styles.tagMed      : styles.tag;
  const tagTextStyle  = variant === 'danger' ? styles.tagTextDanger  : variant === 'med' ? styles.tagTextMed  : styles.tagText;
  const prefix        = variant === 'danger' ? '⚠ ' : variant === 'med' ? '💊 ' : '';

  return (
    <View style={styles.tagContainer}>
      {items.map((item, index) => (
        <View key={index} style={tagStyle}>
          <Text style={tagTextStyle}>{prefix}{item}</Text>
        </View>
      ))}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns a friendly label for blood_type='unknown' or '' */
function displayBloodType(bt: string): string {
  if (!bt || bt === 'unknown') return 'Not recorded';
  return bt;
}

/** Returns a friendly label for smoking_status='unknown' or '' */
function displaySmoking(ss: string): string {
  if (!ss || ss === 'unknown') return '—';
  const map: Record<string, string> = {
    never:   'Never smoked',
    former:  'Former smoker',
    current: 'Current smoker',
  };
  return map[ss] ?? ss;
}

/** Formats ISO date string to localised display */
function formatDate(iso: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch {
    return iso;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function PatientProfileScreen() {
  const [profile,    setProfile]    = useState<MedicalProfile | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      // Uses the new endpoint that reads from the patient_profiles collection
      // (data saved by the doctor) instead of the legacy ehr_profile field.
      const res = await apiClient.get<MedicalProfile>('/api/patient/medical-profile');
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

  // True when a doctor has filled in at least one field
  const hasData = profile
    ? (
        profile.blood_type !== 'unknown' ||
        profile.gender !== '' ||
        profile.date_of_birth !== '' ||
        profile.height_cm != null ||
        profile.weight_kg != null ||
        profile.allergies.length > 0 ||
        profile.chronic_conditions.length > 0 ||
        profile.current_medications.length > 0 ||
        profile.emergency_contact_name !== '' ||
        profile.notes !== ''
      )
    : false;

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Medical Profile' }} />

      {loading ? (
        <ActivityIndicator color={colors.primary} size="large" style={styles.loader} />
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
          {/* ── Header banner ── */}
          <View style={styles.headerCard}>
            <Text style={styles.headerTitle}>🩺 Medical Profile</Text>
            <Text style={styles.headerSubtitle}>
              {profile?.first_name} {profile?.last_name}
            </Text>
            {profile?.updated_at ? (
              <Text style={styles.headerMeta}>
                Last updated by your doctor · {profile.updated_at.slice(0, 10)}
              </Text>
            ) : null}
          </View>

          {/* ── Empty state ── */}
          {!hasData && (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateIcon}>📋</Text>
              <Text style={styles.emptyStateTitle}>No medical data yet</Text>
              <Text style={styles.emptyStateBody}>
                Your doctor hasn't filled in your medical profile yet.
                It will appear here once they do.
              </Text>
            </View>
          )}

          {/* ── Quick stats row ── */}
          {hasData && (
            <View style={styles.quickStats}>
              {[
                { icon: '🩸', label: 'Blood Type', value: displayBloodType(profile?.blood_type ?? '') },
                { icon: '📏', label: 'Height',     value: profile?.height_cm ? `${profile.height_cm} cm` : '—' },
                { icon: '⚖️', label: 'Weight',     value: profile?.weight_kg ? `${profile.weight_kg} kg` : '—' },
                { icon: '🚬', label: 'Smoking',    value: displaySmoking(profile?.smoking_status ?? '') },
              ].map((stat, i, arr) => (
                <React.Fragment key={stat.label}>
                  <View style={styles.quickStat}>
                    <Text style={styles.quickStatIcon}>{stat.icon}</Text>
                    <Text style={styles.quickStatValue}>{stat.value}</Text>
                    <Text style={styles.quickStatLabel}>{stat.label}</Text>
                  </View>
                  {i < arr.length - 1 && <View style={styles.quickStatDivider} />}
                </React.Fragment>
              ))}
            </View>
          )}

          {/* ── Demographics ── */}
          {hasData && (
            <SectionCard icon="👤" title="Demographics">
              <InfoRow label="Date of birth" value={formatDate(profile?.date_of_birth ?? '')} />
              <InfoRow label="Gender"        value={profile?.gender ? profile.gender.replace('_', ' ') : '—'} />
              <InfoRow label="Blood type"    value={displayBloodType(profile?.blood_type ?? '')} />
              {profile?.height_cm != null && (
                <InfoRow label="Height" value={`${profile.height_cm} cm`} />
              )}
              {profile?.weight_kg != null && (
                <InfoRow label="Weight" value={`${profile.weight_kg} kg`} />
              )}
              <InfoRow label="Smoking" value={displaySmoking(profile?.smoking_status ?? '')} />
            </SectionCard>
          )}

          {/* ── Allergies ── */}
          <SectionCard icon="⚠️" title="Allergies">
            <TagList
              items={profile?.allergies ?? []}
              emptyText="No allergies recorded"
              variant="danger"
            />
          </SectionCard>

          {/* ── Chronic Conditions ── */}
          <SectionCard icon="🏥" title="Chronic Conditions">
            <TagList
              items={profile?.chronic_conditions ?? []}
              emptyText="No chronic conditions recorded"
            />
          </SectionCard>

          {/* ── Current Medications ── */}
          <SectionCard icon="💊" title="Current Medications">
            <TagList
              items={profile?.current_medications ?? []}
              emptyText="No medications recorded"
              variant="med"
            />
          </SectionCard>

          {/* ── Emergency Contact ── */}
          <SectionCard icon="📞" title="Emergency Contact">
            {profile?.emergency_contact_name || profile?.emergency_contact_phone ? (
              <View style={styles.emergencyCard}>
                <Text style={styles.emergencyIcon}>🆘</Text>
                <View style={styles.emergencyInfo}>
                  {profile.emergency_contact_name ? (
                    <Text style={styles.emergencyName}>{profile.emergency_contact_name}</Text>
                  ) : null}
                  {profile.emergency_contact_phone ? (
                    <Text style={styles.emergencyPhone}>{profile.emergency_contact_phone}</Text>
                  ) : null}
                </View>
              </View>
            ) : (
              <Text style={styles.emptyTagText}>No emergency contact recorded</Text>
            )}
          </SectionCard>

          {/* ── Clinical Notes ── */}
          {profile?.notes ? (
            <SectionCard icon="📝" title="Clinical Notes">
              <View style={styles.notesBox}>
                <Text style={styles.notesText}>{profile.notes}</Text>
              </View>
            </SectionCard>
          ) : null}

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

  // ── Header ──
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
  headerMeta: {
    ...typography.small,
    color: colors.text.secondary,
    marginTop: 2,
    fontStyle: 'italic',
  },

  // ── Empty state ──
  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  emptyStateIcon: { fontSize: 48 },
  emptyStateTitle: {
    ...typography.h3,
    color: colors.text.primary,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyStateBody: {
    ...typography.body,
    color: colors.text.secondary,
    textAlign: 'center',
  },

  // ── Quick stats ──
  quickStats: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    alignItems: 'center',
  },
  quickStat: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingVertical: spacing.xs,
  },
  quickStatIcon:  { fontSize: 18 },
  quickStatValue: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '700',
    textAlign: 'center',
    fontSize: 13,
  },
  quickStatLabel: {
    ...typography.small,
    color: colors.text.secondary,
    textAlign: 'center',
  },
  quickStatDivider: {
    width: 1,
    height: 40,
    backgroundColor: colors.border,
  },

  // ── Section card ──
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
  cardIcon:  { fontSize: 20 },
  cardTitle: {
    ...typography.h3,
    color: colors.text.primary,
  },

  // ── Info row ──
  infoRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  infoLabel: {
    ...typography.small,
    color: colors.text.secondary,
    fontWeight: '600',
    width: 100,
    paddingTop: 2,
    flexShrink: 0,
  },
  infoValue: {
    ...typography.body,
    color: colors.text.primary,
    flex: 1,
    textTransform: 'capitalize',
  },

  // ── Tag list ──
  tagContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  // default tag
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
  // danger tag (allergies)
  tagDanger: {
    backgroundColor: '#FFEBEE',
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: '#EF9A9A',
  },
  tagTextDanger: {
    ...typography.small,
    color: '#B71C1C',
    fontWeight: '600',
  },
  // med tag (medications)
  tagMed: {
    backgroundColor: '#E8F5E9',
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: '#A5D6A7',
  },
  tagTextMed: {
    ...typography.small,
    color: '#1B5E20',
    fontWeight: '600',
  },
  emptyTagText: {
    ...typography.body,
    color: colors.text.secondary,
    fontStyle: 'italic',
  },

  // ── Emergency contact ──
  emergencyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF8E1',
    borderRadius: borderRadius.sm,
    padding: spacing.sm,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: '#FFE082',
  },
  emergencyIcon: { fontSize: 22 },
  emergencyInfo: { flex: 1 },
  emergencyName: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '700',
  },
  emergencyPhone: {
    ...typography.body,
    color: colors.text.secondary,
  },

  // ── Clinical notes ──
  notesBox: {
    backgroundColor: colors.background,
    borderRadius: borderRadius.sm,
    padding: spacing.sm,
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
  },
  notesText: {
    ...typography.body,
    color: colors.text.primary,
  },
});