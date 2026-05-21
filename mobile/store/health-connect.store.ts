/**
 * Health Connect Status Store
 * Location: mobile/store/health-connect.store.ts
 *
 * ── FIXES in this version ────────────────────────────────────────────────────
 *
 * FIX 1 — Added isPermissionGranted + isSupported to the store
 *   Previously these lived only in local useState() inside useHealthConnect.ts.
 *   Because useState() resets on every component unmount, navigating away and
 *   back caused:
 *     - isLoading  → true  (full-screen spinner blocks everything)
 *     - isPermissionGranted → false (renders "not connected" screen momentarily)
 *   Even though the Zustand store still held lastSync/counts, they were hidden
 *   behind the spinner. Moving permission + support status into the store lets
 *   the screen render its correct state immediately on re-entry.
 *
 * FIX 2 — Added zustand/middleware persist with AsyncStorage
 *   Without persist, the store resets on app restart. With persist:
 *     - lastSync, counts, syncCount survive app restarts
 *     - isPermissionGranted survives app restarts → no permission re-check flash
 *     - isSupported survives app restarts → no SDK availability re-check delay
 *   The hook still runs initSDK() + refreshStatus() in the background on mount
 *   to verify the persisted values are still accurate, but the UI renders the
 *   persisted values immediately without waiting.
 *
 * Requires: @react-native-async-storage/async-storage
 *   Already included in most Expo projects. If missing:
 *   npx expo install @react-native-async-storage/async-storage
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { HCRecordCounts } from '@/types/health-connect.types';

interface HCStatusState {
  // ── Sync metadata (populated after sync) ─────────────────────────────────
  lastSync:  string | null;
  counts:    HCRecordCounts;
  syncCount: number;

  // ── Device / permission state ─────────────────────────────────────────────
  // FIX 1: Moved out of local useState so they survive screen unmount/remount.
  // FIX 2: Persisted via AsyncStorage so they survive app restarts.
  isPermissionGranted: boolean;
  isSupported:         boolean;

  // ── Setters ───────────────────────────────────────────────────────────────
  setStatus:            (lastSync: string | null, counts: HCRecordCounts) => void;
  setSyncCount:         (n: number) => void;
  setPermissionGranted: (granted:   boolean) => void;
  setSupported:         (supported: boolean) => void;

  /** Reset everything — used when the user logs out or deletes HC data. */
  reset: () => void;
}

const INITIAL_STATE = {
  lastSync:            null,
  counts:              { heart_rate: 0, steps: 0 } as HCRecordCounts,
  syncCount:           0,
  isPermissionGranted: false,
  isSupported:         false,
};

export const useHCStatusStore = create<HCStatusState>()(
  persist(
    (set) => ({
      ...INITIAL_STATE,

      setStatus:            (lastSync, counts)  => set({ lastSync, counts }),
      setSyncCount:         (syncCount)         => set({ syncCount }),
      setPermissionGranted: (isPermissionGranted) => set({ isPermissionGranted }),
      setSupported:         (isSupported)         => set({ isSupported }),

      reset: () => set(INITIAL_STATE),
    }),
    {
      name:    'hc-status-store',           // AsyncStorage key
      storage: createJSONStorage(() => AsyncStorage),
      // Only persist data fields + device/permission state.
      // Do NOT persist action functions (they are not serialisable).
      partialize: (state) => ({
        lastSync:            state.lastSync,
        counts:              state.counts,
        syncCount:           state.syncCount,
        isPermissionGranted: state.isPermissionGranted,
        isSupported:         state.isSupported,
      }),
    },
  ),
);