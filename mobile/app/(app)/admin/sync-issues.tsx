/**
 * Admin — Sync Issues Screen
 * Location: mobile/app/(app)/admin/sync-issues.tsx
 *
 * Read-only list of standing sync problems flagged by the research sync job
 * (GET /api/admin/sync-issues). There is no mutation endpoint — issues only
 * clear themselves when a later sync stops seeing the condition.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, Loading } from '@/components/ui';
import { getSyncIssues, type SyncIssue, type SyncIssueType } from '@/services/api/admin';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// ─── filter strip ─────────────────────────────────────────────────────────────

const FILTERS: { id: SyncIssueType | 'all'; label: string }[] = [
  { id: 'all', label: 'All Issues' },
  { id: 'missing_pseudonym', label: 'Missing Pseudonym' },
  { id: 'gics_query_failure', label: 'gICS Query Failure' },
];

function FilterStrip({
  selected,
  onSelect,
}: {
  selected: SyncIssueType | 'all';
  onSelect: (id: SyncIssueType | 'all') => void;
}) {
  return (
    <FlatList
      horizontal
      data={FILTERS}
      keyExtractor={(item) => item.id}
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.filterList}
      renderItem={({ item }) => {
        const active = item.id === selected;
        return (
          <TouchableOpacity
            style={[styles.pill, active && styles.pillActive]}
            onPress={() => onSelect(item.id)}
            activeOpacity={0.75}
          >
            <Text style={[styles.pillText, active && styles.pillTextActive]}>{item.label}</Text>
          </TouchableOpacity>
        );
      }}
    />
  );
}

// ─── issue card ───────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function IssueCard({ issue }: { issue: SyncIssue }) {
  const isOpen = issue.resolved_at === null;
  const isRepeated = issue.occurrence_count > 1;

  return (
    <Card variant="outlined" padding="medium" style={styles.issueCard}>
      <View style={styles.issueHeader}>
        <View style={[styles.typeBadge, isOpen ? styles.typeBadgeOpen : styles.typeBadgeResolved]}>
          <Text style={[styles.typeBadgeText, isOpen ? styles.typeBadgeTextOpen : styles.typeBadgeTextResolved]}>
            {issue.issue_type === 'missing_pseudonym' ? 'Missing Pseudonym' :
             issue.issue_type === 'gics_query_failure' ? 'gICS Query Failure' : issue.issue_type}
          </Text>
        </View>
        {isRepeated && (
          <View style={styles.occurrenceBadge}>
            <Text style={styles.occurrenceBadgeText}>×{issue.occurrence_count}</Text>
          </View>
        )}
        {!isOpen && (
          <View style={styles.resolvedBadge}>
            <Text style={styles.resolvedBadgeText}>✓ Resolved</Text>
          </View>
        )}
      </View>

      <Text style={styles.patientId} numberOfLines={1}>Patient: {issue.patient_id}</Text>

      <View style={styles.dateRow}>
        <Text style={styles.dateLabel}>Detected</Text>
        <Text style={styles.dateValue}>{formatDate(issue.detected_at)}</Text>
      </View>
      <View style={styles.dateRow}>
        <Text style={styles.dateLabel}>Last seen</Text>
        <Text style={styles.dateValue}>{formatDate(issue.last_seen_at)}</Text>
      </View>
      {issue.resolved_at && (
        <View style={styles.dateRow}>
          <Text style={styles.dateLabel}>Resolved</Text>
          <Text style={styles.dateValue}>{formatDate(issue.resolved_at)}</Text>
        </View>
      )}

      {issue.context && Object.keys(issue.context).length > 0 && (
        <View style={styles.contextBox}>
          {Object.entries(issue.context).map(([key, value]) => (
            <Text key={key} style={styles.contextLine}>
              {key}: {String(value)}
            </Text>
          ))}
        </View>
      )}
    </Card>
  );
}

// ─── screen ───────────────────────────────────────────────────────────────────

export default function SyncIssuesScreen() {
  const [issueType, setIssueType] = useState<SyncIssueType | 'all'>('all');
  const [includeResolved, setIncludeResolved] = useState(false);

  const [issues, setIssues] = useState<SyncIssue[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await getSyncIssues({
        issue_type: issueType === 'all' ? undefined : issueType,
        include_resolved: includeResolved,
      });
      setIssues(data.issues);
      setOpenCount(data.open_count);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Failed to load sync issues');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [issueType, includeResolved]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Sync Issues' }} />

      <FilterStrip selected={issueType} onSelect={setIssueType} />

      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>Show resolved issues</Text>
        <Switch value={includeResolved} onValueChange={setIncludeResolved} />
      </View>

      <View style={styles.summaryRow}>
        <Text style={styles.summaryText}>{openCount} open issue{openCount !== 1 ? 's' : ''}</Text>
      </View>

      {loading ? (
        <Loading text="Loading sync issues…" />
      ) : (
        <FlatList
          data={issues}
          keyExtractor={(item) => `${item.patient_id}-${item.issue_type}`}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} />}
          renderItem={({ item }) => <IssueCard issue={item} />}
          ListEmptyComponent={
            error ? (
              <Card variant="outlined" padding="medium" style={styles.errorCard}>
                <Text style={styles.errorText}>⚠️ {error}</Text>
              </Card>
            ) : (
              <View style={styles.emptyState}>
                <Text style={styles.emptyIcon}>✅</Text>
                <Text style={styles.emptyTitle}>No issues found</Text>
                <Text style={styles.emptySub}>
                  {includeResolved ? 'Nothing matches this filter.' : 'No open sync problems right now.'}
                </Text>
              </View>
            )
          }
        />
      )}
    </SafeAreaView>
  );
}

// ─── styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },

  filterList: { gap: spacing.sm, paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: spacing.xs },
  pill: {
    paddingVertical: spacing.xs, paddingHorizontal: spacing.md,
    borderRadius: borderRadius.full, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface,
  },
  pillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  pillText: { ...typography.small, color: colors.text.secondary, fontWeight: '500' },
  pillTextActive: { color: colors.text.inverse, fontWeight: '600' },

  toggleRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  toggleLabel: { ...typography.body, color: colors.text.primary },

  summaryRow: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  summaryText: { ...typography.caption, color: colors.text.secondary, fontWeight: '600' },

  listContent: { padding: spacing.md, paddingTop: 0, gap: spacing.sm },

  issueCard: { gap: 6 },
  issueHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: 4 },
  typeBadge: { borderRadius: borderRadius.full, paddingHorizontal: spacing.sm, paddingVertical: 3 },
  typeBadgeOpen: { backgroundColor: colors.dangerLight + '30' },
  typeBadgeResolved: { backgroundColor: colors.divider },
  typeBadgeText: { ...typography.small, fontWeight: '700' },
  typeBadgeTextOpen: { color: colors.dangerDark },
  typeBadgeTextResolved: { color: colors.text.secondary },

  occurrenceBadge: {
    backgroundColor: colors.warning, borderRadius: borderRadius.full,
    minWidth: 24, height: 22, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6,
  },
  occurrenceBadgeText: { ...typography.small, fontWeight: '700', color: colors.text.inverse },

  resolvedBadge: { backgroundColor: colors.success + '22', borderRadius: borderRadius.full, paddingHorizontal: spacing.sm, paddingVertical: 3 },
  resolvedBadgeText: { ...typography.small, fontWeight: '700', color: colors.successDark },

  patientId: { ...typography.caption, fontWeight: '600', color: colors.text.primary, fontFamily: 'Courier New' },

  dateRow: { flexDirection: 'row', justifyContent: 'space-between' },
  dateLabel: { ...typography.small, color: colors.text.secondary },
  dateValue: { ...typography.small, color: colors.text.primary },

  contextBox: { backgroundColor: colors.surfaceVariant, borderRadius: borderRadius.sm, padding: spacing.sm, marginTop: 4, gap: 2 },
  contextLine: { ...typography.small, color: colors.text.secondary, fontFamily: 'Courier New' },

  errorCard: { borderColor: colors.danger, margin: spacing.md },
  errorText: { ...typography.small, color: colors.danger },

  emptyState: { alignItems: 'center', paddingVertical: spacing.xl, gap: 4 },
  emptyIcon: { fontSize: 36 },
  emptyTitle: { ...typography.body, fontWeight: '700', color: colors.text.secondary },
  emptySub: { ...typography.caption, color: colors.text.secondary, textAlign: 'center' },
});
