/**
 * Patient Visits Screen
 * Location: mobile/app/(app)/ehr/visits.tsx
 *
 * Displays the patient's own visit history fetched from
 * GET /api/patient/visits.
 *
 * Each visit card shows:
 *   - Visit date
 *   - Chief complaint
 *   - Diagnosis (ICD-10 code + description)
 *   - Clinical notes (expandable)
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { apiClient } from '@/services/api/client';
import { API } from '@/services/api/endpoints';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import VisitDetailModal, { type VisitDetail } from '@/components/ehr/VisitDetailModal';

// Re-export VisitDetail from the modal so the local type alias is consistent.
type Visit = VisitDetail;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Format an ISO datetime string into a readable date, e.g. "12 Apr 2025" */
function formatDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day:   'numeric',
      month: 'short',
      year:  'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Visit Summary Card (pressable — opens VisitDetailModal)
// ─────────────────────────────────────────────────────────────────────────────

function VisitCard({ visit, onPress }: { visit: Visit; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={`Visit on ${formatDate(visit.visit_date)}, tap for details`}
    >
      {/* Header row: date + chevron */}
      <View style={styles.cardHeader}>
        <Text style={styles.visitDate}>📅 {formatDate(visit.visit_date)}</Text>
        <Text style={styles.cardChevron}>›</Text>
      </View>

      {/* Chief complaint */}
      {visit.chief_complaint ? (
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Reason</Text>
          <Text style={styles.rowValue} numberOfLines={2}>{visit.chief_complaint}</Text>
        </View>
      ) : null}

      {/* Diagnosis */}
      {visit.diagnosis_text ? (
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Diagnosis</Text>
          <View style={styles.diagnosisCell}>
            <Text style={styles.rowValue} numberOfLines={2}>{visit.diagnosis_text}</Text>
            {visit.diagnosis_icd10 ? (
              <View style={styles.icdBadge}>
                <Text style={styles.icdText}>{visit.diagnosis_icd10}</Text>
              </View>
            ) : null}
          </View>
        </View>
      ) : null}

      {/* Notes hint */}
      {visit.notes?.trim() ? (
        <Text style={styles.notesHint}>📝 Notes available — tap to read</Text>
      ) : null}
    </TouchableOpacity>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function VisitsScreen() {
  const [visits,       setVisits]       = useState<Visit[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [selectedVisit, setSelectedVisit] = useState<Visit | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await apiClient.get<Visit[]>(API.EHR.VISITS);
      setVisits(res.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load visits');
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

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'My Visits' }} />

      <VisitDetailModal
        visit={selectedVisit}
        onClose={() => setSelectedVisit(null)}
      />

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
          {/* Summary header */}
          <View style={styles.headerCard}>
            <Text style={styles.headerTitle}>🏥 Visit History</Text>
            <Text style={styles.headerSubtitle}>
              {visits.length} {visits.length === 1 ? 'visit' : 'visits'} recorded
            </Text>
          </View>

          {visits.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyIcon}>🏥</Text>
              <Text style={styles.emptyTitle}>No visits recorded yet</Text>
              <Text style={styles.emptyBody}>
                Your doctor will record visits here after each appointment.
              </Text>
            </View>
          ) : (
            visits.map((v) => (
              <VisitCard
                key={v.id}
                visit={v}
                onPress={() => setSelectedVisit(v)}
              />
            ))
          )}
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

  // Visit card
  card: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 10,
  },
  cardHeader: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
  },
  visitDate: {
    ...typography.body,
    color:      colors.text.primary,
    fontWeight: '700',
  },
  cardChevron: {
    fontSize:  22,
    color:     colors.text.secondary,
    fontWeight: '300',
    lineHeight: 26,
  },

  // Row
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  rowLabel: {
    ...typography.small,
    color: colors.text.secondary,
    fontWeight: '600',
    width: 72,
    paddingTop: 2,
    flexShrink: 0,
  },
  rowValue: {
    ...typography.body,
    color: colors.text.primary,
    flex: 1,
  },
  diagnosisCell: {
    flex: 1,
    gap: 4,
  },
  icdBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primary + '15',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  icdText: {
    ...typography.small,
    color: colors.primary,
    fontWeight: '700',
  },

  notesHint: {
    ...typography.small,
    color:      colors.primary,
    fontWeight: '600',
    paddingTop: 2,
  },

  // Empty state
  emptyContainer: {
    alignItems: 'center',
    paddingTop: 60,
    gap: 12,
  },
  emptyIcon:  { fontSize: 56 },
  emptyTitle: {
    ...typography.h3,
    color: colors.text.primary,
    textAlign: 'center',
  },
  emptyBody: {
    ...typography.body,
    color: colors.text.secondary,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
  },
});