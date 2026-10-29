/**
 * Auth Store
 * Location: mobile/store/auth.store.ts
 *
 * Main Store: useAuthStore
 * Description: Zustand store for authentication state management
 *
 * Features:
 * - User login and logout
 * - Token persistence
 * - Authentication state checking
 * - Error handling and clearing
 * - Platform-agnostic storage (web/native)
 * - Pseudonym suffix persistence for consent/export gating
 *
 * Changes in this version:
 *  - `login()` now maps `userData._id` into the user object so
 *    useHealthConnect.sync() can read `useAuthStore.getState().user._id`
 *    without hitting the "Patienten-ID nicht verfügbar" error.
 *  - `checkAuth()` likewise restores `_id` from persisted user data on
 *    app relaunch, so the fix survives session restores as well as fresh logins.
 */

import { create } from 'zustand';

// Services
import authService from '@/services/api/auth';
import type { LoginCredentials } from '@/services/api/auth';

// ─── JWT helper ───────────────────────────────────────────────────────────────

/**
 * Decode a JWT payload without verifying the signature (client-side only).
 * Used exclusively to read the `exp` claim so we can detect expiry before
 * making a network request and avoid a silent 401 loop.
 */
const decodeTokenPayload = (token: string): Record<string, any> | null => {
  try {
    const base64 = token.split('.')[1];
    if (!base64) return null;
    const json = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
};

/**
 * Returns true if the token exists AND its `exp` claim is still in the future.
 * A token without an `exp` claim is treated as non-expiring (valid).
 */
const isTokenValid = (token: string): boolean => {
  const payload = decodeTokenPayload(token);
  if (!payload) return false;
  if (!payload.exp) return true;
  return payload.exp > Math.floor(Date.now() / 1000);
};

// ─────────────────────────────────────────────────────────────────────────────

interface User {
  _id: string;
  username?: string;
  email?: string;
  user_type?: 'patient' | 'doctor' | 'researcher' | 'admin';
  firstName?: string;
  lastName?: string;
  profile_picture_url?: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  sharedConstants: Record<string, any> | null;

  /**
   * Last 4 characters of the patient's gPAS pseudonym.
   * null  → consent not yet accepted (or revoked)
   * string → consent accepted; safe to display in UI as "****XXXX"
   * SECURITY: The full pseudonym is NEVER stored here — only the suffix.
   */
  pseudonymSuffix: string | null;

  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
  updateProfilePicture: (url: string) => void;
  /**
   * Persist or clear the pseudonym suffix.
   * Call with the suffix returned by POST /api/consent/accept on grant,
   * or with null on revoke.
   */
  setPseudonymSuffix: (suffix: string | null) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,
  sharedConstants: null,
  pseudonymSuffix: null,

  login: async (credentials: LoginCredentials) => {
    set({ isLoading: true, error: null });
    try {
      const userData = await authService.login(credentials);

      set({
        user: {
          _id: userData._id,                 // ← ADDED: required by useHealthConnect.sync()
          firstName: userData.firstName,
          lastName: userData.lastName,
          user_type: userData.userType as 'patient' | 'doctor' | 'researcher' | 'admin',
          profile_picture_url: userData.profile_picture_url,
        },
        token: userData.token,
        isAuthenticated: true,
        isLoading: false,
        sharedConstants: await authService.getSharedConstants(),
      });
    } catch (error: any) {
      const errorMessage = error.response?.data?.message || error.message || 'Login failed';
      set({
        error: errorMessage,
        isLoading: false,
      });
      throw error;
    }
  },

  logout: async () => {
    // DON'T set isLoading: true here — it unmounts the navigator!
    try {
      await authService.logout();
    } catch (error) {
      console.error('Logout error:', error);
    }
    // Clear all state at once, including pseudonym suffix
    set({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
      pseudonymSuffix: null,
    });
  },

  checkAuth: async () => {
    set({ isLoading: true });
    try {
      const token = await authService.getStoredToken();

      // Validate token exists and hasn't expired client-side.
      // This prevents a silent 401 loop when an old 24 h token is stored.
      if (token && isTokenValid(token)) {
        const userData = await authService.getStoredUserData();

        // Self-heal: if stored UserData pre-dates the _id fix in auth.ts,
        // _id will be empty string. Recover it from the JWT payload.
        // auth.py → generate_token() stores MongoDB _id under claim 'user_id'.
        let resolvedId = userData?._id?.trim() ?? '';
        if (!resolvedId) {
          try {
            const base64  = token.split('.')[1];
            const payload = JSON.parse(atob(base64.replace(/-/g, '+').replace(/_/g, '/')));
            resolvedId    = (payload.user_id ?? payload.sub ?? payload.identity ?? '').trim();
            if (resolvedId) {
              console.log('[AuthStore] checkAuth: _id recovered from JWT (user_id claim):', resolvedId);
            } else {
              console.warn('[AuthStore] checkAuth: JWT has no user_id/sub/identity claim — user must re-login');
            }
          } catch (e) {
            console.warn('[AuthStore] checkAuth: JWT decode failed during _id recovery:', e);
          }
        } else {
          console.log('[AuthStore] checkAuth: _id restored from stored UserData:', resolvedId);
        }

        set({
          user: userData ? {
            _id: resolvedId,                 // Required; self-healed from JWT for legacy sessions
            firstName: userData.firstName,
            lastName: userData.lastName,
            user_type: userData.userType as 'patient' | 'doctor' | 'researcher' | 'admin',
            profile_picture_url: userData.profile_picture_url,
          } : null,
          token,
          isAuthenticated: true,
          isLoading: false,
          sharedConstants: await authService.getSharedConstants(),
        });
      } else {
        // Token missing or expired — clear storage and send to login
        if (token) {
          console.log('[AuthStore] Stored token expired — clearing credentials');
          await authService.logout();
        }
        set({
          user: null,
          token: null,
          isAuthenticated: false,
          isLoading: false,
          pseudonymSuffix: null,
        });
      }
    } catch (error) {
      console.error('Error checking auth:', error);
      set({
        isAuthenticated: false,
        isLoading: false,
      });
    }
  },

  clearError: () => set({ error: null }),

  updateProfilePicture: (url: string) =>
    set((state) => ({
      user: state.user ? { ...state.user, profile_picture_url: url } : state.user,
    })),

  setPseudonymSuffix: (suffix: string | null) => set({ pseudonymSuffix: suffix }),
}));

export default useAuthStore;