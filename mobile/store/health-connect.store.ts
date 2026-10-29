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
 *
 * FIX 3 — Per-user cross-source origin preference (tied to useAuthStore's
 *         user._id, not device-wide)
 *   Added preferredOriginsByUser + setPreferredOrigin/clearPreferredOrigins/
 *   getPreferredOriginsForUser. Health Connect's dataOrigin filtering
 *   (useHealthConnect.ts readAllRecords) needs a "preferred source per data
 *   type" setting. A single device-wide value would leak across accounts on
 *   a shared device (e.g. a tablet used by more than one patient) — one
 *   patient's "prefer Google Fit" choice must not silently apply to
 *   another's sync. Keying by userId and persisting via the same
 *   AsyncStorage-backed persist() as the rest of this store means each
 *   patient's preference is isolated and survives app restarts, while
 *   staying independent of reset() (see the note above
 *   INITIAL_PREFERRED_ORIGINS_BY_USER) so logging out doesn't erase it.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { HCRecordCounts, HCOriginPreferences } from '@/types/health-connect.types';
import { DEFAULT_PREFERRED_ORIGINS } from '@/types/health-connect.types';

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

  // ── Cross-source origin preference (FIX 8, tied to user) ───────────────────
  // FIX 3 — Keyed by patient _id (from useAuthStore) rather than being a
  // single device-wide value. This is a shared-device / multi-account
  // safeguard: on a tablet used by more than one patient, one patient's
  // "prefer Google Fit" choice must never silently apply to another
  // patient's sync. Each entry is that user's overrides on top of
  // DEFAULT_PREFERRED_ORIGINS (types.ts) — only data types the user has
  // explicitly changed are present here; getPreferredOriginsForUser() below
  // fills in the rest from the defaults.
  preferredOriginsByUser: Record<string, HCOriginPreferences>;

  // ── Setters ───────────────────────────────────────────────────────────────
  setStatus:            (lastSync: string | null, counts: HCRecordCounts) => void;
  setSyncCount:         (n: number) => void;
  setPermissionGranted: (granted:   boolean) => void;
  setSupported:         (supported: boolean) => void;
  /** Override one data type's preferred dataOrigin for a specific user. */
  setPreferredOrigin:   (userId: string, dataType: string, origin: string) => void;
  /** Clear all origin overrides for a specific user (e.g. "reset to default" in settings). */
  clearPreferredOrigins: (userId: string) => void;

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

/**
 * NOTE: preferredOriginsByUser is intentionally NOT part of INITIAL_STATE.
 * reset() calls set(INITIAL_STATE), and Zustand's set() shallow-merges —
 * only the keys present in INITIAL_STATE get overwritten. Keeping
 * preferredOriginsByUser out of it means logging out (which calls reset())
 * does not wipe a patient's source preference; it's still there the next
 * time that same patient logs back in on this device.
 */
const INITIAL_PREFERRED_ORIGINS_BY_USER: Record<string, HCOriginPreferences> = {};

export const useHCStatusStore = create<HCStatusState>()(
  persist(
    (set, get) => ({
      ...INITIAL_STATE,
      preferredOriginsByUser: INITIAL_PREFERRED_ORIGINS_BY_USER,

      setStatus:            (lastSync, counts)  => set({ lastSync, counts }),
      setSyncCount:         (syncCount)         => set({ syncCount }),
      setPermissionGranted: (isPermissionGranted) => set({ isPermissionGranted }),
      setSupported:         (isSupported)         => set({ isSupported }),

      setPreferredOrigin: (userId, dataType, origin) => {
        if (!userId) {
          console.warn('[HCStatusStore] setPreferredOrigin called without a userId — ignored.');
          return;
        }
        const current = get().preferredOriginsByUser;
        set({
          preferredOriginsByUser: {
            ...current,
            [userId]: { ...(current[userId] ?? {}), [dataType]: origin },
          },
        });
      },

      clearPreferredOrigins: (userId) => {
        if (!userId) return;
        const current = { ...get().preferredOriginsByUser };
        delete current[userId];
        set({ preferredOriginsByUser: current });
      },

      reset: () => set(INITIAL_STATE),
    }),
    {
      name:    'hc-status-store',           // AsyncStorage key
      storage: createJSONStorage(() => AsyncStorage),
      // Only persist data fields + device/permission state + per-user
      // origin preferences. Do NOT persist action functions (not serialisable).
      partialize: (state) => ({
        lastSync:               state.lastSync,
        counts:                 state.counts,
        syncCount:              state.syncCount,
        isPermissionGranted:    state.isPermissionGranted,
        isSupported:            state.isSupported,
        preferredOriginsByUser: state.preferredOriginsByUser,
      }),
    },
  ),
);

/**
 * Resolve the effective preferred-origin map for one user: their stored
 * overrides layered on top of DEFAULT_PREFERRED_ORIGINS (types.ts), so a
 * data type the user never touched still resolves to the documented
 * default (Google Fit) rather than being undefined.
 */
export function getPreferredOriginsForUser(userId: string): HCOriginPreferences {
  const overrides = userId
    ? useHCStatusStore.getState().preferredOriginsByUser[userId]
    : undefined;
  return { ...DEFAULT_PREFERRED_ORIGINS, ...(overrides ?? {}) };
}