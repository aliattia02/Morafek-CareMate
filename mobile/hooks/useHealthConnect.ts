/**
 * useHealthConnect.ts — React hook for Health Connect lifecycle management
 * Location: mobile/hooks/useHealthConnect.ts
 *
 * ── What changed vs previous version ────────────────────────────────────────
 *
 * REMOVED: AppState-based permission re-check fallback
 *
 *   The Old Architecture bug was: ReactActivityDelegateWrapper delivered the
 *   ActivityResultCallback before the HC PermissionsActivity rendered its UI,
 *   so sdkRequestPermission() resolved with [] immediately and the dialog
 *   appeared AFTER the promise had already settled.
 *
 *   The AppState listener was added to work around this: subscribe to the
 *   'active' event so we check permissions after the user returns from the
 *   HC screen.
 *
 *   With New Architecture enabled (newArchEnabled=true), the
 *   ActivityResultRegistry handles the HC result correctly — the promise
 *   properly AWAITS the user's choice before resolving. The AppState
 *   workaround is not only unnecessary but actively harmful:
 *
 *     HC's PermissionsActivity uses isTopActivityTransparent=true, meaning
 *     it renders as a transparent overlay, not a full-screen activity. The
 *     host app (Morafek) never fully goes to 'background', so AppState fires
 *     'change' → 'active' WHILE THE DIALOG IS STILL ON SCREEN. This caused:
 *
 *       1. The checkPermissions() call fires with [] (user hasn't tapped yet)
 *       2. Error state is set to "try again"
 *       3. User taps "try again", launching a second HC dialog on top of the
 *          first one → both dialogs cancel each other → user sees nothing
 *
 * SIMPLIFIED: Denial detection
 *
 *   - [] on attempt 1  → "Dialog may have been dismissed. Try again."
 *   - [] on attempt 2+ → isPermanentlyDenied = true → surface openSettings()
 *
 *   "Permanently denied" in HC terms means Android's
 *   'Don't ask again' was checked, or the system is suppressing the dialog.
 *   In both cases openHealthConnectSettings() is the correct next step.
 *
 * ADDED: Explicit initialize() failure logging to catch silent HC errors
 */

import { useState, useEffect, useCallback, useRef } from 'react';
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
} from '@/types/health-connect.types';
import { useHCStatusStore } from '@/store/health-connect.store';

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
  // Fallback removed: openHealthConnectDataManagement opens Samsung Health's own data panel,
  // not the HC permissions screen. openHealthConnectSettings is correct in react-native-health-connect 3.5.3+.
  sdkOpenHCSettings    = hc.openHealthConnectSettings;
  SDK_AVAILABLE        = hc.SdkAvailabilityStatus?.SDK_AVAILABLE ?? 3;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function defaultCounts(): HCRecordCounts {
  return { heart_rate: 0, steps: 0 };
}

