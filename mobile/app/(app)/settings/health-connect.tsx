/**
 * health-connect.tsx — Health Connect Settings & Status Screen
 * Location: mobile/app/(app)/settings/health-connect.tsx
 *
 * ── FIXES in this version ────────────────────────────────────────────────────
 *
 * FIX 1 — Time range selector (24h / 7d / 30d)
 *   The previous hardcoded sync(24) call was the primary reason syncs returned
 *   no data. Users now pick a window; default is 7 days (168h) which matches
 *   the new DEFAULT_SYNC_HOURS_BACK constant in useHealthConnect.ts.
 *
 * FIX 2 — Auto-sync banner
 *   When the hook auto-syncs after permission grant (see useHealthConnect FIX 4),
 *   the sync button shows its spinner and the user sees real-time progress
 *   without needing to tap a second button.
 *
 * FIX 3 — Mapper bug warning surfaced in UI
 *   If the hook detects "records came back but 0 observations produced" it sets
 *   an error message. The error banner now shows this clearly so users can
 *   report it rather than assuming "no data".
 *
 * FIX 4 — Preferred-source picker (cross-source duplicate/overlap fix)
 *   Samsung Health, Google Fit, and Health Sync can all write overlapping
 *   heart-rate/steps data into Health Connect for the same time windows.
 *   useHealthConnect.ts now filters by metadata.dataOrigin before syncing —
 *   this adds the UI for choosing/reviewing that preference per data type.
 *   Tied to the logged-in patient (persisted in health-connect.store.ts), so
 *   it's safe on a shared device.
 *
 * FIX 5 — Debug card collapsed by default + guaranteed-readable colors
 *   Previously the debug card rendered fully expanded the instant debugInfo
 *   was set (i.e. right after every sync), dumping a wall of monospace text
 *   into the middle of the screen. It's now collapsed behind a tap-to-expand
 *   header, closed by default, and stays closed across re-syncs unless the
 *   tester opens it.
 *   The debug text/background also no longer reads off the shared `colors`
 *   theme object — `colors.text?.primary` was resolving to a dark color
 *   against the dark card background, making it unreadable. The debug card
 *   now uses explicit, hardcoded high-contrast colors (light text on a
 *   near-black background) so it's readable regardless of what the active
 *   theme's `colors.text.primary` happens to resolve to.
 *
 * UNCHANGED: hooks-before-returns rule, isPermanentlyDenied settings button,
 *   delete confirmation flow, GDPR section.
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
import { useHealthConnect, DEFAULT_SYNC_HOURS_BACK } from '@/hooks/useHealthConnect';
import { deleteHealthConnectData } from '@/services/api/health-connect';
import { timeAgo, formatDate, HC_KNOWN_ORIGINS } from '@/types/health-connect.types';

// ─── Constants ────────────────────────────────────────────────────────────────

const HC_GREEN = '#3ddc84';
const HC_BLUE  = '#1a73e8';
const DANGER   = '#ef4444';

// FIX 5: hardcoded (not theme-derived) colors for the debug card only, so
// it's guaranteed readable regardless of what colors.text.primary resolves
// to under the active theme. This card is TEMP DEBUG scaffolding anyway —
// it's meant to be removed once the empty-sync root cause work is done, so
// it deliberately doesn't participate in theming.
const DEBUG_BG     = '#11141c';
const DEBUG_BORDER = '#2a2d3a';
const DEBUG_TEXT   = '#e5e9f0';
const DEBUG_HEADER = '#f8fafc';

// ─── Time range options ───────────────────────────────────────────────────────

const SYNC_WINDOWS = [
  { label: '24 Std.',  hours: 24  },
  { label: '7 Tage',  hours: 168 },
  { label: '30 Tage', hours: 720 },
] as const;

// ─── Origin (source-app) options ───────────────────────────────────────────────
//
// FIX 4: the three apps confirmed writing overlapping heart-rate/steps data
// into Health Connect on this project. useHealthConnect.ts filters raw
// records against whichever origin the user picks here per data type.

const ORIGIN_OPTIONS = [
  { label: 'Google Fit',     origin: HC_KNOWN_ORIGINS.GOOGLE_FIT },
  { label: 'Samsung Health', origin: HC_KNOWN_ORIGINS.SAMSUNG_HEALTH },
  { label: 'Health Sync',    origin: HC_KNOWN_ORIGINS.HEALTH_SYNC },
] as const;

const ORIGIN_DATA_TYPES = [
  { key: 'heart_rate', icon: '❤️', label: 'Herzfrequenz' },
  { key: 'steps',      icon: '👣', label: 'Schritte' },
] as const;

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

// ─── Time range picker ────────────────────────────────────────────────────────

function SyncWindowPicker({
  selectedHours,
  onSelect,
  disabled,
}: {
  selectedHours: number;
  onSelect: (hours: number) => void;
  disabled: boolean;
}) {
  return (
    <View style={styles.windowPicker}>
      {SYNC_WINDOWS.map(w => {
        const active = selectedHours === w.hours;
        return (
          <TouchableOpacity
            key={w.hours}
            style={[styles.windowBtn, active && styles.windowBtnActive]}
            onPress={() => onSelect(w.hours)}
            disabled={disabled}
            activeOpacity={0.75}
          >
            <Text style={[styles.windowBtnText, active && styles.windowBtnTextActive]}>
              {w.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ─── Origin (source-app) picker ────────────────────────────────────────────────
//
// FIX 4: one row per data type, each with its own three-way picker, since
// preferredOrigins/setPreferredOrigin from the hook are keyed per data type
// (a future data type could reasonably prefer a different source).

function OriginPicker({
  dataTypeKey,
  icon,
  label,
  selectedOrigin,
  onSelect,
  disabled,
}: {
  dataTypeKey: string;
  icon: string;
  label: string;
  selectedOrigin: string | undefined;
  onSelect: (dataTypeKey: string, origin: string) => void;
  disabled: boolean;
}) {
  return (
    <View style={styles.originRow}>
      <View style={styles.originRowHeader}>
        <Text style={styles.dataTypeIcon}>{icon}</Text>
        <Text style={styles.dataTypeLabel}>{label}</Text>
      </View>
      <View style={styles.windowPicker}>
        {ORIGIN_OPTIONS.map(opt => {
          const active = selectedOrigin === opt.origin;
          return (
            <TouchableOpacity
              key={opt.origin}
              style={[styles.windowBtn, active && styles.windowBtnActive]}
              onPress={() => onSelect(dataTypeKey, opt.origin)}
              disabled={disabled}
              activeOpacity={0.75}
            >
              <Text style={[styles.windowBtnText, active && styles.windowBtnTextActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}



export default function HealthConnectScreen() {
  const [isRefreshing,   setIsRefreshing]   = useState(false);
  const [lastSyncResult, setLastSyncResult] = useState<{ inserted: number; skipped: number } | null>(null);

  // FIX 1: Default to 7 days. User can change it via the picker.
  const [syncHours, setSyncHours] = useState<number>(DEFAULT_SYNC_HOURS_BACK);

  // FIX 5: debug card is collapsed by default and stays collapsed across
  // re-syncs unless the tester explicitly taps it open. This is independent
  // of debugInfo itself (which still refreshes on every sync) — expanding it
  // once doesn't force it open again after the next sync, and collapsing it
  // doesn't clear the underlying debugInfo (use "Löschen" for that).
  const [debugExpanded, setDebugExpanded] = useState(false);

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
    debugInfo,
    clearDebugInfo,
    requestPermission,
    openSettings,
    sync,
    refreshStatus,
    preferredOrigins,
    setPreferredOrigin,
  } = useHealthConnect();

  // ── All hooks MUST be declared before any conditional return ─────────────

  const onRefresh = useCallback(() => {
    setIsRefreshing(true);
    refreshStatus().finally(() => setIsRefreshing(false));
  }, [refreshStatus]);

  const handleRequestPermission = useCallback(async () => {
    await requestPermission();
    // Note: auto-sync is triggered inside the hook via shouldAutoSync ref +
    // useEffect. No need to call sync() here — it will fire on re-render.
  }, [requestPermission]);

  const handleOpenSettings = useCallback(async () => {
    await openSettings();
  }, [openSettings]);

  // FIX 1: handleSync now passes the user-selected syncHours instead of a
  // hardcoded 24. This is the single most impactful fix for empty syncs.
  const handleSync = useCallback(async () => {
    const result = await sync(syncHours);
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
    }
  }, [sync, syncHours]);

  // FIX 4: user picks a preferred source per data type; the hook re-derives
  // preferredOrigins reactively (it's backed by the persisted, per-user
  // health-connect.store.ts), so the next sync uses it immediately.
  const handleSelectOrigin = useCallback((dataTypeKey: string, origin: string) => {
    setPreferredOrigin(dataTypeKey, origin);
  }, [setPreferredOrigin]);

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
            { n: '3', t: 'Die App synchronisiert automatisch — kein zweiter Schritt nötig.' },
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

        {error ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
            {isPermanentlyDenied ? (
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

        {/* FIX 2: Show spinner on permission button while auto-sync is running */}
        <TouchableOpacity
          style={[styles.connectBtn, isSyncing && styles.syncBtnDisabled]}
          onPress={handleRequestPermission}
          disabled={isSyncing}
          activeOpacity={0.85}
        >
          {isSyncing
            ? (
              <View style={styles.syncingRow}>
                <ActivityIndicator color="#0a0a0a" size="small" />
                <Text style={styles.connectBtnText}>Synchronisiere…</Text>
              </View>
            )
            : <Text style={styles.connectBtnText}>🔐  Berechtigung erteilen</Text>
          }
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

      {/* FIX 1: Time range picker — replaces hardcoded 24h window */}
      <SectionLabel>SYNCHRONISATIONSZEITRAUM</SectionLabel>
      <SyncWindowPicker
        selectedHours={syncHours}
        onSelect={setSyncHours}
        disabled={isSyncing}
      />

      <TouchableOpacity
        style={[styles.syncBtn, isSyncing && styles.syncBtnDisabled]}
        onPress={handleSync}
        disabled={isSyncing}
        activeOpacity={0.8}
      >
        {isSyncing
          ? <ActivityIndicator color="#fff" size="small" />
          : <Text style={styles.syncBtnText}>
              ↺  Jetzt synchronisieren ({SYNC_WINDOWS.find(w => w.hours === syncHours)?.label ?? `${syncHours}h`})
            </Text>
        }
      </TouchableOpacity>

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {/* TEMP DEBUG — inline sync diagnostics. Remove this card once the
          empty-sync root cause is confirmed and fixed.
          FIX 5: collapsed by default — tap the header to expand/collapse.
          Uses hardcoded high-contrast colors (not the theme's colors.*)
          so it's always readable regardless of active theme. */}
      {debugInfo ? (
        <>
          <SectionLabel>DEBUG (TEMP)</SectionLabel>
          <View style={styles.debugCard}>
            <TouchableOpacity
              style={styles.debugHeader}
              onPress={() => setDebugExpanded(v => !v)}
              activeOpacity={0.7}
            >
              <Text style={styles.debugHeaderText}>
                {debugExpanded ? '▾' : '▸'}  Sync-Diagnose {debugExpanded ? 'ausblenden' : 'anzeigen'}
              </Text>
            </TouchableOpacity>

            {debugExpanded ? (
              <>
                <Text selectable style={styles.debugText}>
                  {debugInfo}
                </Text>
                <TouchableOpacity
                  style={styles.debugClearBtn}
                  onPress={clearDebugInfo}
                  activeOpacity={0.7}
                >
                  <Text style={styles.debugClearBtnText}>Löschen</Text>
                </TouchableOpacity>
              </>
            ) : null}
          </View>
        </>
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

      {/* FIX 4: preferred-source picker — cross-source duplicate/overlap fix.
          Samsung Health, Google Fit, and Health Sync can all write
          overlapping data for the same time window; this is the per-type
          choice of which one Morafek should treat as canonical. */}
      <SectionLabel>BEVORZUGTE QUELLE</SectionLabel>
      <View style={styles.card}>
        <Text style={styles.originExplainer}>
          Mehrere Apps können dieselbe Messung an Health Connect senden. Wählen
          Sie pro Datentyp, welche Quelle in Ihrer Akte verwendet werden soll —
          Messungen anderer Quellen werden beim Synchronisieren ignoriert.
        </Text>
        {ORIGIN_DATA_TYPES.map((dt, i) => (
          <React.Fragment key={dt.key}>
            {i > 0 && <Divider />}
            <OriginPicker
              dataTypeKey={dt.key}
              icon={dt.icon}
              label={dt.label}
              selectedOrigin={preferredOrigins[dt.key]}
              onSelect={handleSelectOrigin}
              disabled={isSyncing}
            />
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

  // FIX 4: Preferred-source picker styles
  originExplainer: {
    fontSize: 12,
    color: colors.text?.secondary ?? '#94a3b8',
    lineHeight: 17,
    marginBottom: 14,
  },
  originRow: {
    paddingVertical: 4,
  },
  originRowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },

  // FIX 1: Time range picker styles
  windowPicker: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  windowBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border ?? '#2a2d3a',
    backgroundColor: colors.card ?? '#1a1d27',
    alignItems: 'center',
  },
  windowBtnActive: {
    borderColor: HC_GREEN,
    backgroundColor: HC_GREEN + '18',
  },
  windowBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text?.secondary ?? '#94a3b8',
  },
  windowBtnTextActive: {
    color: HC_GREEN,
  },

  // FIX 5: debug card — deliberately hardcoded colors, not theme-derived.
  // colors.text?.primary was resolving to a dark color against the dark
  // card background here, making the previous debugText unreadable.
  debugCard: {
    backgroundColor: DEBUG_BG,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: DEBUG_BORDER,
    padding: spacing.md ?? 16,
    marginBottom: 12,
  },
  debugHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  debugHeaderText: {
    fontSize: 13,
    fontWeight: '700',
    color: DEBUG_HEADER,
  },
  debugText: {
    fontSize: 11,
    lineHeight: 16,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Menlo',
    color: DEBUG_TEXT,
    marginTop: 10,
  },
  debugClearBtn: {
    marginTop: 10,
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: DEBUG_BORDER,
  },
  debugClearBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: DEBUG_TEXT,
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

  syncingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },

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