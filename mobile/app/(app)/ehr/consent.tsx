/**
 * Consent Screen
 * Location: mobile/app/(app)/ehr/consent.tsx
 *
 * Implements the full consent + pseudonymisation flow:
 *
 *  ACCEPT
 *   • Calls POST /api/consent/accept (gICS → gPAS)
 *   • Receives pseudonymSuffix (last 4 chars); stored in auth store
 *   • Displays "Your data identifier: ****XXXX"
 *
 *  REVOKE
 *   • Shows confirmation dialog before proceeding
 *   • Calls POST /api/consent/revoke (revokes gICS, deletes gPAS, removes MongoDB entry)
 *   • Clears pseudonymSuffix from store → export button auto-disabled
 *
 *  STATUS CHECK (on mount)
 *   • GET /api/consent/status → ACCEPTED | REJECTED | UNKNOWN
 *   • ACCEPTED  → shows pseudonym display + Revoke button
 *   • UNKNOWN   → falls back to GET /api/patient/consent (MongoDB) before deciding
 *   • Otherwise → shows consent form + Accept button
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
  acceptConsent,
  revokeConsent,
  // Legacy — used by the inline pseudonymised export card only
  getLegacyConsentStatus,
  type ConsentStatus,
} from '@/services/api/consent';
import { apiClient } from '@/services/api/client';
import { useAuthStore } from '@/store/auth.store';
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

/** Cross-platform confirmation dialog. */
const showConfirm = (
  title: string,
  message: string,
  onConfirm: () => void,
) => {
  if (Platform.OS === 'web') {
    if (window.confirm(`${title}\n\n${message}`)) onConfirm();
  } else {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Confirm', style: 'destructive', onPress: onConfirm },
    ]);
  }
};

interface FhirBundle {
  resourceType: string;
  type: string;
  entry?: { resource?: { resourceType?: string } }[];
  [key: string]: unknown;
}

// ─── screen ───────────────────────────────────────────────────────────────────