/**
 * Returns true if every requested permission is present in the granted set.
 * Composite key: "HeartRate:read", "Steps:read", etc.
 */
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
  const [isSupported,         setIsSupported]         = useState(false);
  const [isPermissionGranted, setIsPermissionGranted] = useState(false);
  const [isPermanentlyDenied, setIsPermanentlyDenied] = useState(false);
  // ── Persistent status state (survives screen unmount/remount) ─────────────────
  // lastSync, counts, and syncCount live in a Zustand store so navigating
  // away and back doesn't cause a blank-UI flash while refreshStatus() re-runs.
  const lastSync     = useHCStatusStore(s => s.lastSync);
  const counts       = useHCStatusStore(s => s.counts);
  const syncCount    = useHCStatusStore(s => s.syncCount);
  const setStatus    = useHCStatusStore(s => s.setStatus);
  const setSyncCount = useHCStatusStore(s => s.setSyncCount);
  const [error,               setError]               = useState<string | null>(null);
  const [isSyncing,           setIsSyncing]           = useState(false);
  const [isLoading,           setIsLoading]           = useState(true);

  /**
   * How many times the user has tapped "Berechtigung erteilen" and received a
   * genuine user-interaction result (elapsed > 300 ms).
   * Used to decide when to surface openSettings() instead of "try again".
   * A ref so it doesn't trigger re-renders.
   */
  const permissionAttemptCount = useRef(0);

  /**
   * Counts consecutive OS-suppressed (silent) rejections — calls that resolve
   * in < 300 ms with [].  After 2 consecutive silent rejections we surface the
   * HC-settings button, because the dialog is being blocked at the OS level
   * (e.g. Samsung "Needs updating" state) and manual settings navigation is the
   * only path forward.  Reset to 0 on any genuine user interaction.
   */
  const silentRejectionCount = useRef(0);

  // ── Init ─────────────────────────────────────────────────────────────────

  const initSDK = useCallback(async (): Promise<boolean> => {
    if (!isAndroid || !sdkGetSdkStatus || !sdkInitialize) {
      setIsSupported(false);
      return false;
    }

    try {
      const status    = await sdkGetSdkStatus();
      const available = status === SDK_AVAILABLE;
      setIsSupported(available);
      if (!available) {
        console.warn('[HC] SDK not available, status code:', status);
        return false;
      }

      const initialised = await sdkInitialize();
      if (!initialised) {
        console.warn('[HC] initialize() returned false — HC provider not ready');
        return false;
      }

      // Check whether permissions were already granted in a previous session.
      if (sdkCheckPermissions) {
        try {
          const permissionsToRequest = getPermissionRequests();
          const alreadyGranted       = await sdkCheckPermissions(permissionsToRequest);
          const allGranted           = resolveGrantedSet(alreadyGranted as unknown[], permissionsToRequest);
          setIsPermissionGranted(allGranted);
          if (allGranted) {
            console.log('[HC] permissions already granted from previous session');
          }
        } catch (e) {
          console.warn('[HC] checkPermissions failed on mount:', e);
          setIsPermissionGranted(false);
        }
      }

      return true;
    } catch (e) {
      console.warn('[HC] SDK init failed:', e);
      setIsSupported(false);
      return false;
    }
  }, []);

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

  useEffect(() => {
    let mounted = true;
    (async () => {
      setIsLoading(true);
      try {
        await initSDK();
        if (mounted) await refreshStatus();
      } finally {
        if (mounted) setIsLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [initSDK, refreshStatus]);

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
      // Re-initialise before each permission request.
      // The HC provider connection can become stale after backgrounding;
      // a stale connection may cause sdkRequestPermission() to fail silently.
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

      // With New Architecture: this call AWAITS the HC dialog result.
      // The promise resolves only after the user taps Allow/Deny or dismisses.
      //
      // With Old Architecture (newArchEnabled=false):
      // this would have resolved immediately with [] before the dialog renders.
      // That bug is gone; remove this comment once Old Arch support is dropped.
      const requestedAt = Date.now();
      const granted = await sdkRequestPermission(permissionsToRequest);
      const elapsed = Date.now() - requestedAt;
      console.log('[HC] sdkRequestPermission resolved in', elapsed, 'ms');

      // Only count this as a genuine user interaction if the dialog had enough
      // time to be shown. Silent OS rejections (no Google account, corrupted
      // HC grant-times DB, emulator quirks) resolve in < 300 ms. A real user
      // decision — even a quick tap — takes at least a second.
      if (elapsed > 300) {
        permissionAttemptCount.current = attempt;
        silentRejectionCount.current   = 0; // genuine user interaction — reset silent counter
      } else {
        silentRejectionCount.current += 1;
        console.log('[HC] silent rejection #', silentRejectionCount.current, '(elapsed:', elapsed, 'ms)');
      }

      console.log('[HC] granted result:', JSON.stringify(granted));

      const allGranted = resolveGrantedSet(granted as unknown[], permissionsToRequest);
      setIsPermissionGranted(allGranted);

      if (allGranted) {
        // Happy path.
        setError(null);
        setIsPermanentlyDenied(false);
        return;
      }

      const emptyResult = (granted as unknown[]).length === 0;

      if (emptyResult) {
        // The user dismissed the HC dialog, pressed Back, or the dialog was
        // silently suppressed by Android (permanent denial or Samsung's
        // "Needs updating" state blocking the dialog at the OS level).
        //
        // isSuppressed: 2+ consecutive silent rejections (< 300 ms each) with
        //   no genuine user interaction. This means the dialog is being blocked
        //   before it can render — skip straight to openSettings().
        //
        // Attempt 1 (not suppressed): encourage the user to try again.
        // Attempt 2+  OR  isSuppressed: surface the HC settings link.
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
        // Dialog appeared, but only some permissions were granted.
        const missing = getMissingPermissions(
          granted as unknown[],
          permissionsToRequest,
        );
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
      setIsPermissionGranted(false);
    }
  }, []);

  // ── Read records ──────────────────────────────────────────────────────────

  const readAllRecords = useCallback(async (
    startTime: string,
    endTime: string,
  ): Promise<Partial<Record<keyof typeof HC_DATA_TYPES, unknown[]>>> => {
    if (!isAndroid || !sdkReadRecords) return {};

    const timeRangeFilter = { operator: 'between', startTime, endTime };
    const results: Partial<Record<keyof typeof HC_DATA_TYPES, unknown[]>> = {};

    for (const [dataTypeKey, config] of Object.entries(HC_DATA_TYPES) as [
      keyof typeof HC_DATA_TYPES,
      typeof HC_DATA_TYPES[keyof typeof HC_DATA_TYPES],
    ][]) {
      try {
        const { records } = await sdkReadRecords(config.hcRecord, { timeRangeFilter });
        results[dataTypeKey] = records;
      } catch (e) {
        console.warn(`[HC] Failed to read ${config.hcRecord} records:`, e);
        results[dataTypeKey] = [];
      }
    }

    return results;
  }, []);

  // ── Sync ──────────────────────────────────────────────────────────────────

  const sync = useCallback(async (
    hoursBack = 24,
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

      const allRecords = await readAllRecords(startTime, endTime);

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { useAuthStore } = require('@/store/auth.store');
      let patientId: string = useAuthStore.getState()?.user?._id ?? '';

      if (!patientId) {
        // Migration fallback: UserData cached before the _id fix won't have _id.
        // Recover it from the JWT `sub` claim so the user doesn't need to re-login.
        try {
          const { getStoredToken } = require('@/services/api/auth');
          const token: string | null = await getStoredToken();
          if (token) {
            const base64  = token.split('.')[1];
            const payload = JSON.parse(atob(base64.replace(/-/g, '+').replace(/_/g, '/')));
            patientId     = (payload.sub ?? payload.identity ?? '') as string;
            console.log('[HC] _id recovered from JWT fallback:', patientId || '(empty)');
          }
        } catch (e) {
          console.warn('[HC] JWT _id fallback failed:', e);
        }
      }

      if (!patientId) {
        throw new Error('Patienten-ID nicht verfügbar. Bitte melden Sie sich ab und erneut an.');
      }

      const observations = mapAllRecordsToObservations(allRecords, patientId);

      if (observations.length === 0) {
        const emptyResult: HCSyncResponse = {
          message: 'Synchronisation abgeschlossen — keine neuen Messungen im gewählten Zeitraum.',
          received: 0,
          inserted: 0,
          skipped: 0,
        };
        await refreshStatus();
        return emptyResult;
      }

      const response = await syncHealthConnectData(observations);
      setSyncCount(response.inserted);
      await refreshStatus();
      return response;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Synchronisation fehlgeschlagen — unbekannter Fehler';
      setError(msg);
      return null;
    } finally {
      setIsSyncing(false);
    }
  }, [isSupported, isPermissionGranted, readAllRecords, refreshStatus]);

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
    requestPermission,
    openSettings,
    sync,
    refreshStatus,
  };
}