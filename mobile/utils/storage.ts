/**
 * mobile/utils/storage.ts
 *
 * Secure key-value storage for sensitive data (tokens, user info).
 * Uses expo-secure-store on device (encrypted at rest) with an
 * in-memory fallback for environments where SecureStore is unavailable
 * (e.g. web, Expo Go on some simulators).
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

// ─── Storage keys ─────────────────────────────────────────────────────────────

export const STORAGE_KEYS = {
  AUTH_TOKEN:       'auth_token',
  USER_DATA:        'user_data',
  SHARED_CONSTANTS: 'shared_constants',
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

// ─── In-memory fallback (web / unavailable SecureStore) ───────────────────────

const memoryStore: Record<string, string> = {};

const isSecureStoreAvailable = (): boolean => {
  // SecureStore is not supported on web
  return Platform.OS !== 'web';
};

// ─── secureStorage API ────────────────────────────────────────────────────────

export const secureStorage = {
  /**
   * Persist a string value under the given key.
   * Pass an object — it will be JSON-serialised automatically.
   */
  async set(key: StorageKey, value: string | object): Promise<void> {
    const serialised = typeof value === 'string' ? value : JSON.stringify(value);
    try {
      if (isSecureStoreAvailable()) {
        await SecureStore.setItemAsync(key, serialised);
      } else {
        memoryStore[key] = serialised;
      }
    } catch (err) {
      console.error(`[Storage] set("${key}") failed:`, err);
      // Degrade gracefully — keep value in memory so the session survives
      memoryStore[key] = serialised;
    }
  },

  /**
   * Retrieve the raw string stored under the given key.
   * Returns null if the key does not exist.
   */
  async get(key: StorageKey): Promise<string | null> {
    try {
      if (isSecureStoreAvailable()) {
        return await SecureStore.getItemAsync(key);
      }
      return memoryStore[key] ?? null;
    } catch (err) {
      console.error(`[Storage] get("${key}") failed:`, err);
      return memoryStore[key] ?? null;
    }
  },

  /**
   * Delete the value stored under the given key.
   * Resolves silently if the key does not exist.
   */
  async remove(key: StorageKey): Promise<void> {
    try {
      if (isSecureStoreAvailable()) {
        await SecureStore.deleteItemAsync(key);
      }
      delete memoryStore[key];
    } catch (err) {
      console.error(`[Storage] remove("${key}") failed:`, err);
      delete memoryStore[key];
    }
  },

  /**
   * Remove all known storage keys — useful on full logout.
   */
  async clear(): Promise<void> {
    await Promise.all(
      Object.values(STORAGE_KEYS).map((key) => secureStorage.remove(key as StorageKey))
    );
  },
};

export default secureStorage;