export default function ConsentScreen() {
  // ── store ──────────────────────────────────────────────────────────────────
  const { pseudonymSuffix, setPseudonymSuffix } = useAuthStore();

  // ── consent status (from new gICS endpoint) ────────────────────────────────
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [loading,         setLoading]         = useState(true);
  const [working,         setWorking]         = useState(false);
  const [message,         setMessage]         = useState<string | null>(null);
  const [error,           setError]           = useState<string | null>(null);

  // ── legacy status (for pseudonym_masked / granted_at display) ──────────────
  const [legacyStatus, setLegacyStatus] = useState<ConsentStatus | null>(null);

  // ── pseudonymised export (inline card) ────────────────────────────────────
  const [exporting,    setExporting]    = useState(false);
  const [exportBundle, setExportBundle] = useState<FhirBundle | null>(null);
  const [exportError,  setExportError]  = useState<string | null>(null);

  // ── load consent status on mount ──────────────────────────────────────────
  const loadStatus = useCallback(async () => {
    try {
      setError(null);

      // Primary: query gICS live → ACCEPTED | REJECTED | UNKNOWN
      const { status } = await getConsentStatus();
      let accepted = status === 'ACCEPTED';

      // ── MongoDB fallback ─────────────────────────────────────────────────
      // When gICS returns UNKNOWN (unreachable, or template mismatch in local
      // dev), fall back to GET /api/patient/consent which reads MongoDB
      // directly. MongoDB is the source of truth for the grant flow.
      // We deliberately skip the fallback for REJECTED so an explicit
      // revocation is always respected even when gICS is unreachable.
      if (!accepted && status !== 'REJECTED') {
        try {
          const legacy = await getLegacyConsentStatus();
          if (legacy.status === 'granted') {
            accepted = true;
            setLegacyStatus(legacy); // already fetched — store for display
          }
        } catch {
          // Non-fatal: gICS already told us UNKNOWN; keep accepted = false
        }
      }

      setConsentAccepted(accepted);

      // Load display details (pseudonym_masked / granted_at) when accepted
      // but only if the fallback path above hasn't already populated them.
      if (accepted && !legacyStatus) {
        try {
          const legacy = await getLegacyConsentStatus();
          setLegacyStatus(legacy);
        } catch {
          // Non-fatal — just won't show pseudonym_masked / date
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load consent status');
    } finally {
      setLoading(false);
    }
  }, []); // legacyStatus intentionally excluded — snapshot at mount only

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // ── accept ────────────────────────────────────────────────────────────────
  const handleAccept = async () => {
    try {
      setWorking(true);
      setError(null);
      setMessage(null);
      setExportBundle(null);

      const result = await acceptConsent();

      // Persist only the safe suffix in the store — never the full pseudonym
      setPseudonymSuffix(result.pseudonymSuffix);
      setConsentAccepted(true);
      setMessage(`✓ Consent accepted.\nYour data identifier: ****${result.pseudonymSuffix}`);

      // Refresh legacy status for the details row
      try {
        const legacy = await getLegacyConsentStatus();
        setLegacyStatus(legacy);
      } catch { /* non-fatal */ }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to accept consent');
    } finally {
      setWorking(false);
    }
  };

  // ── revoke ────────────────────────────────────────────────────────────────
  const handleRevokeConfirmed = async () => {
    try {
      setWorking(true);
      setError(null);
      setMessage(null);
      setExportBundle(null);

      await revokeConsent();

      // Clear suffix from store — export button auto-disables
      setPseudonymSuffix(null);
      setConsentAccepted(false);
      setLegacyStatus(null);
      setMessage('Consent revoked. Your pseudonym has been deleted.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to revoke consent');
    } finally {
      setWorking(false);
    }
  };

  const handleRevoke = () => {
    showConfirm(
      'Revoke Consent',
      'This will remove your pseudonym and disable pseudonymized data export. Continue?',
      handleRevokeConfirmed,
    );
  };

  // ── pseudonymised export ──────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    try {
      setExporting(true);
      setExportError(null);
      setExportBundle(null);
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

  // ── derived ───────────────────────────────────────────────────────────────
  const exportEntries  = exportBundle?.entry ?? [];
  const resourceCounts = exportEntries.reduce<Record<string, number>>((acc, e) => {
    const rt = e.resource?.resourceType ?? 'Unknown';
    acc[rt] = (acc[rt] ?? 0) + 1;
    return acc;
  }, {});

  // ── render ────────────────────────────────────────────────────────────────

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
            <View style={[styles.badge, consentAccepted ? styles.badgeSuccess : styles.badgeInactive]}>
              <Text style={[styles.badgeText, consentAccepted ? styles.badgeTextSuccess : styles.badgeTextInactive]}>
                {consentAccepted ? 'Data sharing active' : 'Data sharing inactive'}
              </Text>
            </View>

            {consentAccepted && (
              <View style={styles.details}>
                {/* Show masked pseudonym from legacy endpoint if available */}
                {legacyStatus?.pseudonym_masked && (
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Pseudonym</Text>
                    <Text style={styles.rowValue}>{legacyStatus.pseudonym_masked}</Text>
                  </View>
                )}
                {/* Show suffix from store as fallback / confirmation */}
                {pseudonymSuffix && (
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Identifier</Text>
                    <Text style={[styles.rowValue, styles.identifierText]}>
                      ****{pseudonymSuffix}
                    </Text>
                  </View>
                )}
                {legacyStatus?.granted_at && (
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Granted on</Text>
                    <Text style={styles.rowValue}>{formatDate(legacyStatus.granted_at)}</Text>
                  </View>
                )}
              </View>
            )}

            {consentAccepted ? (
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
                onPress={handleAccept}
                disabled={working}
              >
                {working
                  ? <ActivityIndicator color={colors.text.inverse} />
                  : <Text style={styles.buttonText}>Allow pseudonymised data sharing</Text>}
              </TouchableOpacity>
            )}
          </View>

          {/* ── pseudonymised FHIR export (only when consent accepted) ── */}
          {consentAccepted && (
            <View style={styles.exportCard}>
              <View style={styles.exportHeader}>
                <Text style={styles.exportIcon}>🔐</Text>
                <View style={styles.exportTitleGroup}>
                  <Text style={styles.exportTitle}>Pseudonymised FHIR Export</Text>
                  <Text style={styles.exportSub}>
                    Your full health record with all identifiers replaced by your
                    research pseudonym. Safe to share with research partners.
                  </Text>
                  {pseudonymSuffix && (
                    <Text style={styles.exportIdentifierHint}>
                      Export will use identifier: ****{pseudonymSuffix}
                    </Text>
                  )}
                </View>
              </View>

              {/* export error */}
              {exportError && (
                <View style={styles.exportErrorBox}>
                  <Text style={styles.exportErrorText}>⚠️ {exportError}</Text>
                </View>
              )}

              {/* bundle summary */}
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
  identifierText: {
    fontFamily: 'Courier New',
    fontWeight: '700',
    letterSpacing: 1,
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
  exportIdentifierHint: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: '600',
    marginTop: 6,
    fontFamily: 'Courier New',
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