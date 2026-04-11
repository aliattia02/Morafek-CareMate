/**
 * mobile/utils/storage.ts
 *
 * Platform-aware secure storage.
 *
 * Native (iOS / Android): expo-secure-store  — encrypted, OS keychain-backed.
 * Web:                     localStorage       — survives page refresh.
 *                          (expo-secure-store is unavailable / in-memory only on web)
 */

import { Platform } from 'react-native';

// ─── Storage keys ─────────────────────────────────────────────────────────────

export const STORAGE_KEYS = {
  AUTH_TOKEN:       'auth_token',
  USER_DATA:        'user_data',
  SHARED_CONSTANTS: 'shared_constants',
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

// ─── Web localStorage adapter ─────────────────────────────────────────────────

const webStorage = {
  get: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string): void => {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      console.error('[Storage] localStorage.setItem failed:', e);
    }
  },
  remove: (key: string): void => {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

// ─── Native secure store adapter ─────────────────────────────────────────────

// Lazy-load so the web bundle never tries to import the native module.
let SecureStore: typeof import('expo-secure-store') | null = null;
if (Platform.OS !== 'web') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SecureStore = require('expo-secure-store');
}

// ─── Unified API ─────────────────────────────────────────────────────────────

export const secureStorage = {
  /**
   * Retrieve a stored value.
   * Returns `null` if the key does not exist or on any error.
   */
  get: async (key: string): Promise<string | null> => {
    try {
      if (Platform.OS === 'web') {
        return webStorage.get(key);
      }
      return await SecureStore!.getItemAsync(key);
    } catch (e) {
      console.error(`[Storage] get(${key}) failed:`, e);
      return null;
    }
  },

  /**
   * Persist a string value.
   */
  set: async (key: string, value: string): Promise<void> => {
    try {
      if (Platform.OS === 'web') {
        webStorage.set(key, value);
        return;
      }
      await SecureStore!.setItemAsync(key, value);
    } catch (e) {
      console.error(`[Storage] set(${key}) failed:`, e);
    }
  },

  /**
   * Delete a stored value.
   */
  remove: async (key: string): Promise<void> => {
    try {
      if (Platform.OS === 'web') {
        webStorage.remove(key);
        return;
      }
      await SecureStore!.deleteItemAsync(key);
    } catch (e) {
      console.error(`[Storage] remove(${key}) failed:`, e);
    }
  },
};

export default secureStorage;