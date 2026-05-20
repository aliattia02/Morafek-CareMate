/**
 * Consent Screen
 * Location: mobile/app/(app)/ehr/consent.tsx
 *
 * Implements the full consent + pseudonymisation flow:
 *
 *  ON MOUNT
 *   • GET /api/consent/status → ACCEPTED | REJECTED | UNKNOWN
 *   • If ACCEPTED:   load pseudonymSuffix from local storage → populate store
 *   • If UNKNOWN:    fall back to GET /api/patient/consent (MongoDB)
 *   • If REJECTED:   show grant form; local pseudonym is cleared
 *
 *  ACCEPT
 *   • POST /api/consent/accept (gICS → gPAS)
 *   • Backend is idempotent: returns same suffix if pseudonym already exists
 *   • Suffix saved to AsyncStorage + auth store
 *   • Pseudonymised export card becomes visible
 *
 *  REVOKE
 *   • Confirmation dialog
 *   • POST /api/consent/revoke
 *   • Clears suffix from AsyncStorage + store → export card auto-hidden
 *
 *  PSEUDONYMISED EXPORT  (this card — consent required)
 *   • GET /api/patient/fhir-export/pseudonymised
 *   • Only shown when consentAccepted === true
 *
 *  STANDARD FHIR EXPORT  → see fhir-export.tsx (always available)
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
  getLegacyConsentStatus,
  getLocalPseudonymSuffix,
  getLocalPseudonymGrantedAt,
  fetchPseudonymisedBundle,
  type ConsentStatus,
} from '@/services/api/consent';
import { useAuthStore } from '@/store/auth.store';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// ─── helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch {
    return iso;
  }
}

const showConfirm = (title: string, message: string, onConfirm: () => void) => {
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

  // ── consent state ──────────────────────────────────────────────────────────
  const [consentAccepted,  setConsentAccepted]  = useState(false);
  const [loading,          setLoading]          = useState(true);
  const [working,          setWorking]          = useState(false);
  const [message,          setMessage]          = useState<string | null>(null);
  const [error,            setError]            = useState<string | null>(null);

  // ── legacy details (pseudonym_masked, granted_at) ─────────────────────────
  const [legacyStatus, setLegacyStatus] = useState<ConsentStatus | null>(null);

  // ── local-storage snapshot (shown on the card when server data unavailable) ─
  const [localGrantedAt, setLocalGrantedAt] = useState<string | null>(null);

  // ── pseudonymised export state ─────────────────────────────────────────────
  const [exporting,    setExporting]    = useState(false);
  const [exportBundle, setExportBundle] = useState<FhirBundle | null>(null);
  const [exportError,  setExportError]  = useState<string | null>(null);

  // ── load consent status + restore local pseudonym ─────────────────────────
  const loadStatus = useCallback(async () => {
    try {
      setError(null);

      // ── 1. Restore locally-persisted pseudonym suffix ─────────────────────
      // This is the key fix for the "app restart loses pseudonym" bug.
      // If the suffix is in AsyncStorage but not in the in-memory store,
      // rehydrate the store immediately so the export button stays active.
      const storedSuffix = await getLocalPseudonymSuffix();
      const storedAt     = await getLocalPseudonymGrantedAt();
      if (storedSuffix && !pseudonymSuffix) {
        setPseudonymSuffix(storedSuffix);
      }
      if (storedAt) {
        setLocalGrantedAt(storedAt);
      }

      // ── 2. Query gICS for live consent status ─────────────────────────────
      const { status } = await getConsentStatus();
      let accepted = status === 'ACCEPTED';

      // ── 3. MongoDB fallback for UNKNOWN (local Docker / template mismatch) ─
      // Skip for REJECTED — an explicit revocation is always honoured even
      // when gICS is unreachable.
      if (!accepted && status !== 'REJECTED') {
        try {
          const legacy = await getLegacyConsentStatus();
          if (legacy.status === 'granted') {
            accepted = true;
            setLegacyStatus(legacy);
          }
        } catch {
          // Non-fatal: gICS already told us UNKNOWN; keep accepted = false
        }
      }

      // ── 4. If gICS says REJECTED, clear any stale local pseudonym ─────────
      if (status === 'REJECTED') {
        setPseudonymSuffix(null);
        // Note: we do NOT call clearLocalPseudonym() here — the user hasn't
        // explicitly revoked via the app.  The revoke handler clears storage.
      }

      setConsentAccepted(accepted);

      // ── 5. Load display details when accepted ──────────────────────────────
      if (accepted && !legacyStatus) {
        try {
          const legacy = await getLegacyConsentStatus();
          setLegacyStatus(legacy);
        } catch {
          // Non-fatal — use local timestamp if legacy endpoint unavailable
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load consent status');
    } finally {
      setLoading(false);
    }
  }, [pseudonymSuffix, setPseudonymSuffix]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // ── accept ────────────────────────────────────────────────────────────────
  const handleAccept = async () => {
    try {
      setWorking(true);
      setError(null);
      setMessage(null);
      setExportBundle(null);

      // acceptConsent() calls POST /api/consent/accept AND saves the suffix
      // to AsyncStorage in one step (see enhanced consent.ts).
      const result = await acceptConsent();

      // Update in-memory store
      setPseudonymSuffix(result.pseudonymSuffix);
      setConsentAccepted(true);
      setLocalGrantedAt(new Date().toISOString());
      setMessage(
        `✓ Consent accepted.\n` +
        `Your data identifier: ****${result.pseudonymSuffix}`
      );

      // Refresh display details
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

      // revokeConsent() calls POST /api/consent/revoke AND clears AsyncStorage.
      await revokeConsent();

      // Clear in-memory state
      setPseudonymSuffix(null);
      setConsentAccepted(false);
      setLegacyStatus(null);
      setLocalGrantedAt(null);
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
      'This will remove your pseudonym from our research systems and ' +
      'disable pseudonymised data export. Your medical records are ' +
      'not affected.\n\nContinue?',
      handleRevokeConfirmed,
    );
  };

  // ── pseudonymised export ──────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    if (!consentAccepted || !pseudonymSuffix) return; // guard
    try {
      setExporting(true);
      setExportError(null);
      setExportBundle(null);
      const data = await fetchPseudonymisedBundle<FhirBundle>();
      setExportBundle(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Export failed';
      // Surface a friendlier message for 403 (consent not active on server)
      setExportError(
        msg.includes('403') || msg.includes('Forbidden')
          ? 'The server could not verify your consent. ' +
            'Please try revoking and re-accepting consent, then export again.'
          : msg,
      );
    } finally {
      setExporting(false);
    }
  }, [consentAccepted, pseudonymSuffix]);

  const handleShare = useCallback(async () => {
    if (!exportBundle) return;
    try {
      await Share.share({
        title:   'CareMate — Pseudonymised FHIR R4 Bundle',
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

  // The displayed suffix: prefer live store value, fall back to legacy masked
  const displaySuffix =
    pseudonymSuffix ??
    (legacyStatus?.pseudonym_masked
      ? legacyStatus.pseudonym_masked.slice(-4)
      : null);

  // Displayed grant date: prefer legacy response, fall back to local timestamp
  const displayGrantedAt =
    legacyStatus?.granted_at ?? localGrantedAt;

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Data Sharing & Consent' }} />

      {loading ? (
        <ActivityIndicator color={colors.primary} size="large" style={styles.loader} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>

          {/* ── error / success banners ── */}
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
            {/* status badge */}
            <View style={[
              styles.badge,
              consentAccepted ? styles.badgeSuccess : styles.badgeInactive,
            ]}>
              <Text style={[
                styles.badgeText,
                consentAccepted ? styles.badgeTextSuccess : styles.badgeTextInactive,
              ]}>
                {consentAccepted ? '🔒 Research consent active' : '○ No active consent'}
              </Text>
            </View>

            {/* details when accepted */}
            {consentAccepted && (
              <View style={styles.details}>
                {displaySuffix && (
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Identifier</Text>
                    <Text style={[styles.rowValue, styles.identifierText]}>
                      ****{displaySuffix}
                    </Text>
                  </View>
                )}
                {displayGrantedAt && (
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Granted</Text>
                    <Text style={styles.rowValue}>{formatDate(displayGrantedAt)}</Text>
                  </View>
                )}
                {legacyStatus?.pseudonym_masked && (
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>Pseudonym</Text>
                    <Text style={[styles.rowValue, styles.identifierText]}>
                      {legacyStatus.pseudonym_masked}
                    </Text>
                  </View>
                )}
              </View>
            )}

            {/* ── info text ── */}
            {!consentAccepted && (
              <Text style={styles.infoText}>
                By accepting, you allow your health data to be pseudonymised and
                shared with approved researchers under German data-protection law
                (DSGVO Art. 9). You can revoke at any time.
              </Text>
            )}

            {/* ── action buttons ── */}
            <View style={styles.buttonRow}>
              {!consentAccepted ? (
                <TouchableOpacity
                  style={[styles.button, styles.grantButton, working && styles.buttonDisabled]}
                  onPress={handleAccept}
                  disabled={working}
                  activeOpacity={0.8}
                >
                  {working
                    ? <ActivityIndicator color={colors.text.inverse} />
                    : <Text style={styles.buttonText}>✓  Accept consent</Text>}
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.button, styles.revokeButton, working && styles.buttonDisabled]}
                  onPress={handleRevoke}
                  disabled={working}
                  activeOpacity={0.8}
                >
                  {working
                    ? <ActivityIndicator color={colors.text.inverse} />
                    : <Text style={styles.buttonText}>✕  Revoke consent</Text>}
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* ── pseudonymised export card (consent required) ── */}
          {consentAccepted && (
            <View style={styles.exportCard}>
              <View style={styles.exportHeader}>
                <Text style={styles.exportIcon}>🔐</Text>
                <View style={styles.exportTitleGroup}>
                  <Text style={styles.exportTitle}>Pseudonymised Research Export</Text>
                  <Text style={styles.exportSub}>
                    FHIR R4 bundle with your identity replaced by a pseudonym.
                    Safe for research use — your name and contact details are never included.
                  </Text>
                  {displaySuffix && (
                    <Text style={styles.exportIdentifierHint}>
                      Identifier: ****{displaySuffix}
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
              {exportBundle && Object.keys(resourceCounts).length > 0 && (
                <View style={styles.summaryBox}>
                  <Text style={styles.summaryTitle}>
                    ✅ Bundle ready · {exportEntries.length} resources
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
                  style={[
                    styles.button,
                    styles.exportButton,
                    exporting && styles.buttonDisabled,
                  ]}
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

          {/* ── info box when no consent ── */}
          {!consentAccepted && (
            <View style={styles.noConsentBox}>
              <Text style={styles.noConsentIcon}>🔓</Text>
              <Text style={styles.noConsentTitle}>Pseudonymised export unavailable</Text>
              <Text style={styles.noConsentBody}>
                Accept consent above to enable pseudonymised research data export.
                Your standard FHIR export (for EHR / KIS integration) is always
                available from the FHIR Export screen.
              </Text>
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
    paddingBottom: 40,
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
  row:               { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
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
  infoText: {
    ...typography.body,
    color: colors.text.secondary,
    lineHeight: 22,
  },
  buttonRow: {
    gap: spacing.sm,
  },

  // ── shared button base ──
  button: {
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
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
    borderTopWidth: 3,
    borderTopColor: colors.primary,
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
    justifyContent: 'center',
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

  // ── no-consent info box ──
  noConsentBox: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    borderLeftColor: colors.divider,
    padding: spacing.md,
    gap: spacing.sm,
    alignItems: 'center',
  },
  noConsentIcon:  { fontSize: 32 },
  noConsentTitle: {
    ...typography.body,
    fontWeight: '700',
    color: colors.text.secondary,
    textAlign: 'center',
  },
  noConsentBody: {
    ...typography.caption,
    color: colors.text.secondary,
    lineHeight: 18,
    textAlign: 'center',
  },
});