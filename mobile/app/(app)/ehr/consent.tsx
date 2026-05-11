/**
 * Consent Screen
 * Location: mobile/app/(app)/ehr/consent.tsx
 *
 * Changes:
 *  • When consent is "granted", shows a "Export Pseudonymised FHIR Bundle"
 *    button that calls GET /api/patient/fhir-export/pseudonymised (dedicated
 *    research-safe endpoint — all PII stripped, only pseudonym in identifier).
 *    The backend builds the Patient resource from an allowlist so no PII can
 *    leak via future additions to build_fhir_patient().
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  getConsentStatus,
  grantConsent,
  revokeConsent,
  type ConsentStatus,
} from '@/services/api/consent';
import { apiClient } from '@/services/api/client';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

interface FhirBundle {
  resourceType: string;
  type: string;
  entry?: { resource?: { resourceType?: string } }[];
  [key: string]: unknown;
}

// ─── screen ───────────────────────────────────────────────────────────────────

export default function ConsentScreen() {
  const [status,       setStatus]       = useState<ConsentStatus | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [working,      setWorking]      = useState(false);
  const [message,      setMessage]      = useState<string | null>(null);
  const [error,        setError]        = useState<string | null>(null);

  // pseudonymised export state
  const [exporting,    setExporting]    = useState(false);
  const [exportBundle, setExportBundle] = useState<FhirBundle | null>(null);
  const [exportError,  setExportError]  = useState<string | null>(null);

  // ── load consent status ──────────────────────────────────────────────────────
  const loadStatus = useCallback(async () => {
    try {
      setError(null);
      const data = await getConsentStatus();
      setStatus(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load consent status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // ── grant ────────────────────────────────────────────────────────────────────
  const handleGrant = async () => {
    try {
      setWorking(true);
      setError(null);
      setMessage(null);
      setExportBundle(null);
      const result = await grantConsent();
      setMessage(
        result.pseudonym_assigned
          ? 'A pseudonym has been assigned to your data.'
          : 'Consent recorded — pseudonym will be assigned shortly.',
      );
      const refreshed = await getConsentStatus();
      setStatus(refreshed);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to grant consent');
    } finally {
      setWorking(false);
    }
  };

  // ── revoke ───────────────────────────────────────────────────────────────────
  const handleRevoke = async () => {
    try {
      setWorking(true);
      setError(null);
      setMessage(null);
      setExportBundle(null);
      await revokeConsent();
      setMessage('Consent revoked.');
      const refreshed = await getConsentStatus();
      setStatus(refreshed);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to revoke consent');
    } finally {
      setWorking(false);
    }
  };

  // ── pseudonymised export ─────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    try {
      setExporting(true);
      setExportError(null);
      setExportBundle(null);
      // /api/patient/fhir-export already rewrites Patient/<mongo_id> →
      // Patient/<pseudonym> when a gPAS pseudonym is stored for this patient.
      const res = await apiClient.get<FhirBundle>('/api/patient/fhir-export/pseudonymised');
      setExportBundle(res.data);
    } catch (err: unknown) {
      setExportError(err instanceof Error ? err.message : 'Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  }, []);

  const handleShare = useCallback(async () => {
    if (!exportBundle) return;
    try {
      await Share.share({
        title:   'Morafek CareMate — Pseudonymised FHIR R4 Bundle',
        message: JSON.stringify(exportBundle, null, 2),
      });
    } catch {
      Alert.alert('Share failed', 'Could not open the share sheet.');
    }
  }, [exportBundle]);

  // ── derived state ────────────────────────────────────────────────────────────
  const currentStatus = status?.status ?? 'none';
  const isGranted     = currentStatus === 'granted';

  // Count resources in exported bundle for the summary line
  const exportEntries  = exportBundle?.entry ?? [];
  const resourceCounts = exportEntries.reduce<Record<string, number>>((acc, e) => {
    const rt = e.resource?.resourceType ?? 'Unknown';
    acc[rt] = (acc[rt] ?? 0) + 1;
    return acc;
  }, {});

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Data Sharing' }} />

      {loading ? (
        <ActivityIndicator color={colors.primary} size="large" style={styles.loader} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>

          {/* ── feedback banners ── */}
          {error && (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>⚠️ {error}</Text>
            </View>
          )}
          {message && (
            <View style={styles.messageCard}>
              <Text style={styles.messageText}>{message}</Text>
            </View>
          )}

          {/* ── consent status card ── */}
          <View style={styles.card}>
            <View style={[styles.badge, isGranted ? styles.badgeSuccess : styles.badgeInactive]}>
              <Text style={[styles.badgeText, isGranted ? styles.badgeTextSuccess : styles.badgeTextInactive]}>
                {isGranted ? 'Data sharing active' : 'Data sharing inactive'}
              </Text>
            </View>

            {isGranted && (
              <View style={styles.details}>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Pseudonym</Text>
                  <Text style={styles.rowValue}>{status?.pseudonym_masked ?? '—'}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Granted on</Text>
                  <Text style={styles.rowValue}>{formatDate(status?.granted_at)}</Text>
                </View>
              </View>
            )}

            {isGranted ? (
              <TouchableOpacity
                style={[styles.button, styles.revokeButton, working && styles.buttonDisabled]}
                onPress={handleRevoke}
                disabled={working}
              >
                {working
                  ? <ActivityIndicator color={colors.text.inverse} />
                  : <Text style={styles.buttonText}>Revoke consent</Text>}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.button, styles.grantButton, working && styles.buttonDisabled]}
                onPress={handleGrant}
                disabled={working}
              >
                {working
                  ? <ActivityIndicator color={colors.text.inverse} />
                  : <Text style={styles.buttonText}>Allow pseudonymised data sharing</Text>}
              </TouchableOpacity>
            )}
          </View>

          {/* ── pseudonymised FHIR export (only when consent granted) ── */}
          {isGranted && (
            <View style={styles.exportCard}>
              <View style={styles.exportHeader}>
                <Text style={styles.exportIcon}>🔐</Text>
                <View style={styles.exportTitleGroup}>
                  <Text style={styles.exportTitle}>Pseudonymised FHIR Export</Text>
                  <Text style={styles.exportSub}>
                    Your full health record with all identifiers replaced by your
                    research pseudonym. Safe to share with research partners.
                  </Text>
                </View>
              </View>

              {/* export error */}
              {exportError && (
                <View style={styles.exportErrorBox}>
                  <Text style={styles.exportErrorText}>⚠️ {exportError}</Text>
                </View>
              )}

              {/* bundle summary after export */}
              {exportBundle && (
                <View style={styles.summaryBox}>
                  <Text style={styles.summaryTitle}>
                    ✅ {exportEntries.length} resources exported
                  </Text>
                  {Object.entries(resourceCounts).map(([rt, count]) => (
                    <View key={rt} style={styles.summaryRow}>
                      <Text style={styles.summaryRt}>{rt}</Text>
                      <View style={styles.summaryBadge}>
                        <Text style={styles.summaryCount}>{count}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}

              {/* action buttons */}
              {!exportBundle ? (
                <TouchableOpacity
                  style={[styles.button, styles.exportButton, exporting && styles.buttonDisabled]}
                  onPress={handleExport}
                  disabled={exporting}
                  activeOpacity={0.8}
                >
                  {exporting
                    ? <ActivityIndicator color={colors.text.inverse} />
                    : <Text style={styles.buttonText}>⬇️  Export pseudonymised bundle</Text>}
                </TouchableOpacity>
              ) : (
                <View style={styles.postExportRow}>
                  <TouchableOpacity
                    style={[styles.button, styles.shareButton, { flex: 2 }]}
                    onPress={handleShare}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.buttonText}>📤  Share JSON</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.reExportButton, { flex: 1 }]}
                    onPress={handleExport}
                    disabled={exporting}
                    activeOpacity={0.8}
                  >
                    {exporting
                      ? <ActivityIndicator color={colors.primary} />
                      : <Text style={styles.reExportText}>↺  Re-export</Text>}
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}

        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ─── styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loader: {
    flex: 1,
    marginTop: 40,
  },
  content: {
    padding: spacing.md,
    gap: spacing.md,
  },

  // ── feedback banners ──
  errorCard: {
    backgroundColor: colors.dangerLight,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorText: {
    ...typography.body,
    color: colors.danger,
  },
  messageCard: {
    backgroundColor: colors.success + '1A',
    borderRadius: borderRadius.md,
    padding: spacing.md,
    borderLeftWidth: 4,
    borderLeftColor: colors.success,
  },
  messageText: {
    ...typography.body,
    color: colors.successDark,
  },

  // ── consent card ──
  card: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.md,
  },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  badgeSuccess:      { backgroundColor: colors.success + '22' },
  badgeInactive:     { backgroundColor: colors.divider },
  badgeText:         { ...typography.body, fontWeight: '600' },
  badgeTextSuccess:  { color: colors.successDark },
  badgeTextInactive: { color: colors.text.secondary },
  details:           { gap: spacing.sm },
  row:               { flexDirection: 'row', gap: spacing.sm },
  rowLabel: {
    ...typography.caption,
    color: colors.text.secondary,
    width: 96,
  },
  rowValue: {
    ...typography.body,
    color: colors.text.primary,
    flex: 1,
  },

  // ── shared button base ──
  button: {
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.7 },
  buttonText: {
    ...typography.button,
    color: colors.text.inverse,
  },
  grantButton:  { backgroundColor: colors.success },
  revokeButton: { backgroundColor: colors.danger },

  // ── pseudonymised export card ──
  exportCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.md,
  },
  exportHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  exportIcon: { fontSize: 28, lineHeight: 34 },
  exportTitleGroup: { flex: 1 },
  exportTitle: {
    ...typography.body,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: 4,
  },
  exportSub: {
    ...typography.caption,
    color: colors.text.secondary,
    lineHeight: 18,
  },

  exportButton: { backgroundColor: colors.primary },
  shareButton:  { backgroundColor: colors.success },

  postExportRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  reExportButton: {
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  reExportText: {
    ...typography.body,
    color: colors.text.secondary,
  },

  // ── bundle summary ──
  summaryBox: {
    backgroundColor: colors.success + '15',
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.success + '44',
    padding: spacing.sm,
    gap: 6,
  },
  summaryTitle: {
    ...typography.body,
    fontWeight: '700',
    color: colors.successDark,
    marginBottom: 4,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.success + '22',
  },
  summaryRt: {
    ...typography.caption,
    fontFamily: 'Courier New',
    color: colors.text.primary,
  },
  summaryBadge: {
    backgroundColor: colors.success,
    borderRadius: borderRadius.full,
    minWidth: 24,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  summaryCount: {
    ...typography.caption,
    color: colors.text.inverse,
    fontWeight: '700',
  },

  // ── export error ──
  exportErrorBox: {
    backgroundColor: colors.dangerLight,
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    borderLeftWidth: 3,
    borderLeftColor: colors.danger,
  },
  exportErrorText: {
    ...typography.caption,
    color: colors.danger,
  },
});