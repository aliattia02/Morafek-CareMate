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

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Visit {
  id:               string;
  encounter_fhir_id?: string;
  doctor_id?:       string;
  chief_complaint?: string;
  diagnosis_icd10?: string;
  diagnosis_text?:  string;
  visit_date?:      string;
  notes?:           string;
}

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
// Visit Card
// ─────────────────────────────────────────────────────────────────────────────

function VisitCard({ visit }: { visit: Visit }) {
  const [expanded, setExpanded] = useState(false);
  const hasNotes = !!visit.notes?.trim();

  return (
    <View style={styles.card}>
      {/* Header row: date */}
      <View style={styles.cardHeader}>
        <Text style={styles.visitDate}>📅 {formatDate(visit.visit_date)}</Text>
      </View>

      {/* Chief complaint */}
      {visit.chief_complaint ? (
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Reason</Text>
          <Text style={styles.rowValue}>{visit.chief_complaint}</Text>
        </View>
      ) : null}

      {/* Diagnosis */}
      {visit.diagnosis_text ? (
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Diagnosis</Text>
          <View style={styles.diagnosisCell}>
            <Text style={styles.rowValue}>{visit.diagnosis_text}</Text>
            {visit.diagnosis_icd10 ? (
              <View style={styles.icdBadge}>
                <Text style={styles.icdText}>{visit.diagnosis_icd10}</Text>
              </View>
            ) : null}
          </View>
        </View>
      ) : null}

      {/* Notes (expandable) */}
      {hasNotes && (
        <>
          <TouchableOpacity
            style={styles.notesToggle}
            onPress={() => setExpanded((p) => !p)}
            accessibilityRole="button"
            accessibilityLabel={expanded ? 'Collapse notes' : 'Expand notes'}
          >
            <Text style={styles.notesToggleText}>
              📝 Notes {expanded ? '▲' : '▼'}
            </Text>
          </TouchableOpacity>
          {expanded && (
            <View style={styles.notesBox}>
              <Text style={styles.notesText}>{visit.notes}</Text>
            </View>
          )}
        </>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function VisitsScreen() {
  const [visits,     setVisits]     = useState<Visit[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

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
            visits.map((v) => <VisitCard key={v.id} visit={v} />)
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
    flexDirection: 'row',
    alignItems: 'center',
  },
  visitDate: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '700',
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

  // Notes
  notesToggle: {
    paddingVertical: spacing.xs,
  },
  notesToggleText: {
    ...typography.small,
    color: colors.primary,
    fontWeight: '600',
  },
  notesBox: {
    backgroundColor: colors.background,
    borderRadius: borderRadius.sm,
    padding: spacing.sm,
    borderLeftWidth: 3,
    borderLeftColor: colors.border,
  },
  notesText: {
    ...typography.body,
    color: colors.text.secondary,
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