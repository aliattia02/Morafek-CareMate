/**
 * useHealthConnect.ts — React hook for Health Connect lifecycle management
 * Location: mobile/hooks/useHealthConnect.ts
 *
 * Manages the full Health Connect lifecycle on Android:
 *   1. Check if HC SDK is available on this device
 *   2. Check / request Android system permissions
 *   3. Read records from Health Connect (HR, steps, …)
 *   4. Convert to FHIR Observations via health-connect-mapper.ts
 *   5. POST to Morafek backend via health-connect.ts
 *   6. Return status for the settings UI
 *
 * iOS behaviour:
 *   isSupported = false, all other fields are safe defaults.
 *   iOS HealthKit integration is stubbed here — mark for future implementation.
 *   The hook compiles and runs on iOS without crashing.
 *
 * Usage:
 *   const { isSupported, isPermissionGranted, sync, isSyncing, ... } = useHealthConnect();
 */

import { useState, useEffect, useCallback } from 'react';
import { Platform } from 'react-native';

import {
  getHealthConnectStatus,
  syncHealthConnectData,
} from '@/services/api/health-connect';
import {
  mapAllRecordsToObservations,
  HC_DATA_TYPES,
} from '@/utils/fhir/health-connect-mapper';
import { getPermissionRequests } from '@/utils/fhir/health-connect-mapper';
import type {
  HCRecordCounts,
  HCSyncResponse,
  UseHealthConnectReturn,
} from '@/types/health-connect.types';

// ─── Conditional SDK import ───────────────────────────────────────────────────
//
// react-native-health-connect is an Android-only native module.
// Importing it on iOS will throw a native module not found error.
// We import lazily and only call SDK functions when isAndroid is true.

const isAndroid = Platform.OS === 'android';

// Lazy-loaded references to HC SDK functions (undefined on iOS)
let sdkInitialize: (() => Promise<boolean>) | undefined;
let sdkRequestPermission: ((perms: unknown[]) => Promise<unknown[]>) | undefined;
let sdkReadRecords: ((type: string, opts: unknown) => Promise<{ records: unknown[] }>) | undefined;
let sdkGetSdkStatus: (() => Promise<number>) | undefined;
let SDK_AVAILABLE: number | undefined;

if (isAndroid) {
  // Dynamic require so Metro bundler doesn't try to evaluate on iOS
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const hc = require('react-native-health-connect');
  sdkInitialize        = hc.initialize;
  sdkRequestPermission = hc.requestPermission;
  sdkReadRecords       = hc.readRecords;
  sdkGetSdkStatus      = hc.getSdkStatus;
  SDK_AVAILABLE        = hc.SdkAvailabilityStatus?.SDK_AVAILABLE ?? 3;
}

// ─── Default empty counts ─────────────────────────────────────────────────────

