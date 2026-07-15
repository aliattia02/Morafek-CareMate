/**
 * useHealthConnect.ts — React hook for Health Connect lifecycle management
 * Location: mobile/hooks/useHealthConnect.ts
 *
 * ── FIXES in this version (builds on previous fixes) ─────────────────────────
 *
 * FIX 6 — Eliminated "first time" flash on screen re-entry
 *
 *   Root cause: isPermissionGranted, isSupported, and isLoading were all local
 *   useState() variables. On every screen unmount/remount they reset to their
 *   initial values (false / false / true), causing:
 *
 *     1. Full-screen spinner (isLoading=true) blocked the entire screen
 *     2. Even though the Zustand store had lastSync + counts from the last sync,
 *        they were hidden behind the spinner
 *     3. After initSDK() + refreshStatus() resolved (~1-2s), the screen appeared
 *        identical to the very first visit — all state looked "fresh"
 *
 *   Fix: isPermissionGranted and isSupported now live in the Zustand store
 *   (see health-connect.store.ts). The hook initialises its local copies from
 *   the store via useState(() => store.getState().field). This gives the screen
 *   the correct initial render immediately, without waiting for initSDK().
 *
 *   isLoading now starts as FALSE when the store already has valid state
 *   (isPermissionGranted=true from a previous session). initSDK() still runs
 *   in the background to verify the cached permission state is still accurate
 *   (the user could have revoked in system settings). If it finds a discrepancy
 *   it updates the store and the screen re-renders — but without ever showing
 *   a full-screen spinner to the user.
 *
 *   If this is the very first launch (store has isPermissionGranted=false,
 *   isSupported=false), isLoading starts true as before — the spinner is
 *   correct on first launch since we don't know anything yet.
 *
 * ALL PREVIOUS FIXES RETAINED:
 *   FIX 1 — Extended default sync window to 168h (7 days)
 *   FIX 2 — Diagnostic logging in readAllRecords (per-type count)
 *   FIX 3 — Diagnostic logging after mapAllRecordsToObservations
 *   FIX 4 — Auto-sync after permission grant (shouldAutoSync ref + useEffect)
 *   FIX 5 — StepsCadence fallback for Samsung/Wear OS devices
 *
 * FIX 8 — Cross-source dataOrigin filtering (Samsung Health / Google Fit /
 *         Health Sync all writing overlapping heart-rate data)
 *
 *   Root cause: Samsung Health, Google Fit, and Health Sync all independently
 *   write heart-rate data into Health Connect for the same time windows.
 *   These are NOT exact duplicates (different granularity/values), so the
 *   deterministic-ID dedup in health-connect-mapper.ts never catches them —
 *   each source's readings hash to a different id and all get synced.
 *
 *   Health Connect's own "Data sources and priority" Settings UI does NOT
 *   help here — that priority only affects HC's internal aggregate queries,
 *   not the raw readRecords() results this hook actually consumes.
 *
 *   Fix: readAllRecords() filters each record by metadata.dataOrigin against
 *   `preferredOrigins`, keeping only records from the preferred source per
 *   data type (default: Google Fit for all types, from
 *   DEFAULT_PREFERRED_ORIGINS) plus any record with no origin tag (fail open
 *   rather than silently dropping real data we can't classify). Records from
 *   non-preferred sources are dropped silently — no debug/log surfacing.
 *
 *   preferredOrigins is a runtime-configurable override (see
 *   preferredOrigins/setPreferredOrigin below), so a future settings screen
 *   can let the user change the preferred source per data type if they
 *   switch primary tracking app/watch.
 *
 * FIX 3 (health-connect.store.ts) — preferredOrigins is tied to the current
 *   patient (useAuthStore's user._id) and persisted via AsyncStorage, not
 *   component-local state. It survives app restarts and — because it's
 *   keyed per user — stays isolated between patients on a shared device.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Platform } from 'react-native';

import {
  getHealthConnectStatus,
  syncHealthConnectData,
} from '@/services/api/health-connect';
import {
  mapAllRecordsToObservations,
  HC_DATA_TYPES,
  getPermissionRequests,
} from '@/utils/fhir/health-connect-mapper';
import type {
  HCRecordCounts,
  HCSyncResponse,
  UseHealthConnectReturn,
  HCOriginPreferences,
} from '@/types/health-connect.types';
import { useHCStatusStore, getPreferredOriginsForUser } from '@/store/health-connect.store';
import { useAuthStore } from '@/store/auth.store';
import { getStoredUserData, getStoredToken } from '@/services/api/auth';

// ─── Conditional SDK import ───────────────────────────────────────────────────

const isAndroid = Platform.OS === 'android';

let sdkInitialize:         (() => Promise<boolean>)                                           | undefined;
let sdkRequestPermission:  ((perms: unknown[]) => Promise<unknown[]>)                         | undefined;
let sdkCheckPermissions:   ((perms: unknown[]) => Promise<unknown[]>)                         | undefined;
let sdkReadRecords:        ((type: string, opts: unknown) => Promise<{ records: unknown[] }>)  | undefined;
let sdkGetSdkStatus:       (() => Promise<number>)                                            | undefined;
let sdkOpenHCSettings:     (() => Promise<void>)                                              | undefined;
let SDK_AVAILABLE:         number | undefined;

if (isAndroid) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const hc = require('react-native-health-connect');
  sdkInitialize        = hc.initialize;
  sdkRequestPermission = hc.requestPermission;
  sdkCheckPermissions  = hc.checkPermissions;
  sdkReadRecords       = hc.readRecords;
  sdkGetSdkStatus      = hc.getSdkStatus;
  sdkOpenHCSettings    = hc.openHealthConnectSettings;
  SDK_AVAILABLE        = hc.SdkAvailabilityStatus?.SDK_AVAILABLE ?? 3;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_SYNC_HOURS_BACK = 168; // 7 days

// ─── Helpers ──────────────────────────────────────────────────────────────────

function defaultCounts(): HCRecordCounts {
  return { heart_rate: 0, steps: 0 };
}

function resolveGrantedSet(
  granted: unknown[],
  permissionsToRequest: Array<{ recordType: string; accessType: string }>,
): boolean {
  const grantedKeys = new Set(
    (granted as Array<{ recordType: string; accessType: string }>).map(
      p => `${p.recordType}:${p.accessType}`,
    ),
  );
  return permissionsToRequest.every(
    p => grantedKeys.has(`${p.recordType}:${p.accessType}`),
  );
}

function getMissingPermissions(
  granted: unknown[],
  permissionsToRequest: Array<{ recordType: string; accessType: string }>,
): string[] {
  const grantedKeys = new Set(
    (granted as Array<{ recordType: string; accessType: string }>).map(
      p => `${p.recordType}:${p.accessType}`,
    ),
  );
  return permissionsToRequest
    .filter(p => !grantedKeys.has(`${p.recordType}:${p.accessType}`))
    .map(p => `${p.recordType} (${p.accessType})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useHealthConnect(): UseHealthConnectReturn {

  // ── FIX 6: Initialise from the Zustand store (not false/false) ───────────
  //
  // useState(() => expr) runs the initialiser function exactly once — on the
  // first render of this component instance. Subsequent renders (and remounts
  // after navigation) read from the store snapshot at the time of that first
  // render, which is the persisted value from the previous session.
  //
  // This means:
  //  • A user who already granted permissions sees the "connected" screen
  //    immediately without any spinner or flash.
  //  • A brand-new user (store has false/false) sees the spinner as before.
  const [isPermissionGranted, setIsPermissionGrantedLocal] = useState(
    () => useHCStatusStore.getState().isPermissionGranted,
  );
  const [isSupported, setIsSupportedLocal] = useState(
    () => useHCStatusStore.getState().isSupported,
  );

  // Helper: keeps local state and the Zustand store in sync in one call.
  const setPermissionGranted = useCallback((granted: boolean) => {
    setIsPermissionGrantedLocal(granted);
    useHCStatusStore.getState().setPermissionGranted(granted);
  }, []);

  const setSupported = useCallback((supported: boolean) => {
    setIsSupportedLocal(supported);
    useHCStatusStore.getState().setSupported(supported);
  }, []);

  const [isPermanentlyDenied, setIsPermanentlyDenied] = useState(false);

  // ── Persistent sync status (survives unmount + app restarts) ─────────────
  const lastSync     = useHCStatusStore(s => s.lastSync);
  const counts       = useHCStatusStore(s => s.counts);
  const syncCount    = useHCStatusStore(s => s.syncCount);
  const setStatus    = useHCStatusStore(s => s.setStatus);
  const setSyncCount = useHCStatusStore(s => s.setSyncCount);

  const [error,    setError]    = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  // TEMP DEBUG — surfaced inline on the screen (not a popup, which was
  // getting clobbered by the screen's own success Alert). Remove once the
  // empty-sync root cause is confirmed and fixed.
  const [debugInfo, setDebugInfo] = useState<string | null>(null);

  // FIX 6: Skip the loading spinner entirely if we already know the device is
  // supported and permissions are granted. initSDK() still runs in the
  // background to verify — but it should not block the UI.
  const alreadyKnown = useHCStatusStore.getState().isPermissionGranted &&
                       useHCStatusStore.getState().isSupported;
  const [isLoading, setIsLoading] = useState(!alreadyKnown);

  const permissionAttemptCount = useRef(0);
  const silentRejectionCount   = useRef(0);
  const shouldAutoSync         = useRef(false);

  // TEMP DEBUG — captures per-type read failures + a raw sample record so
  // the on-screen debug alert in sync() can show them without needing adb.
  // Remove once the empty-sync root cause is confirmed and fixed.
  const lastReadErrors  = useRef<Record<string, string>>({});
  const lastRawSamples  = useRef<Record<string, string>>({});

  // FIX 8 / FIX 3 — preferred dataOrigin per data type, tied to the current
  // patient (not device-wide). Sourced from health-connect.store.ts's
  // preferredOriginsByUser, keyed by useAuthStore's user._id, and persisted
  // via AsyncStorage there — so it survives app restarts AND stays isolated
  // per patient on a shared device.
  const userId = useAuthStore(s => s.user?._id ?? '');
  const preferredOriginsByUser = useHCStatusStore(s => s.preferredOriginsByUser);
  const setPreferredOriginInStore = useHCStatusStore(s => s.setPreferredOrigin);

  const preferredOrigins: HCOriginPreferences = useMemo(
    () => getPreferredOriginsForUser(userId),
    // getPreferredOriginsForUser reads straight from the store's current
    // snapshot; re-derive whenever the map or the active user changes.
    [preferredOriginsByUser, userId],
  );

  const setPreferredOrigin = useCallback((dataType: string, origin: string) => {
    if (!userId) {
      console.warn('[HC] setPreferredOrigin called with no authenticated user — ignored.');
      return;
    }
    setPreferredOriginInStore(userId, dataType, origin);
  }, [userId, setPreferredOriginInStore]);

  // ── Init ─────────────────────────────────────────────────────────────────

  const initSDK = useCallback(async (): Promise<boolean> => {
    if (!isAndroid || !sdkGetSdkStatus || !sdkInitialize) {
      setSupported(false);
      return false;
    }

    try {
      const status    = await sdkGetSdkStatus();
      const available = status === SDK_AVAILABLE;
      setSupported(available);
      if (!available) {
        console.warn('[HC] SDK not available, status code:', status);
        return false;
      }

      const initialised = await sdkInitialize();
      if (!initialised) {
        console.warn('[HC] initialize() returned false — HC provider not ready');
        return false;
      }

      // Background permission verification.
      // Even if the store says isPermissionGranted=true, verify with the SDK
      // because the user could have revoked in system settings between sessions.
      if (sdkCheckPermissions) {
        try {
          const permissionsToRequest = getPermissionRequests();
          const alreadyGranted       = await sdkCheckPermissions(permissionsToRequest);
          const allGranted           = resolveGrantedSet(alreadyGranted as unknown[], permissionsToRequest);
          setPermissionGranted(allGranted);
          if (allGranted) {
            console.log('[HC] permissions already granted from previous session');
          } else {
            console.log('[HC] permissions were revoked or not yet granted');
          }
        } catch (e) {
          console.warn('[HC] checkPermissions failed on mount:', e);
          // Do NOT set to false here — a failed check doesn't mean denial.
          // Keep the stored value to avoid a false "not connected" flash.
        }
      }

      return true;
    } catch (e) {
      console.warn('[HC] SDK init failed:', e);
      setSupported(false);
      return false;
    }
  }, [setSupported, setPermissionGranted]);

  // ── Backend status ────────────────────────────────────────────────────────

  const refreshStatus = useCallback(async () => {
    try {
      const status = await getHealthConnectStatus();
      setStatus(status.last_sync, status.counts ?? defaultCounts());
    } catch {
      // Non-fatal — backend may not have any HC records yet
    }
  }, [setStatus]);

  // ── Mount ─────────────────────────────────────────────────────────────────
  //
  // FIX 6: If alreadyKnown is true (store has valid state), isLoading started
  // as false so the UI rendered immediately. We still run initSDK() +
  // refreshStatus() in the background to verify and update.
  //
  // If alreadyKnown is false (first launch), isLoading started as true and we
  // set it to false only after both calls complete — same behaviour as before.

  useEffect(() => {
    let mounted = true;
    (async () => {
      // Only show the loading state on genuinely unknown first-launch scenarios.
      // alreadyKnown=true → isLoading already false → no spinner → no await block
      if (!alreadyKnown) setIsLoading(true);
      try {
        await initSDK();
        if (mounted) await refreshStatus();
      } finally {
        if (mounted) setIsLoading(false);
      }
    })();
    return () => { mounted = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — run once per mount, not on every dep change

  // ── Open HC Settings ──────────────────────────────────────────────────────

  const openSettings = useCallback(async () => {
    if (!sdkOpenHCSettings) {
      console.warn('[HC] openHealthConnectSettings is not available on this SDK version.');
      return;
    }
    try {
      await sdkOpenHCSettings();
    } catch (e) {
      console.warn('[HC] openHealthConnectSettings failed:', e);
    }
  }, []);

  // ── Request permissions ───────────────────────────────────────────────────

  const requestPermission = useCallback(async () => {
    setError(null);
    setIsPermanentlyDenied(false);

    if (!isAndroid || !sdkRequestPermission) {
      setError(
        'Health Connect ist nur auf Android verfügbar. ' +
        'iOS HealthKit-Unterstützung ist für eine zukünftige Version geplant.',
      );
      return;
    }

    try {
      if (sdkInitialize) {
        const ok = await sdkInitialize();
        if (!ok) {
          console.warn('[HC] re-initialize() returned false before requestPermission');
          setError(
            'Health Connect konnte nicht initialisiert werden. ' +
            'Bitte stellen Sie sicher, dass die Health-Connect-App installiert und aktuell ist.',
          );
          return;
        }
        console.log('[HC] re-initialized successfully');
      }

      const permissionsToRequest = getPermissionRequests();
      const attempt = permissionAttemptCount.current + 1;
      console.log('[HC] requesting permissions (attempt', attempt, '):', JSON.stringify(permissionsToRequest));

      const requestedAt = Date.now();
      const granted = await sdkRequestPermission(permissionsToRequest);
      const elapsed = Date.now() - requestedAt;
      console.log('[HC] sdkRequestPermission resolved in', elapsed, 'ms');

      if (elapsed > 300) {
        permissionAttemptCount.current = attempt;
        silentRejectionCount.current   = 0;
      } else {
        silentRejectionCount.current += 1;
        console.log('[HC] silent rejection #', silentRejectionCount.current, '(elapsed:', elapsed, 'ms)');
      }

      console.log('[HC] granted result:', JSON.stringify(granted));

      const allGranted = resolveGrantedSet(granted as unknown[], permissionsToRequest);
      setPermissionGranted(allGranted); // updates both local state AND store

      if (allGranted) {
        setError(null);
        setIsPermanentlyDenied(false);
        shouldAutoSync.current = true;
        return;
      }

      const emptyResult = (granted as unknown[]).length === 0;

      if (emptyResult) {
        const isSuppressed = silentRejectionCount.current >= 2;
        if (attempt <= 1 && !isSuppressed) {
          setIsPermanentlyDenied(false);
          setError(
            'Der Health-Connect-Dialog wurde geschlossen oder abgebrochen. ' +
            'Tippen Sie erneut auf „Berechtigung erteilen\" und wählen Sie „Alle zulassen\".',
          );
        } else {
          setIsPermanentlyDenied(true);
          setError(
            'Health-Connect-Berechtigungen wurden nicht erteilt. ' +
            'Tippen Sie auf „HC-Einstellungen öffnen\", wählen Sie „Morafek\" ' +
            'und erteilen Sie Herzfrequenz- und Schritte-Berechtigungen manuell.',
          );
        }
      } else {
        const missing = getMissingPermissions(granted as unknown[], permissionsToRequest);
        setIsPermanentlyDenied(false);
        setError(
          `Einige Berechtigungen wurden nicht erteilt: ${missing.join(', ')}. ` +
          'Sie können diese in Einstellungen → Apps → Health Connect gewähren.',
        );
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Berechtigungsanfrage fehlgeschlagen';
      console.error('[HC] requestPermission error:', e);
      setError(msg);
      setPermissionGranted(false);
    }
  }, [setPermissionGranted]);

  // ── Read records ──────────────────────────────────────────────────────────

  const readAllRecords = useCallback(async (
    startTime: string,
    endTime: string,
  ): Promise<Partial<Record<keyof typeof HC_DATA_TYPES, unknown[]>>> => {
    if (!isAndroid || !sdkReadRecords) return {};

    const timeRangeFilter = { operator: 'between', startTime, endTime };
    const results: Partial<Record<keyof typeof HC_DATA_TYPES, unknown[]>> = {};

    // TEMP DEBUG — reset capture state at the start of every read pass
    lastReadErrors.current = {};
    lastRawSamples.current = {};

    console.log('[HC] readAllRecords window:', { startTime, endTime });

    for (const [dataTypeKey, config] of Object.entries(HC_DATA_TYPES) as [
      keyof typeof HC_DATA_TYPES,
      typeof HC_DATA_TYPES[keyof typeof HC_DATA_TYPES],
    ][]) {
      try {
        const { records } = await sdkReadRecords(config.hcRecord, { timeRangeFilter });
        console.log(`[HC] records read: { type: "${dataTypeKey}", hcRecord: "${config.hcRecord}", count: ${records.length} }`);

        // TEMP DEBUG — stash the raw shape of the first record returned by
        // the SDK for this type. This is what reveals field-name mismatches
        // between what the native SDK actually returns and what the mapper
        // (health-connect-mapper.ts) expects, e.g. record.count vs some
        // other field name — the #1 cause of "records read but 0 mapped".
        if (records.length > 0) {
          try {
            lastRawSamples.current[dataTypeKey] = JSON.stringify(records[0]).slice(0, 500);
          } catch {
            lastRawSamples.current[dataTypeKey] = '(unserializable record)';
          }
        } else {
          lastRawSamples.current[dataTypeKey] = '(no records in window)';
        }

        // FIX 5: StepsCadence fallback for Samsung/Wear OS
        let finalRecords = records;
        if (records.length === 0 && config.hcRecord === 'Steps') {
          try {
            const { records: cadenceRecords } = await sdkReadRecords('StepsCadence', { timeRangeFilter });
            if (cadenceRecords.length > 0) {
              console.log(`[HC] StepsCadence fallback: found ${cadenceRecords.length} records`);
              finalRecords = cadenceRecords;
              // TEMP DEBUG — overwrite the sample with the fallback shape so
              // it's visible that this branch was taken, and what shape the
              // cadence record actually has (note: it will NOT have `.count`,
              // which is a separate known bug in buildStepsObservation()).
              try {
                lastRawSamples.current[dataTypeKey] =
                  '[StepsCadence fallback] ' + JSON.stringify(cadenceRecords[0]).slice(0, 460);
              } catch {
                lastRawSamples.current[dataTypeKey] = '[StepsCadence fallback] (unserializable record)';
              }
            }
          } catch (fallbackErr) {
            // StepsCadence not available on this device — not an error
            console.log('[HC] StepsCadence fallback unavailable:', fallbackErr);
          }
        }

        // FIX 8: dataOrigin filtering — discard records from non-preferred
        // sources so genuinely overlapping cross-app data (Samsung Health /
        // Google Fit / Health Sync all writing the same time window) never
        // reaches the mapper. Applied AFTER the StepsCadence fallback above,
        // so it filters whichever record set ended up in finalRecords.
        // Discarded records are dropped silently (no logging/debug capture).
        const preferredOrigin = preferredOrigins[dataTypeKey as string];
        const filteredRecords = preferredOrigin
          ? finalRecords.filter(record => {
              const origin = (record as { metadata?: { dataOrigin?: string } })
                ?.metadata?.dataOrigin;
              // Fail open: keep records with no origin tag rather than
              // silently dropping real data we can't classify.
              return !origin || origin === preferredOrigin;
            })
          : finalRecords;

        results[dataTypeKey] = filteredRecords;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[HC] Failed to read ${config.hcRecord} records:`, e);
        lastReadErrors.current[dataTypeKey] = msg; // TEMP DEBUG
        results[dataTypeKey] = [];
      }
    }

    const summary = Object.fromEntries(
      Object.entries(results).map(([k, v]) => [k, (v as unknown[]).length]),
    );
    console.log('[HC] readAllRecords summary:', JSON.stringify(summary));
    console.log('[HC] readAllRecords raw samples:', JSON.stringify(lastRawSamples.current));

    return results;
  }, [preferredOrigins]);

  // ── Sync ──────────────────────────────────────────────────────────────────

  const sync = useCallback(async (
    hoursBack = DEFAULT_SYNC_HOURS_BACK,
  ): Promise<HCSyncResponse | null> => {
    setError(null);
    setIsSyncing(true);

    try {
      if (!isAndroid) {
        throw new Error('Health Connect ist nur auf Android verfügbar.');
      }
      if (!isSupported) {
        throw new Error(
          'Health Connect ist auf diesem Gerät nicht verfügbar. ' +
          'Bitte installieren Sie die Health-Connect-App aus dem Play Store.',
        );
      }
      if (!isPermissionGranted) {
        throw new Error(
          'Health-Connect-Berechtigungen wurden noch nicht erteilt. ' +
          'Bitte tippen Sie zuerst auf „Berechtigung erteilen\".',
        );
      }

      const endTime   = new Date().toISOString();
      const startTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

      console.log(`[HC] sync starting: last ${hoursBack}h (${startTime} → ${endTime})`);

      const allRecords = await readAllRecords(startTime, endTime);

      // ── Patient ID resolution — three-layer fallback chain ─────────────────
      const storeState = useAuthStore.getState();
      let patientId: string = storeState?.user?._id?.trim() ?? '';

      console.log('[HC:ID] Layer 1 — auth store:', {
        _id:             patientId || '(empty)',
        isAuthenticated: storeState?.isAuthenticated,
        userPresent:     !!storeState?.user,
      });

      if (!patientId) {
        try {
          const storedUser = await getStoredUserData();
          patientId = storedUser?._id?.trim() ?? '';
          console.log('[HC:ID] Layer 2 — secure storage:', {
            dataPresent: !!storedUser,
            _id:         patientId || '(empty)',
          });
        } catch (e) {
          console.warn('[HC:ID] Layer 2 — getStoredUserData() failed:', e);
        }
      }

      if (!patientId) {
        try {
          const token: string | null = await getStoredToken();
          if (token) {
            const base64  = token.split('.')[1];
            const payload = JSON.parse(atob(base64.replace(/-/g, '+').replace(/_/g, '/')));
            patientId = (payload.user_id ?? payload.sub ?? payload.identity ?? '').trim();
            console.log('[HC:ID] Layer 3 — JWT decode:', {
              claims:   Object.keys(payload),
              user_id:  payload.user_id  ?? '(absent)',
              resolved: patientId        || '(empty)',
            });
          }
        } catch (e) {
          console.warn('[HC:ID] Layer 3 — JWT decode failed:', e);
        }
      }

      if (patientId) {
        console.log('[HC:ID] ✓ patientId resolved:', patientId);
      } else {
        console.error('[HC:ID] ✗ All layers failed — user must re-login.');
        throw new Error('Patienten-ID nicht verfügbar. Bitte melden Sie sich ab und erneut an.');
      }

      const observations = mapAllRecordsToObservations(allRecords, patientId);

      const rawCounts = Object.fromEntries(
        Object.entries(allRecords).map(([k, v]) => [k, (v as unknown[]).length]),
      );
      const totalRawRecords = Object.values(allRecords).reduce(
        (sum, arr) => sum + (arr as unknown[]).length, 0,
      );
      console.log(
        `[HC] mapper produced ${observations.length} observations from ${totalRawRecords} raw records`,
      );

      // ── TEMP DEBUG — rendered inline on the screen, not a popup ─────────
      // Remove this whole block once the empty-sync root cause is confirmed.
      // (Alert.alert() was unreliable here because health-connect.tsx's
      // handleSync() fires its own Alert.alert() immediately after sync()
      // resolves, and two Alert.alert() calls back to back on Android
      // silently replace one another.)
      try {
        const mapperBug = totalRawRecords > 0 && observations.length === 0;
        const readErrorsStr = Object.keys(lastReadErrors.current).length > 0
          ? JSON.stringify(lastReadErrors.current)
          : '(none)';

        const debugLines = [
          `Window: last ${hoursBack}h`,
          `  ${startTime}`,
          `  → ${endTime}`,
          ``,
          `isSupported: ${isSupported}  isPermissionGranted: ${isPermissionGranted}`,
          `Patient ID: ${patientId || '(EMPTY — see [HC:ID] logs)'}`,
          ``,
          `Raw record counts (post-origin-filter): ${JSON.stringify(rawCounts)}`,
          `Per-type read errors: ${readErrorsStr}`,
          ``,
          `Sample heart_rate record:`,
          `  ${lastRawSamples.current.heart_rate ?? '(no attempt logged)'}`,
          `Sample steps record:`,
          `  ${lastRawSamples.current.steps ?? '(no attempt logged)'}`,
          ``,
          `Mapped observations: ${observations.length}`,
          mapperBug
            ? `\n⚠️ MAPPER BUG: raw records existed but mapper produced 0 — compare the sample record shape above against health-connect-mapper.ts field names (record.count, sample.beatsPerMinute, sample.time, record.startTime).`
            : '',
        ].filter(Boolean).join('\n');

        console.log('[HC:DEBUG]', debugLines);
        setDebugInfo(debugLines);
      } catch (debugErr) {
        console.warn('[HC:DEBUG] failed to build debug info:', debugErr);
        setDebugInfo(`Failed to build debug info: ${String(debugErr)}`);
      }
      // ── END TEMP DEBUG ───────────────────────────────────────────────────

      if (observations.length === 0) {
        if (totalRawRecords > 0) {
          console.error(
            '[HC] MAPPER BUG DETECTED: SDK returned', totalRawRecords,
            'raw records but mapper produced 0 observations. ' +
            'Check health-connect-mapper.ts field names.',
          );
        }
        const emptyResult: HCSyncResponse = {
          message: 'Synchronisation abgeschlossen — keine neuen Messungen im gewählten Zeitraum.',
          received: 0,
          inserted: 0,
          skipped: 0,
        };
        await refreshStatus();
        return emptyResult;
      }

      console.log(`[HC] POSTing ${observations.length} observations to /api/healthconnect/sync`);
      const response = await syncHealthConnectData(observations);
      console.log('[HC] sync response:', JSON.stringify(response));

      setSyncCount(response.inserted);
      await refreshStatus();
      return response;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Synchronisation fehlgeschlagen — unbekannter Fehler';
      console.error('[HC] sync() caught error:', e);
      setError(msg);
      return null;
    } finally {
      setIsSyncing(false);
    }
  }, [isSupported, isPermissionGranted, readAllRecords, refreshStatus, setSyncCount]);

  // ── Auto-sync after permission grant ─────────────────────────────────────

  useEffect(() => {
    if (isPermissionGranted && shouldAutoSync.current) {
      shouldAutoSync.current = false;
      console.log('[HC] auto-sync triggered after permission grant');
      sync(DEFAULT_SYNC_HOURS_BACK);
    }
  }, [isPermissionGranted, sync]);

  const clearDebugInfo = useCallback(() => setDebugInfo(null), []);

  return {
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
  };
}