/**
 * Research Sync Screen
 * Location: mobile/app/(app)/research/sync.tsx
 *
 * Researcher-triggered consent-eligibility refresh + vitals mirror.
 * POST /api/research/sync is synchronous and can take several seconds
 * (scales with patient count) — this screen shows a blocking spinner while
 * it runs rather than firing-and-forgetting it.
 *
 * error_count > 0 in a 200 response is a PARTIAL success, not a failure —
 * the rest of the patients still synced. Only a 502 (gICS completely
 * unreachable) is treated as a hard failure.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card } from '@/components/ui';
import {
  triggerResearchSync,
  getResearchSyncStatus,
  type ResearchSyncResult,
  type ResearchSyncStatus,
} from '@/services/api/research';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatStaleness(staleMinutes: number | null): string {
  if (staleMinutes === null) return 'Never synced';
  if (staleMinutes < 1) return 'Synced just now';
  if (staleMinutes < 60) return `Synced ${Math.round(staleMinutes)} min ago`;
  const hours = staleMinutes / 60;
  if (hours < 24) return `Synced ${hours.toFixed(1)} h ago`;
  return `Synced ${Math.round(hours / 24)} day(s) ago`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ─── stat row ─────────────────────────────────────────────────────────────────

function StatRow({ label, value }: { label: string; value: number | string }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

// ─── screen ───────────────────────────────────────────────────────────────────

export default function ResearchSyncScreen() {
  const [status, setStatus] = useState<ResearchSyncStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<ResearchSyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [gicsUnreachable, setGicsUnreachable] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatusLoading(true);
      const data = await getResearchSyncStatus();
      setStatus(data);
    } catch {
      // Non-fatal — the sync button still works even if status can't load
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncError(null);
    setGicsUnreachable(false);
    setSyncResult(null);
    try {
      const result = await triggerResearchSync();
      setSyncResult(result);
      await loadStatus();
    } catch (err: unknown) {
      const axErr = err as { response?: { status?: number; data?: { message?: string; error?: string } }; message?: string };
      if (axErr.response?.status === 502) {
        setGicsUnreachable(true);
      } else if (axErr.response?.status === 403) {
        setSyncError(axErr.response.data?.message || 'Researcher access only');
      } else {
        setSyncError(axErr.response?.data?.error || axErr.message || 'Sync failed');
      }
    } finally {
      setSyncing(false);
    }
  }, [loadStatus]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Sync Consent Status' }} />
      <ScrollView contentContainerStyle={styles.content}>

        {/* ── Last synced badge ── */}
        <Card variant="outlined" padding="medium" style={styles.statusCard}>
          {statusLoading ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <>
              <Text style={styles.statusHeadline}>
                {formatStaleness(status?.stale_minutes ?? null)}
              </Text>
              {status?.last_synced_at && (
                <Text style={styles.statusSub}>
                  {formatDate(status.last_synced_at)} · by {status.synced_by ?? 'unknown'}
                </Text>
              )}
              {status?.error_count != null && status.error_count > 0 && (
                <Text style={styles.statusWarning}>
                  ⚠️ {status.error_count} patient(s) failed to sync last time
                </Text>
              )}
            </>
          )}
        </Card>

        {/* ── Sync button ── */}
        <TouchableOpacity
          style={[styles.syncButton, syncing && styles.syncButtonDisabled]}
          onPress={handleSync}
          disabled={syncing}
          activeOpacity={0.85}
        >
          {syncing
            ? <ActivityIndicator color={colors.text.inverse} />
            : <Text style={styles.syncButtonText}>🔄  Sync Now</Text>}
        </TouchableOpacity>
        {syncing && (
          <Text style={styles.syncingHint}>
            This can take a few seconds — refreshing eligibility and mirroring vitals for every eligible patient.
          </Text>
        )}

        {/* ── gICS unreachable ── */}
        {gicsUnreachable && (
          <Card variant="filled" padding="medium" style={styles.errorCard}>
            <Text style={styles.errorTitle}>🔌 gICS service unreachable</Text>
            <Text style={styles.errorBody}>
              The sync could not run — gICS is the source of truth for research
              consent and must be reachable to proceed. Try again shortly.
            </Text>
          </Card>
        )}

        {/* ── generic error ── */}
        {syncError && !gicsUnreachable && (
          <Card variant="filled" padding="medium" style={styles.errorCard}>
            <Text style={styles.errorTitle}>⚠️ Sync failed</Text>
            <Text style={styles.errorBody}>{syncError}</Text>
          </Card>
        )}

        {/* ── result summary ── */}
        {syncResult && (
          <Card variant="elevated" padding="medium" style={styles.resultCard}>
            <Text style={styles.resultTitle}>
              ✅ Sync complete · {syncResult.duration_seconds.toFixed(1)}s
            </Text>

            <StatRow label="Total patients" value={syncResult.total_patients} />
            <StatRow label="Newly eligible" value={syncResult.newly_eligible} />
            <StatRow label="Newly ineligible" value={syncResult.newly_ineligible} />
            <StatRow label="Unchanged" value={syncResult.unchanged} />
            <View style={styles.statDivider} />
            <StatRow label="Vitals mirrored" value={syncResult.vitals_mirrored} />
            <StatRow label="Vitals considered" value={syncResult.vitals_considered} />

            {syncResult.no_pseudonym_count > 0 && (
              <View style={styles.calloutBox}>
                <Text style={styles.calloutText}>
                  ℹ️ {syncResult.no_pseudonym_count} eligible patient(s) have no
                  pseudonym yet — mirroring was skipped for them this run. See
                  Sync Issues for the persistent view.
                </Text>
              </View>
            )}

            {syncResult.error_count > 0 && (
              <View style={styles.partialBox}>
                <Text style={styles.partialTitle}>
                  ⚠️ Partial success — {syncResult.error_count} patient(s) failed
                </Text>
                {syncResult.errors.map((e, i) => (
                  <Text key={`${e.patient_id}-${i}`} style={styles.partialErrorLine}>
                    • {e.patient_id}: {e.gics_error}
                  </Text>
                ))}
              </View>
            )}
          </Card>
        )}

      </ScrollView>
    </SafeAreaView>
  );
}