function defaultCounts(): HCRecordCounts {
  return { heart_rate: 0, steps: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useHealthConnect(): UseHealthConnectReturn {
  const [isSupported,        setIsSupported]        = useState(false);
  const [isPermissionGranted, setIsPermissionGranted] = useState(false);
  const [lastSync,            setLastSync]            = useState<string | null>(null);
  const [syncCount,           setSyncCount]           = useState(0);
  const [counts,              setCounts]              = useState<HCRecordCounts>(defaultCounts());
  const [error,               setError]               = useState<string | null>(null);
  const [isSyncing,           setIsSyncing]           = useState(false);
  const [isLoading,           setIsLoading]           = useState(true);

  // ── Initialise SDK and check support ────────────────────────────────────────

  const initSDK = useCallback(async (): Promise<boolean> => {
    if (!isAndroid || !sdkGetSdkStatus || !sdkInitialize) {
      // iOS stub — HealthKit integration is not yet implemented
      setIsSupported(false);
      return false;
    }

    try {
      const status = await sdkGetSdkStatus();
      const available = status === SDK_AVAILABLE;
      setIsSupported(available);
      if (!available) return false;

      const initialised = await sdkInitialize();
      return initialised;
    } catch (e) {
      console.warn('[HC] SDK init failed:', e);
      setIsSupported(false);
      return false;
    }
  }, []);

  // ── Load backend status ──────────────────────────────────────────────────────

  const refreshStatus = useCallback(async () => {
    try {
      const status = await getHealthConnectStatus();
      setLastSync(status.last_sync);
      setCounts(status.counts ?? defaultCounts());
    } catch {
      // Non-fatal — backend may not have any records yet
    }
  }, []);

  // ── Mount: init SDK + fetch backend status ───────────────────────────────────

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

  // ── Request permissions ──────────────────────────────────────────────────────

  const requestPermission = useCallback(async () => {
    setError(null);

    if (!isAndroid || !sdkRequestPermission) {
      // iOS: HealthKit stub — not implemented yet
      setError('Health Connect is only available on Android. iOS HealthKit support is planned for a future release.');
      return;
    }

    try {
      const permissionsToRequest = getPermissionRequests();
      const granted = await sdkRequestPermission(permissionsToRequest);

      // The SDK returns the granted permissions array.
      // We consider all required permissions granted if the returned list
      // is non-empty and covers all record types we need.
      const grantedTypes = new Set(
        (granted as Array<{ recordType: string }>).map(p => p.recordType)
      );
      const requiredTypes = permissionsToRequest.map(p => p.recordType);
      const allGranted = requiredTypes.every(t => grantedTypes.has(t));

      setIsPermissionGranted(allGranted);

      if (!allGranted) {
        const missing = requiredTypes.filter(t => !grantedTypes.has(t));
        setError(`Some permissions were not granted: ${missing.join(', ')}. You can grant them in Android Settings → Apps → Health Connect.`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Permission request failed';
      setError(msg);
      setIsPermissionGranted(false);
    }
  }, []);

  // ── Read records from Health Connect ────────────────────────────────────────

  const readAllRecords = useCallback(async (
    startTime: string,
    endTime: string,
  ): Promise<Partial<Record<keyof typeof HC_DATA_TYPES, unknown[]>>> => {
    if (!isAndroid || !sdkReadRecords) return {};

    const timeRangeFilter = {
      operator: 'between',
      startTime,
      endTime,
    };

    const results: Partial<Record<keyof typeof HC_DATA_TYPES, unknown[]>> = {};

    for (const [dataTypeKey, config] of Object.entries(HC_DATA_TYPES) as [
      keyof typeof HC_DATA_TYPES,
      typeof HC_DATA_TYPES[keyof typeof HC_DATA_TYPES],
    ][]) {
      try {
        const { records } = await sdkReadRecords(config.hcRecord, { timeRangeFilter });
        results[dataTypeKey] = records;
      } catch (e) {
        // If a single type fails (e.g. permission for that type not granted),
        // log and continue rather than aborting the entire sync.
        console.warn(`[HC] Failed to read ${config.hcRecord} records:`, e);
        results[dataTypeKey] = [];
      }
    }

    return results;
  }, []);

  // ── Main sync ────────────────────────────────────────────────────────────────

  /**
   * Read Health Connect records for the past `hoursBack` hours,
   * map to FHIR Observations, and POST to the backend.
   *
   * @param hoursBack - How many hours of history to read (default: 24)
   * @returns Sync response from backend, or null on error
   */
  const sync = useCallback(async (
    hoursBack = 24,
  ): Promise<HCSyncResponse | null> => {
    setError(null);
    setIsSyncing(true);

    try {
      if (!isAndroid) {
        throw new Error('Health Connect is only available on Android.');
      }

      if (!isSupported) {
        throw new Error('Health Connect is not available on this device. Please install the Health Connect app from the Play Store.');
      }

      if (!isPermissionGranted) {
        throw new Error('Health Connect permissions have not been granted. Please tap "Berechtigung erteilen" first.');
      }

      // ── Build time range ─────────────────────────────────────────────────
      const endTime   = new Date().toISOString();
      const startTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

      // ── Read all supported record types from HC ──────────────────────────
      const allRecords = await readAllRecords(startTime, endTime);

      // ── Get patient ID from the JWT stored in the API client ─────────────
      // The mapper needs the patient ID to build subject.reference.
      // We extract it from the stored token using the auth store.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { useAuthStore } = require('@/store/auth.store');
      const patientId: string = useAuthStore.getState()?.user?._id ?? '';

      if (!patientId) {
        throw new Error('Patient ID not available. Please log out and log in again.');
      }

      // ── Map to FHIR Observations ──────────────────────────────────────────
      const observations = mapAllRecordsToObservations(allRecords, patientId);

      if (observations.length === 0) {
        // No records in the time window — still a successful sync
        const emptyResult: HCSyncResponse = {
          message: 'Sync complete — no new records in the selected time range.',
          received: 0,
          inserted: 0,
          skipped: 0,
        };
        // Update last_sync timestamp even for empty syncs
        await refreshStatus();
        return emptyResult;
      }

      // ── POST to backend ───────────────────────────────────────────────────
      const response = await syncHealthConnectData(observations);

      setSyncCount(response.inserted);
      await refreshStatus();

      return response;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Sync failed — unknown error';
      setError(msg);
      return null;
    } finally {
      setIsSyncing(false);
    }
  }, [isAndroid, isSupported, isPermissionGranted, readAllRecords, refreshStatus]);

  return {
    isSupported,
    isPermissionGranted,
    lastSync,
    syncCount,
    counts,
    error,
    isSyncing,
    isLoading,
    requestPermission,
    sync,
    refreshStatus,
  };
}
