/**
 * Patient Constants Hook
 * Location: mobile/hooks/usePatientConstants.ts
 *
 * Main Hook: usePatientConstants
 * Description: Hook for accessing patient constants with automatic loading and defaults fallback
 *
 * FIX (doctor guard): Added doctor/admin guard — the hook previously called
 * loadConstants() unconditionally on mount, which hit /api/patient/constants
 * with a doctor token. The hook now skips auto-loading for non-patient accounts.
 *
 * FIX (stale cache): The previous guard included `!constants` which prevented
 * ANY re-fetch once constants were loaded once per session. This caused stale
 * data to persist after a doctor edited patient constants — the Zustand store
 * held the old values and would never refresh. Replaced with a TTL-based
 * staleness check (CONSTANTS_TTL_MS = 5 min) so constants are silently
 * re-fetched after the TTL expires, picking up doctor edits within one session.
 *
 * FIX (AppState foreground refresh): Added AppState listener so constants are
 * re-fetched every time the patient brings the app to foreground. This is the
 * primary fix for the doctor-edits-constants-but-patient-sees-stale-values
 * problem. Previously the only way to see doctor changes was to wait for the
 * 5-minute TTL or restart the app. Now the patient just backgrounds and
 * foregrounds the app (or pulls to refresh on any screen).
 *
 * How it works:
 *   - On 'background'  → lastFetchedAt is reset to 0 (marks cache as stale)
 *   - On 'active'      → TTL check fires immediately (stale = true), so
 *                         loadConstants() is called and the store is updated
 *   - All screens using this hook re-render automatically via Zustand
 */

import { useEffect, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';

// Store
import { usePatientStore } from '@/store/patient.store';
import { useAuthStore } from '@/store/auth.store';

// Constants
import { DEFAULT_PATIENT_CONSTANTS } from '@/constants';

// Types
import type { PatientConstants } from '@/types';

/**
 * How long (ms) cached constants are considered fresh before a silent
 * background re-fetch is triggered. 5 minutes is a reasonable in-session TTL —
 * but the AppState listener resets this to 0 on every background, so in
 * practice the foreground re-fetch always fires regardless of elapsed time.
 */
const CONSTANTS_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Module-level timestamp so the TTL persists across re-renders and tab
 * switches within the same JS session, but resets on full app restart.
 * Also reset to 0 by the AppState listener on every background event so
 * the next foreground always triggers a fresh fetch.
 */
let lastFetchedAt = 0;

export interface UsePatientConstantsResult {
  constants: PatientConstants;
  activeConditions: string[];
  activeMedications: string[];
  medicationSchedules: Record<string, {
    id: string;
    startDate: string;
    endDate: string;
    dailyTimes: string[];
  }>;
  isLoading: boolean;
  error: string | null;

  /** Reload constants from server */
  refresh: () => Promise<void>;
  /** Get a specific constant value */
  getConstant: <K extends keyof PatientConstants>(key: K) => PatientConstants[K];
  /** Update constants */
  updateConstants: (constants: Partial<PatientConstants>) => Promise<void>;
}

/**
 * Hook for accessing patient constants with automatic loading.
 *
 * @param autoLoad - If false, skips the auto-load on mount (default: true).
 *                   index.tsx passes `!isDoctor` so doctors never trigger a load.
 */
export const usePatientConstants = (autoLoad = true): UsePatientConstantsResult => {
  const { user } = useAuthStore();

  const {
    constants,
    activeConditions,
    activeMedications,
    medicationSchedules,
    isLoading,
    error,
    loadConstants,
    updateConstants,
    getConstant,
  } = usePatientStore();

  // Never auto-load for doctor or admin accounts.
  // Doctors have no patient constants — calling /api/patient/constants with a
  // doctor token returns 403.
  const isNonPatient =
    user?.user_type === 'doctor' || user?.user_type === 'admin';

  // ── Initial load / TTL-based refresh ──────────────────────────────────────
  // Load constants on mount if:
  //   1. autoLoad is enabled AND user is a patient
  //   2. AND either: constants have never been loaded, OR they are stale (> TTL)
  useEffect(() => {
    if (!autoLoad || isNonPatient || isLoading) return;

    const isStale   = Date.now() - lastFetchedAt > CONSTANTS_TTL_MS;
    const neverLoaded = !constants;

    if (neverLoaded || isStale) {
      loadConstants().then(() => {
        lastFetchedAt = Date.now();
      });
    }
  }, [autoLoad, isNonPatient, constants, isLoading, loadConstants]);

  // ── AppState foreground listener ───────────────────────────────────────────
  // Every time the app comes to the foreground, reset lastFetchedAt so the
  // TTL check above fires on the next render, triggering a background re-fetch.
  //
  // This is the fix for: doctor updates patient constants → patient opens app
  // → patient sees stale values until TTL expires.
  //
  // With this listener:
  //   background  → lastFetchedAt = 0   (cache marked stale)
  //   foreground  → useEffect fires     (loadConstants called silently)
  //   store updates → all screens re-render via Zustand automatically
  useEffect(() => {
    if (!autoLoad || isNonPatient) return;

    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        // Mark cache stale so the next foreground always re-fetches,
        // no matter how quickly the user switches back.
        lastFetchedAt = 0;
      }

      if (nextState === 'active') {
        // Cache is now stale (we just set it to 0 on background, or it was
        // already expired). Fire a silent refresh so the patient always sees
        // the latest values the doctor may have set while they were away.
        loadConstants().then(() => {
          lastFetchedAt = Date.now();
        }).catch(() => {
          // Silently ignore — stale data is better than a crash
        });
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, [autoLoad, isNonPatient, loadConstants]);

  // ── Manual refresh ─────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    // Guard manual refresh so doctors calling this explicitly are safe
    if (isNonPatient) return;
    await loadConstants();
    lastFetchedAt = Date.now();
  }, [loadConstants, isNonPatient]);

  // Return defaults if constants haven't loaded yet
  const effectiveConstants = constants || DEFAULT_PATIENT_CONSTANTS;

  return {
    constants: effectiveConstants,
    activeConditions,
    activeMedications,
    medicationSchedules,
    isLoading,
    error,
    refresh,
    getConstant: (key) => getConstant(key),
    updateConstants,
  };
};

/**
 * Helper hook for getting insulin to carb ratio
 */
export const useInsulinToCarbRatio = (): number => {
  const { getConstant } = usePatientStore();
  return getConstant('insulin_to_carb_ratio');
};

/**
 * Helper hook for getting correction factor
 */
export const useCorrectionFactor = (): number => {
  const { getConstant } = usePatientStore();
  return getConstant('correction_factor');
};

/**
 * Helper hook for getting target glucose
 */
export const useTargetGlucose = (): number => {
  const { getConstant } = usePatientStore();
  return getConstant('target_glucose');
};

export default usePatientConstants;