// ─── styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: 40 },

  statusCard: { alignItems: 'center' },
  statusHeadline: { ...typography.h3, color: colors.text.primary },
  statusSub: { ...typography.caption, color: colors.text.secondary, marginTop: 4 },
  statusWarning: { ...typography.caption, color: colors.warningDark, marginTop: spacing.sm, textAlign: 'center' },

  syncButton: {
    height: 56,
    backgroundColor: colors.primary,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  syncButtonDisabled: { opacity: 0.65 },
  syncButtonText: { ...typography.button, color: colors.text.inverse },
  syncingHint: { ...typography.caption, color: colors.text.secondary, textAlign: 'center' },

  errorCard: { backgroundColor: colors.dangerLight + '22', borderLeftWidth: 4, borderLeftColor: colors.danger },
  errorTitle: { ...typography.body, fontWeight: '700', color: colors.dangerDark, marginBottom: 4 },
  errorBody: { ...typography.caption, color: colors.text.secondary, lineHeight: 20 },

  resultCard: { gap: spacing.xs },
  resultTitle: { ...typography.body, fontWeight: '700', color: colors.successDark, marginBottom: spacing.xs },

  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  statLabel: { ...typography.caption, color: colors.text.secondary },
  statValue: { ...typography.caption, fontWeight: '700', color: colors.text.primary },
  statDivider: { height: 1, backgroundColor: colors.divider, marginVertical: spacing.xs },

  calloutBox: {
    backgroundColor: colors.secondary + '15',
    borderRadius: borderRadius.sm,
    padding: spacing.sm,
    marginTop: spacing.sm,
  },
  calloutText: { ...typography.caption, color: colors.secondaryDark, lineHeight: 18 },

  partialBox: {
    backgroundColor: colors.warningLight + '25',
    borderRadius: borderRadius.sm,
    padding: spacing.sm,
    marginTop: spacing.sm,
    gap: 4,
  },
  partialTitle: { ...typography.caption, fontWeight: '700', color: colors.warningDark },
  partialErrorLine: { ...typography.small, color: colors.text.secondary },
});
