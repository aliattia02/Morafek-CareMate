/**
 * mobile/services/api/auth.ts - Authentication service for the mobile app
 *
 * Changes in this version:
 *  - Added `id` field to LoginResponse (returned by Flask login route)
 *  - Added `_id` field to UserData so it is persisted to secure storage
 *  - `login()` now maps `response.data.id` → `userData._id`
 *  - Fallback: if the backend omits `id`, _id is extracted from the JWT `sub`
 *    claim (Flask-JWT-Extended sets sub = str(user["_id"])) so the field is
 *    never silently empty — useHealthConnect.sync() needs it for FHIR subject refs.
 */

import apiClient from './client';
import API from './endpoints';
import { secureStorage, STORAGE_KEYS } from '../../utils/storage';

// ─── Type definitions ─────────────────────────────────────────────────────────

export interface LoginCredentials {
  username: string;
  password: string;
  user_type: 'patient' | 'doctor' | 'researcher' | 'admin';
}

export interface RegisterData {
  username: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  user_type: 'patient' | 'doctor' | 'researcher' | 'admin';
}

export interface UserData {
  _id: string;                               // ← ADDED: MongoDB patient _id
  token: string;
  userType: 'patient' | 'doctor' | 'researcher' | 'admin';
  firstName: string;
  lastName: string;
  profile_picture_url?: string;
}

interface LoginResponse {
  message: string;
  token: string;
  id?: string;                               // ← ADDED: backend returns user id
  user_type: string;
  firstName: string;
  lastName: string;
  profile_picture_url?: string;
  shared_constants?: Record<string, any>;
}

interface RegisterResponse {
  message: string;
  id: string;
}

// ─── JWT helpers ──────────────────────────────────────────────────────────────

/**
 * Decode a JWT payload without verifying the signature.
 * We only use this to read the `exp` and `sub` claims on the client side;
 * the server always re-validates the signature on every request.
 */
