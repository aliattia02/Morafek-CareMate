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
import { colors } from '@/constants/theme';
import { E, ET } from '@/constants/elderlyTheme';

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
  accentColor = E.colors.primary,
  children,
}: {
  icon: string;
  title: string;
  accentColor?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.card}>
      <View style={[styles.cardAccent, { backgroundColor: accentColor }]} />
      <View style={styles.cardInner}>
        <View style={styles.cardHeader}>
          <View style={[styles.cardIconBg, { backgroundColor: accentColor + '22' }]}>
            <Text style={styles.cardIcon}>{icon}</Text>
          </View>
          <Text style={styles.cardTitle}>{title}</Text>
        </View>
        {children}
      </View>
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
        <ActivityIndicator color={E.colors.primary} size="large" style={styles.loader} />
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
              colors={[E.colors.primary]}
            />
          }
        >
          {/* ── Hero card ── */}
          <View style={styles.heroCard}>
            <View style={styles.heroAvatar}>
              <Text style={styles.heroAvatarText}>
                {profile?.first_name?.[0]?.toUpperCase() ?? '?'}
              </Text>
            </View>
            <View style={styles.heroInfo}>
              <Text style={styles.heroName}>{profile?.first_name} {profile?.last_name}</Text>
              {profile?.updated_at ? (
                <Text style={styles.heroMeta}>
                  Last updated · {profile.updated_at.slice(0, 10)}
                </Text>
              ) : null}
            </View>
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
            <SectionCard icon="👤" title="Demographics" accentColor={E.colors.primary}>
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
          <SectionCard icon="⚠️" title="Allergies" accentColor={E.colors.danger}>
            <TagList
              items={profile?.allergies ?? []}
              emptyText="No allergies recorded"
              variant="danger"
            />
          </SectionCard>

          {/* ── Chronic Conditions ── */}
          <SectionCard icon="🏥" title="Chronic Conditions" accentColor={E.colors.warning}>
            <TagList
              items={profile?.chronic_conditions ?? []}
              emptyText="No chronic conditions recorded"
            />
          </SectionCard>

          {/* ── Current Medications ── */}
          <SectionCard icon="💊" title="Current Medications" accentColor={E.colors.success}>
            <TagList
              items={profile?.current_medications ?? []}
              emptyText="No medications recorded"
              variant="med"
            />
          </SectionCard>

          {/* ── Emergency Contact ── */}
          <SectionCard icon="📞" title="Emergency Contact" accentColor={E.colors.accent}>
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
            <SectionCard icon="📝" title="Clinical Notes" accentColor={E.colors.primary}>
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
    backgroundColor: E.colors.bg,
  },
  loader: {
    flex: 1,
    marginTop: 40,
  },
  errorContainer: {
    flex: 1,
    padding: E.pad,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    ...ET.body,
    color: E.colors.danger,
    textAlign: 'center',
  },
  scroll: { flex: 1 },
  content: {
    padding: E.padSm,
    paddingBottom: 40,
    gap: E.padSm,
  },

  // ── Hero card ──
  heroCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: E.colors.primary,
    borderRadius: E.radius,
    padding: E.pad,
    gap: E.padSm,
    ...E.shadow,
  },
  heroAvatar: {
    width: 60,
    height: 60,
    borderRadius: E.radiusFull,
    backgroundColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroAvatarText: {
    ...ET.h2,
    color: E.colors.textInverse,
    fontWeight: '700',
  },
  heroInfo: {
    flex: 1,
  },
  heroName: {
    ...ET.h3,
    color: E.colors.textInverse,
    fontWeight: '700',
  },
  heroMeta: {
    ...ET.small,
    color: E.colors.primaryLight,
    marginTop: 2,
  },

  // ── Empty state ──
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
    paddingHorizontal: E.pad,
    gap: E.padSm,
  },
  emptyStateIcon: { fontSize: 48 },
  emptyStateTitle: {
    ...ET.h3,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyStateBody: {
    ...ET.body,
    color: E.colors.textSecondary,
    textAlign: 'center',
  },

  // ── Quick stats ──
  quickStats: {
    flexDirection: 'row',
    backgroundColor: E.colors.surface,
    borderRadius: E.radius,
    borderWidth: 1,
    borderColor: E.colors.border,
    padding: E.padXs,
    alignItems: 'center',
    ...E.shadowSm,
  },
  quickStat: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingVertical: E.padXs,
  },
  quickStatIcon:  { fontSize: 18 },
  quickStatValue: {
    ...ET.bodyBold,
    textAlign: 'center',
    fontSize: 14,
  },
  quickStatLabel: {
    ...ET.caption,
    textAlign: 'center',
  },
  quickStatDivider: {
    width: 1,
    height: 40,
    backgroundColor: E.colors.border,
  },

  // ── Section card ──
  card: {
    backgroundColor: E.colors.surface,
    borderRadius: E.radius,
    borderWidth: 1,
    borderColor: E.colors.border,
    overflow: 'hidden',
    flexDirection: 'row',
    ...E.shadowSm,
  },
  cardAccent: {
    width: 4,
  },
  cardInner: {
    flex: 1,
    padding: E.padSm,
    gap: 10,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: E.padXs,
    marginBottom: E.padXs,
  },
  cardIconBg: {
    width: 32,
    height: 32,
    borderRadius: E.radiusXs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardIcon:  { fontSize: 18 },
  cardTitle: {
    ...ET.h3,
  },

  // ── Info row ──
  infoRow: {
    flexDirection: 'row',
    gap: E.padXs,
    alignItems: 'flex-start',
    paddingBottom: E.padXs,
    borderBottomWidth: 1,
    borderBottomColor: E.colors.divider,
  },
  infoLabel: {
    ...ET.small,
    fontWeight: '600',
    color: E.colors.textSecondary,
    width: 100,
    paddingTop: 2,
    flexShrink: 0,
  },
  infoValue: {
    ...ET.body,
    flex: 1,
    textTransform: 'capitalize',
  },

  // ── Tag list ──
  tagContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: E.padXs,
  },
  // default tag
  tag: {
    backgroundColor: E.colors.primaryLight,
    borderRadius: E.radiusFull,
    paddingHorizontal: E.padSm,
    paddingVertical: E.padXs,
  },
  tagText: {
    ...ET.small,
    color: E.colors.primary,
    fontWeight: '600',
  },
  // danger tag (allergies)
  tagDanger: {
    backgroundColor: '#FFEBEE',
    borderRadius: E.radiusFull,
    paddingHorizontal: E.padSm,
    paddingVertical: E.padXs,
    borderWidth: 1,
    borderColor: '#EF9A9A',
  },
  tagTextDanger: {
    ...ET.small,
    color: '#B71C1C',
    fontWeight: '600',
  },
  // med tag (medications)
  tagMed: {
    backgroundColor: '#E8F5E9',
    borderRadius: E.radiusFull,
    paddingHorizontal: E.padSm,
    paddingVertical: E.padXs,
    borderWidth: 1,
    borderColor: '#A5D6A7',
  },
  tagTextMed: {
    ...ET.small,
    color: '#1B5E20',
    fontWeight: '600',
  },
  emptyTagText: {
    ...ET.body,
    color: E.colors.textSecondary,
    fontStyle: 'italic',
  },

  // ── Emergency contact ──
  emergencyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: E.colors.accentLight,
    borderRadius: E.radiusSm,
    padding: E.padXs,
    gap: E.padXs,
    borderWidth: 1,
    borderColor: E.colors.accent + '55',
  },
  emergencyIcon: { fontSize: 22 },
  emergencyInfo: { flex: 1 },
  emergencyName: {
    ...ET.bodyBold,
  },
  emergencyPhone: {
    ...ET.body,
    color: E.colors.textSecondary,
  },

  // ── Clinical notes ──
  notesBox: {
    backgroundColor: E.colors.bg,
    borderRadius: E.radiusSm,
    padding: E.padXs,
    borderLeftWidth: 3,
    borderLeftColor: E.colors.primary,
  },
  notesText: {
    ...ET.body,
  },
});