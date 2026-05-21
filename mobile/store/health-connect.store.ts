/**
 * Health Connect Status Store
 * Location: mobile/store/health-connect.store.ts
 *
 * Persists lastSync, counts, and syncCount across screen navigations.
 * Without this store, every navigation away from the HC screen unmounts
 * the component → local useState is destroyed → blank UI flash on re-entry
 * while refreshStatus() resolves again.
 *
 * Usage in useHealthConnect.ts:
 *   import { useHCStatusStore } from '@/store/health-connect.store';
 */

import { create } from 'zustand';
import type { HCRecordCounts } from '@/types/health-connect.types';

interface HCStatusState {
  lastSync:     string | null;
  counts:       HCRecordCounts;
  syncCount:    number;
  setStatus:    (lastSync: string | null, counts: HCRecordCounts) => void;
  setSyncCount: (n: number) => void;
}

export const useHCStatusStore = create<HCStatusState>((set) => ({
  lastSync:     null,
  counts:       { heart_rate: 0, steps: 0 },
  syncCount:    0,
  setStatus:    (lastSync, counts) => set({ lastSync, counts }),
  setSyncCount: (syncCount)        => set({ syncCount }),
}));