const decodeTokenPayload = (token: string): Record<string, any> | null => {
  try {
    const base64 = token.split('.')[1];
    if (!base64) return null;
    // atob works in React Native's Hermes / JSC runtime
    const json = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
};

/**
 * Returns true if the token exists AND its `exp` claim is still in the future.
 * A missing `exp` is treated as non-expiring (valid).
 */
const isTokenValid = (token: string): boolean => {
  const payload = decodeTokenPayload(token);
  if (!payload) return false;
  if (!payload.exp) return true;
  const nowSec = Math.floor(Date.now() / 1000);
  return payload.exp > nowSec;
};

/**
 * Extract the user _id from the JWT payload.
 *
 * Claim name priority (first non-empty value wins):
 *   1. `user_id`  — used by Morafek's custom generate_token() in utils/auth.py
 *   2. `sub`      — Flask-JWT-Extended ≥4.x standard
 *   3. `identity` — Flask-JWT-Extended <4.x / older token shapes
 *
 * NOTE: The `sub`/`identity` fallbacks are kept so tokens minted by a future
 * migration to Flask-JWT-Extended are handled automatically without a forced
 * re-login. Add new claim names here if the backend JWT shape ever changes.
 */
const extractIdFromToken = (token: string): string => {
  const payload = decodeTokenPayload(token);
  if (!payload) return '';
  // Morafek's custom generate_token() writes the MongoDB _id under 'user_id'.
  // Flask-JWT-Extended uses 'sub' (>=4.x) or 'identity' (<4.x).
  return (payload.user_id ?? payload.sub ?? payload.identity ?? '') as string;
};

// ─── Auth API calls ───────────────────────────────────────────────────────────

/**
 * Login user and store token + user data (including _id) to secure storage.
 */
export const login = async (credentials: LoginCredentials): Promise<UserData> => {
  console.log('[Auth Service] Login request:', JSON.stringify({
    username: credentials.username,
    user_type: credentials.user_type,
  }));

  const response = await apiClient.post<LoginResponse>(API.AUTH.LOGIN, credentials);

  // Resolve _id: prefer the explicit `id` field the backend returns.
  // If omitted (older backend), fall back to the JWT `sub` claim so this
  // field is never empty — useHealthConnect.sync() requires it.
  const resolvedId =
    response.data.id?.trim() ||
    extractIdFromToken(response.data.token);

  if (!resolvedId) {
    // Log a warning but don't throw — the rest of the app will still work.
    // The Health Connect sync will surface a friendly error if the user tries it.
    console.warn(
      '[Auth Service] ⚠️  Could not resolve _id from login response or JWT. ' +
      'Ensure the Flask login route returns "id": str(user["_id"]).'
    );
  }

  console.log('[Auth Service] Login successful:', {
    user_type: response.data.user_type,
    firstName: response.data.firstName,
    _id: resolvedId || '(not resolved)',
  });

  const userData: UserData = {
    _id: resolvedId,                         // ← ADDED
    token: response.data.token,
    userType: response.data.user_type as 'patient' | 'doctor' | 'researcher' | 'admin',
    firstName: response.data.firstName,
    lastName: response.data.lastName,
    profile_picture_url: response.data.profile_picture_url,
  };

  // Store token and user data (now includes _id) securely
  await secureStorage.set(STORAGE_KEYS.AUTH_TOKEN, userData.token);
  await secureStorage.set(STORAGE_KEYS.USER_DATA, JSON.stringify(userData));

  // Store shared constants if provided by the server
  if (response.data.shared_constants) {
    await secureStorage.set(
      STORAGE_KEYS.SHARED_CONSTANTS,
      JSON.stringify(response.data.shared_constants)
    );
    console.log('[Auth Service] Shared constants stored from login response');
  }

  console.log('[Auth Service] User data stored successfully');

  return userData;
};

/**
 * Register a new user
 */
export const register = async (data: RegisterData): Promise<RegisterResponse> => {
  console.log('[Auth Service] Register request:', JSON.stringify({
    username: data.username,
    email: data.email,
    user_type: data.user_type,
  }));

  const response = await apiClient.post<RegisterResponse>(API.AUTH.REGISTER, data);

  console.log('[Auth Service] Registration successful:', response.data);

  return response.data;
};

/**
 * Logout user and clear stored data
 */
export const logout = async (): Promise<void> => {
  try {
    // Optionally call logout endpoint if backend has one
    // await apiClient.post(API.AUTH.LOGOUT);
    console.log('[Auth Service] Logging out user');
  } catch (error) {
    console.warn('[Auth Service] Logout API call failed:', error);
  }

  await secureStorage.remove(STORAGE_KEYS.AUTH_TOKEN);
  await secureStorage.remove(STORAGE_KEYS.USER_DATA);

  console.log('[Auth Service] User data cleared');
};

/**
 * Check if user is authenticated.
 * Validates that a token exists AND hasn't expired (client-side check).
 * If the token is expired, it is cleared from storage automatically so the
 * user is sent back to the login screen rather than getting stuck with 401s.
 */
export const isAuthenticated = async (): Promise<boolean> => {
  try {
    const token = await secureStorage.get(STORAGE_KEYS.AUTH_TOKEN);
    if (!token) return false;

    if (!isTokenValid(token)) {
      console.log('[Auth Service] Stored token has expired — clearing credentials');
      await secureStorage.remove(STORAGE_KEYS.AUTH_TOKEN);
      await secureStorage.remove(STORAGE_KEYS.USER_DATA);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[Auth Service] Error checking authentication:', error);
    return false;
  }
};

/**
 * Get stored auth token
 */
export const getStoredToken = async (): Promise<string | null> => {
  try {
    return await secureStorage.get(STORAGE_KEYS.AUTH_TOKEN);
  } catch (error) {
    console.error('[Auth Service] Error getting stored token:', error);
    return null;
  }
};

/**
 * Get stored user data
 */
export const getStoredUserData = async (): Promise<UserData | null> => {
  try {
    const data = await secureStorage.get(STORAGE_KEYS.USER_DATA);
    if (data) {
      return typeof data === 'string' ? JSON.parse(data) : data;
    }
    return null;
  } catch (error) {
    console.error('[Auth Service] Error getting stored user data:', error);
    return null;
  }
};

/**
 * Refresh token (placeholder for future implementation)
 */
export const refreshToken = async (): Promise<string | null> => {
  // TODO: Implement token refresh when backend supports it
  return null;
};

/**
 * Get stored shared constants (written on login from the server response)
 */
export const getSharedConstants = async (): Promise<Record<string, any> | null> => {
  try {
    const data = await secureStorage.get(STORAGE_KEYS.SHARED_CONSTANTS);
    if (data) {
      return typeof data === 'string' ? JSON.parse(data) : data;
    }
    return null;
  } catch (error) {
    console.error('[Auth Service] Error getting shared constants:', error);
    return null;
  }
};

// Default export for convenience
const authService = {
  login,
  register,
  logout,
  isAuthenticated,
  getStoredToken,
  getStoredUserData,
  getSharedConstants,
  refreshToken,
};

export default authService;