/**
 * health-connect.tsx — Health Connect Settings & Status Screen
 * Location: mobile/app/(app)/settings/health-connect.tsx
 *
 * FIXES vs previous version:
 *   • All useCallback hooks are declared BEFORE the early iOS return to comply
 *     with the React Rules of Hooks (no conditional hook calls).
 *
 *   • handleOpenSettings is wired to the new openSettings() action exposed
 *     by useHealthConnect. An explicit "HC-Einstellungen öffnen" button now
 *     appears in the error banner when isPermanentlyDenied is true. The
 *     previous version had no such button; the hook silently navigated the
 *     user away automatically, which was both surprising and unhelpful (the
 *     app was not yet listed in HC settings on first install).
 *
 *   • isPermanentlyDenied is consumed from the hook to conditionally render
 *     the settings button only when it is actually actionable.
 */

import React, { useState, useCallback } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors, spacing } from '@/constants/theme';
import { useHealthConnect } from '@/hooks/useHealthConnect';
import { deleteHealthConnectData } from '@/services/api/health-connect';
import { timeAgo, formatDate } from '@/types/health-connect.types';

// ─── Constants ────────────────────────────────────────────────────────────────

const HC_GREEN = '#3ddc84';
const HC_BLUE  = '#1a73e8';
const DANGER   = '#ef4444';

// ─── Small shared components ──────────────────────────────────────────────────

function SectionLabel({ children }: { children: string }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

function Divider() {
  return <View style={styles.divider} />;
}

function InfoRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoKey}>{label}</Text>
      <View style={styles.infoValueCol}>
        <Text style={styles.infoValue}>{value}</Text>
        {sub ? <Text style={styles.infoValueSub}>{sub}</Text> : null}
      </View>
    </View>
  );
}

// ─── iOS fallback ─────────────────────────────────────────────────────────────

function IOSUnsupportedScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={[styles.heroCard, { borderColor: HC_BLUE + '30', backgroundColor: HC_BLUE + '12' }]}>
        <Text style={styles.heroIcon}>💙</Text>
        <Text style={styles.heroTitle}>Health Connect ist Android-exklusiv</Text>
        <Text style={styles.heroSubtitle}>
          Google Health Connect ist nur auf Android-Geräten verfügbar.{'\n\n'}
          iOS-Integration via Apple HealthKit ist für eine zukünftige Version geplant.
        </Text>
      </View>
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function HealthConnectScreen() {
  const [isRefreshing,   setIsRefreshing]   = useState(false);
  const [lastSyncResult, setLastSyncResult] = useState<{ inserted: number; skipped: number } | null>(null);

  const {
    isSupported,
    isPermissionGranted,
    isPermanentlyDenied,
    lastSync,
    syncCount,
    counts,
    error,
    isSyncing,
    isLoading,
    requestPermission,
    openSettings,
    sync,
    refreshStatus,
  } = useHealthConnect();

  // ── All hooks MUST be declared before any conditional return ─────────────
  // Rules of Hooks: hooks must be called in the same order on every render.
  // Platform.OS is a constant, but the linter (and StrictMode) still flag
  // hooks placed after conditional branches.

  const onRefresh = useCallback(() => {
    setIsRefreshing(true);
    refreshStatus().finally(() => setIsRefreshing(false));
  }, [refreshStatus]);

  const handleRequestPermission = useCallback(async () => {
    await requestPermission();
  }, [requestPermission]);

  /**
   * Navigates the user to the Health Connect system settings screen.
   * Only shown when isPermanentlyDenied is true — i.e. when the user has
   * previously tapped "Don't ask again" and the HC dialog will no longer
   * appear automatically.
   */
  const handleOpenSettings = useCallback(async () => {
    await openSettings();
  }, [openSettings]);

  const handleSync = useCallback(async () => {
    const result = await sync(24);
    if (result) {
      setLastSyncResult({ inserted: result.inserted, skipped: result.skipped });
      if (result.inserted > 0) {
        Alert.alert(
          'Synchronisation abgeschlossen',
          `${result.inserted} neue Messung${result.inserted !== 1 ? 'en' : ''} übertragen.` +
          (result.skipped > 0 ? `\n${result.skipped} übersprungen (Duplikate).` : ''),
        );
      } else {
        Alert.alert(
          'Synchronisation abgeschlossen',
          'Keine neuen Messungen im gewählten Zeitraum gefunden.',
        );
      }
    } else if (error) {
      Alert.alert('Synchronisation fehlgeschlagen', error);
    }
  }, [sync, error]);

  const handleDeleteData = useCallback(() => {
    Alert.alert(
      'Health-Connect-Daten löschen',
      'Alle aus Health Connect übertragenen Messungen werden aus Ihrer Akte gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.',
      [
        { text: 'Abbrechen', style: 'cancel' },
        {
          text: 'Löschen',
          style: 'destructive',
          onPress: async () => {
            try {
              const result = await deleteHealthConnectData();
              await refreshStatus();
              Alert.alert(
                'Daten gelöscht',
                `${result.deleted_count} Messung${result.deleted_count !== 1 ? 'en' : ''} gelöscht.`,
              );
            } catch (e: any) {
              Alert.alert('Fehler', e?.response?.data?.error ?? 'Löschen fehlgeschlagen.');
            }
          },
        },
      ],
    );
  }, [refreshStatus]);

  // ── Conditional returns (after all hooks) ────────────────────────────────

  if (Platform.OS === 'ios') {
    return <IOSUnsupportedScreen />;
  }

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={HC_GREEN} />
      </View>
    );
  }

  if (!isSupported) {
    return (
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.heroCard, { borderColor: DANGER + '30', backgroundColor: DANGER + '0d' }]}>
          <Text style={styles.heroIcon}>⚠️</Text>
          <Text style={styles.heroTitle}>Health Connect nicht verfügbar</Text>
          <Text style={styles.heroSubtitle}>
            Dieses Gerät unterstützt Google Health Connect nicht, oder die
            Health-Connect-App ist nicht installiert.{'\n\n'}
            Installieren Sie Health Connect aus dem Google Play Store und
            öffnen Sie diese Seite erneut.
          </Text>
        </View>
      </ScrollView>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Permissions NOT granted
  // ─────────────────────────────────────────────────────────────────────────

  if (!isPermissionGranted) {
    return (
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={HC_GREEN} />
        }
      >
        <View style={[styles.heroCard, { borderColor: HC_GREEN + '40', backgroundColor: HC_GREEN + '12' }]}>
          <Text style={styles.heroIcon}>❤️</Text>
          <Text style={styles.heroTitle}>Health Connect verbinden</Text>
          <Text style={styles.heroSubtitle}>
            Übertragen Sie Herzfrequenz und Schrittzähler-Daten von Ihrer
            Smartwatch automatisch in Ihre elektronische Patientenakte —
            FHIR R4-konform, DSGVO-konform, ohne Cloud-Umweg.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Kompatible Geräte</Text>
          {[
            { icon: '⌚', label: 'Pixel Watch (1, 2, 3)' },
            { icon: '⌚', label: 'Samsung Galaxy Watch (via Health Connect)' },
            { icon: '⌚', label: 'Wear OS (Fossil, Mobvoi, Garmin …)' },
            { icon: '📱', label: 'Fitbit via Health Connect' },
            { icon: '📱', label: 'Jedes Gerät, das an Health Connect sendet' },
          ].map((item, i) => (
            <View key={i} style={styles.deviceRow}>
              <Text style={styles.deviceIcon}>{item.icon}</Text>
              <Text style={styles.deviceLabel}>{item.label}</Text>
            </View>
          ))}
        </View>

        <SectionLabel>SO FUNKTIONIERT ES</SectionLabel>
        <View style={styles.card}>
          {[
            { n: '1', t: 'Tippen Sie auf „Berechtigung erteilen" — Android öffnet den Health-Connect-Dialog.' },
            { n: '2', t: 'Wählen Sie Herzfrequenz und Schritte zum Lesen aus.' },
            { n: '3', t: 'Tippen Sie auf „Jetzt synchronisieren" — Daten werden als FHIR-Observations übertragen.' },
            { n: '4', t: 'Ihr Arzt sieht die Messwerte in Ihrer Patientenakte.' },
          ].map(step => (
            <View key={step.n} style={styles.howRow}>
              <View style={[styles.howBadge, { borderColor: HC_GREEN, backgroundColor: HC_GREEN + '22' }]}>
                <Text style={[styles.howNum, { color: HC_GREEN }]}>{step.n}</Text>
              </View>
              <Text style={styles.howText}>{step.t}</Text>
            </View>
          ))}
        </View>

        {/* ── Error banner with optional "Open HC Settings" button ─────── */}
        {error ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
            {isPermanentlyDenied ? (
              /**
               * Only shown when isPermanentlyDenied is true — i.e. the user
               * tapped "Berechtigung erteilen" at least twice and the HC dialog
               * still did not appear. At this point the OS will not show the
               * dialog again; the user must navigate to HC settings manually.
               *
               * We render a button here rather than calling openSettings()
               * automatically so the user knows exactly what is happening
               * before they are navigated away from the screen.
               */
              <TouchableOpacity
                style={styles.openSettingsBtn}
                onPress={handleOpenSettings}
                activeOpacity={0.8}
              >
                <Text style={styles.openSettingsBtnText}>
                  ⚙️  HC-Einstellungen öffnen
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        <TouchableOpacity
          style={styles.connectBtn}
          onPress={handleRequestPermission}
          activeOpacity={0.85}
        >
          <Text style={styles.connectBtnText}>🔐  Berechtigung erteilen</Text>
        </TouchableOpacity>

        <Text style={styles.footer}>
          Morafek CareMate liest Daten nur lokal vom Gerät.{'\n'}
          Es werden keine Daten an Google-Server gesendet.
        </Text>
      </ScrollView>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Connected
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={HC_GREEN} />
      }
    >
      <View style={styles.card}>
        <View style={styles.statusRow}>
          <View style={styles.connectedDot} />
          <Text style={styles.connectedLabel}>Verbunden</Text>
          <View style={{ flex: 1 }} />
          <View style={[styles.hcBadge, { backgroundColor: HC_GREEN + '18' }]}>
            <Text style={[styles.hcBadgeText, { color: HC_GREEN }]}>HC</Text>
            <Text style={[styles.hcBadgeName, { color: HC_GREEN }]}>Health Connect</Text>
          </View>
        </View>

        <Divider />

        <InfoRow
          label="Letzte Sync."
          value={lastSync ? timeAgo(lastSync) : 'Noch nie'}
          sub={lastSync ? formatDate(lastSync) : undefined}
        />

        {(counts.heart_rate > 0 || counts.steps > 0) && (
          <>
            <Divider />
            <InfoRow
              label="Herzfrequenz"
              value={`${counts.heart_rate} Messung${counts.heart_rate !== 1 ? 'en' : ''}`}
            />
            <InfoRow
              label="Schritte"
              value={`${counts.steps} Eintrag${counts.steps !== 1 ? 'ag' : ''}`}
            />
          </>
        )}

        {lastSyncResult && (
          <View style={styles.syncResultBanner}>
            <Text style={styles.syncResultText}>
              Letzte Sync: {lastSyncResult.inserted} neu
              {lastSyncResult.skipped > 0 ? ` · ${lastSyncResult.skipped} übersprungen` : ''}
            </Text>
          </View>
        )}
      </View>

      <TouchableOpacity
        style={[styles.syncBtn, isSyncing && styles.syncBtnDisabled]}
        onPress={handleSync}
        disabled={isSyncing}
        activeOpacity={0.8}
      >
        {isSyncing
          ? <ActivityIndicator color="#fff" size="small" />
          : <Text style={styles.syncBtnText}>↺  Jetzt synchronisieren (letzte 24 Std.)</Text>
        }
      </TouchableOpacity>

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <SectionLabel>ÜBERTRAGENE DATENTYPEN</SectionLabel>
      <View style={styles.card}>
        {[
          { icon: '❤️', label: 'Herzfrequenz', loinc: '8867-4',  count: counts.heart_rate },
          { icon: '👣', label: 'Schritte',     loinc: '41950-7', count: counts.steps      },
        ].map((item, i) => (
          <React.Fragment key={item.loinc}>
            {i > 0 && <Divider />}
            <View style={styles.dataTypeRow}>
              <Text style={styles.dataTypeIcon}>{item.icon}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.dataTypeLabel}>{item.label}</Text>
                <Text style={styles.dataTypeLoinc}>LOINC {item.loinc}</Text>
              </View>
              <View style={[styles.countBadge, item.count > 0 && styles.countBadgeActive]}>
                <Text style={[styles.countText, item.count > 0 && styles.countTextActive]}>
                  {item.count}
                </Text>
              </View>
            </View>
          </React.Fragment>
        ))}
      </View>

      <SectionLabel>INTEROPERABILITÄT</SectionLabel>
      <View style={styles.card}>
        {[
          { n: '1', t: 'Daten werden als FHIR R4 Observations gespeichert.' },
          { n: '2', t: 'Ihr FHIR-Export enthält alle Health-Connect-Messungen.' },
          { n: '3', t: 'Kompatibel mit ISiK Stage 1 und NUM-ENRICH-Pipelines.' },
          { n: '4', t: 'Keine Daten verlassen das Gerät ohne Ihre Zustimmung.' },
        ].map(step => (
          <View key={step.n} style={styles.howRow}>
            <View style={[styles.howBadge, { borderColor: HC_BLUE, backgroundColor: HC_BLUE + '22' }]}>
              <Text style={[styles.howNum, { color: HC_BLUE }]}>{step.n}</Text>
            </View>
            <Text style={styles.howText}>{step.t}</Text>
          </View>
        ))}
      </View>

      <SectionLabel>DATENSCHUTZ (DSGVO)</SectionLabel>
      <View style={styles.card}>
        <TouchableOpacity
          style={styles.dangerRow}
          onPress={handleDeleteData}
          activeOpacity={0.7}
        >
          <Text style={styles.dangerText}>Health-Connect-Daten löschen</Text>
        </TouchableOpacity>
        <Text style={styles.dangerDesc}>
          Löscht alle aus Health Connect übertragenen Messungen aus Ihrer Akte.
          Die Berechtigung bleibt erhalten — Sie können jederzeit neu synchronisieren.
        </Text>
      </View>

      <Text style={styles.footer}>
        Morafek CareMate liest Daten nur lokal vom Gerät.{'\n'}
        Es werden keine Daten an Google-Server gesendet.{'\n'}
        Ihre Daten verbleiben in der deutschen Morafek-Infrastruktur.
      </Text>
    </ScrollView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.md ?? 16,
    paddingBottom: 48,
    backgroundColor: colors.background,
  },

  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.8,
    color: colors.text?.secondary ?? '#64748b',
    marginTop: 20,
    marginBottom: 6,
    marginLeft: 4,
  },

  card: {
    backgroundColor: colors.card ?? '#1a1d27',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border ?? '#2a2d3a',
    padding: spacing.md ?? 16,
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text?.primary ?? '#f1f5f9',
    marginBottom: 12,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border ?? '#2a2d3a',
    marginVertical: 12,
  },

  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  connectedDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: HC_GREEN,
  },
  connectedLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: HC_GREEN,
  },
  hcBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 5,
  },
  hcBadgeText: { fontSize: 11, fontWeight: '800' },
  hcBadgeName: { fontSize: 12, fontWeight: '600' },

  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  infoKey: {
    fontSize: 13,
    color: colors.text?.secondary ?? '#94a3b8',
    paddingTop: 1,
    minWidth: 90,
  },
  infoValueCol: { flex: 1, alignItems: 'flex-end' },
  infoValue: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text?.primary ?? '#f1f5f9',
    textAlign: 'right',
  },
  infoValueSub: {
    fontSize: 11,
    color: colors.text?.secondary ?? '#94a3b8',
    textAlign: 'right',
    marginTop: 2,
  },

  syncResultBanner: {
    backgroundColor: HC_GREEN + '18',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginTop: 10,
  },
  syncResultText: { fontSize: 12, color: HC_GREEN, fontWeight: '600' },

  errorBanner: {
    backgroundColor: DANGER + '18',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  errorText: { fontSize: 12, color: DANGER, lineHeight: 18 },

  // Button rendered inside the error banner when isPermanentlyDenied is true.
  openSettingsBtn: {
    marginTop: 10,
    backgroundColor: DANGER + '28',
    borderWidth: 1,
    borderColor: DANGER + '60',
    borderRadius: 8,
    paddingVertical: 9,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  openSettingsBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: DANGER,
  },

  syncBtn: {
    backgroundColor: HC_GREEN,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    marginBottom: 12,
  },
  syncBtnDisabled: { opacity: 0.5 },
  syncBtnText: { fontSize: 15, fontWeight: '700', color: '#0a0a0a' },

  dataTypeRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  dataTypeIcon: { fontSize: 20 },
  dataTypeLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text?.primary ?? '#f1f5f9',
  },
  dataTypeLoinc: {
    fontSize: 11,
    color: colors.text?.secondary ?? '#94a3b8',
    marginTop: 2,
    fontFamily: 'monospace',
  },
  countBadge: {
    backgroundColor: colors.border ?? '#2a2d3a',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
    minWidth: 36,
    alignItems: 'center',
  },
  countBadgeActive: { backgroundColor: HC_GREEN + '20' },
  countText: { fontSize: 13, fontWeight: '700', color: colors.text?.secondary ?? '#94a3b8' },
  countTextActive: { color: HC_GREEN },

  howRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 10 },
  howBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  howNum: { fontSize: 11, fontWeight: '700' },
  howText: {
    flex: 1,
    fontSize: 13,
    color: colors.text?.secondary ?? '#94a3b8',
    lineHeight: 18,
  },

  deviceRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
  deviceIcon: { fontSize: 16 },
  deviceLabel: { fontSize: 13, color: colors.text?.secondary ?? '#94a3b8' },

  heroCard: { borderRadius: 16, borderWidth: 1, padding: 20, alignItems: 'center', marginBottom: 16 },
  heroIcon: { fontSize: 36, marginBottom: 10 },
  heroTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.text?.primary ?? '#f1f5f9',
    marginBottom: 8,
    textAlign: 'center',
  },
  heroSubtitle: {
    fontSize: 13,
    color: colors.text?.secondary ?? '#94a3b8',
    textAlign: 'center',
    lineHeight: 19,
  },

  connectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: HC_GREEN,
    borderRadius: 12,
    paddingVertical: 14,
    gap: 10,
    marginBottom: 4,
  },
  connectBtnText: { fontSize: 16, fontWeight: '700', color: '#0a0a0a' },

  dangerRow: { paddingVertical: 2, marginBottom: 6 },
  dangerText: { fontSize: 14, fontWeight: '600', color: DANGER },
  dangerDesc: { fontSize: 12, color: colors.text?.secondary ?? '#94a3b8', lineHeight: 17 },

  footer: {
    fontSize: 11,
    color: colors.text?.secondary ?? '#64748b',
    textAlign: 'center',
    lineHeight: 17,
    marginTop: 8,
    paddingHorizontal: 16,
  },
});