/**
 * mobile/services/api/client.ts
 *
 * Changes in this version:
 *  1. Added `wakeUpServer()` — polls /api/health until the Render dyno is awake,
 *     with a user-visible progress callback (0→100 %). Call this before login.
 *  2. Retry interceptor bumped: MAX_RETRIES = 4, exponential back-off capped at 15 s.
 *     Total coverage ≈ 2+4+8+15 = 29 s of retries on top of the 90 s timeout,
 *     enough for a Render cold-start (typically 30–60 s).
 *  3. ERR_NETWORK added to the retry condition so the "sometimes" Network Error
 *     on login is now automatically retried instead of surfaced immediately.
 *  4. FIX: 401 handling no longer blindly clears credentials. It only clears
 *     them when no token exists in storage, preventing startup race conditions
 *     (e.g. doctor dashboard mounting before secure storage is hydrated) from
 *     logging the user out.
 */

import axios from 'axios';
import { Platform } from 'react-native';
import { secureStorage, STORAGE_KEYS } from '../../utils/storage';

// ─── Config ───────────────────────────────────────────────────────────────────

const TIMEOUT_MS      = 90_000;  // 90 s per request — covers Render cold-start
const MAX_RETRIES     = 4;       // was 2 → now covers ~29 s of back-off
const RETRY_BASE_MS   = 2_000;   // doubles each retry, capped at 15 s
const RETRY_CAP_MS    = 15_000;

// wakeUpServer constants
const WAKE_POLL_MS    = 5_000;   // ping every 5 s
const WAKE_TIMEOUT_MS = 90_000;  // give up after 90 s
const HEALTH_ENDPOINT = '/api/health';

const getApiBaseUrl = (): string => {
  const envUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envUrl && envUrl.trim() !== '') {
    console.log('[API Client] Using URL from environment:', envUrl);
    return envUrl;
  }
  console.warn('[API Client] ⚠️ EXPO_PUBLIC_API_URL not set — falling back to localhost:5000');
  return 'http://localhost:5000';
};

const API_BASE_URL = getApiBaseUrl();

/**
 * True when running against a local Docker stack (localhost / 127.0.0.1).
 * Used by acceptConsent() to skip 5xx retries — gICS/gPAS are Docker-only
 * and a 502 from the cloud backend is permanent, not a transient cold-start.
 */
export const IS_LOCAL_BACKEND =
  API_BASE_URL.includes('localhost') ||
  API_BASE_URL.includes('127.0.0.1');

console.log('[API Client] Initialized with base URL:', API_BASE_URL);
console.log('[API Client] Platform:', Platform.OS);

// ─── Axios client ─────────────────────────────────────────────────────────────

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    // Tells the backend this is a mobile client → 90-day token instead of 24 h
    'X-Client-Type': 'mobile',
  },
});

// ─── Request interceptor: attach stored token ────────────────────────────────

apiClient.interceptors.request.use(
  async (config) => {
    try {
      const token = await secureStorage.get(STORAGE_KEYS.AUTH_TOKEN);
      if (token) config.headers.Authorization = `Bearer ${token}`;
    } catch (err) {
      console.error('[API Client] Error reading token:', err);
    }
    console.log(`[API Request] ${config.method?.toUpperCase()} ${config.baseURL}${config.url}`);
    return config;
  },
  (error) => {
    console.error('[API Request Error]', error);
    return Promise.reject(error);
  }
);

// ─── Response interceptor: retry + error handling ────────────────────────────

apiClient.interceptors.response.use(
  (response) => {
    console.log(`[API Response] ${response.status} ← ${response.config.url}`);
    return response;
  },
  async (error) => {
    if (!axios.isAxiosError(error)) return Promise.reject(error);

    const config = error.config as any;
    config.__retryCount = config.__retryCount ?? 0;

    const isTimeout    = error.code === 'ECONNABORTED';
    const isNetwork    = error.code === 'ERR_NETWORK' || error.message.includes('Network Error');
    const isNoResponse = !error.response;
    const status       = error.response?.status ?? 0;
    const isServerErr      = status === 502 || status === 503 || status === 504;
    // Callers can set __noRetryOn5xx: true to skip server-error retries.
    // Used by acceptConsent() — a 502 there is permanent (gICS/gPAS Docker-only).
    const skipServerRetry  = !!(config as any).__noRetryOn5xx;

    // Retry on network errors AND server errors (covers Render cold-start)
    const shouldRetry =
      (isTimeout || isNetwork || isNoResponse || (isServerErr && !skipServerRetry)) &&
      config.__retryCount < MAX_RETRIES;

    if (shouldRetry) {
      config.__retryCount += 1;
      const delay = Math.min(RETRY_BASE_MS * Math.pow(2, config.__retryCount - 1), RETRY_CAP_MS);
      console.warn(
        `[API] Retry ${config.__retryCount}/${MAX_RETRIES} for ${config.url} ` +
        `(${error.code ?? status}) — waiting ${delay}ms`
      );
      await new Promise((res) => setTimeout(res, delay));
      return apiClient(config);
    }

    // Log final failure
    console.error('[API Error]', JSON.stringify({
      url:     error.config?.url,
      method:  error.config?.method,
      status:  error.response?.status,
      message: error.message,
      code:    error.code,
    }, null, 2));

    if (isNoResponse || isNetwork) {
      const isLocal = API_BASE_URL.includes('localhost') || API_BASE_URL.includes('127.0.0.1');
      console.error(isLocal
        ? `[API Error] No response from local server — is Flask running on ${API_BASE_URL}?`
        : '[API Error] No response after retries — Render free tier may need ~60 s to cold-start.'
      );
    }

    // ── FIX: Safe 401 handling ──────────────────────────────────────────────
    //
    // Previous behaviour: wipe token + user data on ANY 401.
    // Problem: the doctor dashboard (and other screens) fire authenticated
    // requests on mount. If secure storage hasn't finished hydrating yet,
    // the request goes out without a token, receives a 401, and the old code
    // immediately deleted the real (valid) token — logging the user out on
    // every app refresh.
    //
    // New behaviour:
    //   • Skip credential-clearing for public/health endpoints.
    //   • For protected endpoints, only wipe credentials when NO token exists
    //     in storage (genuine unauthenticated state). If a token IS present,
    //     the 401 is likely a transient race condition; log a warning and let
    //     the calling screen surface the error without destroying the session.
    // ───────────────────────────────────────────────────────────────────────
    if (status === 401) {
      const url = error.config?.url ?? '';
      const isPublicEndpoint =
        url.includes(HEALTH_ENDPOINT) ||
        url.includes('/api/auth/login') ||
        url.includes('/api/auth/register');

      if (!isPublicEndpoint) {
        try {
          const storedToken = await secureStorage.get(STORAGE_KEYS.AUTH_TOKEN);

          if (!storedToken) {
            // No token at all — genuine unauthenticated state, safe to clear.
            console.log('[API Error] 401 with no stored token — clearing user data');
            await secureStorage.remove(STORAGE_KEYS.USER_DATA);
          } else {
            // Token exists but server returned 401. This is most likely a
            // startup race condition (screen mounted before storage hydrated)
            // or a clock-skew issue. Do NOT wipe the session — the auth store
            // will handle expiry via checkAuth() on its next cycle.
            console.warn(
              '[API Error] 401 received but a token IS stored. ' +
              'Likely a startup race condition — session preserved.'
            );
          }
        } catch (storageErr) {
          console.error('[API Error] Could not read token during 401 handling:', storageErr);
        }
      }
    }

    return Promise.reject(error);
  }
);

// ─── wakeUpServer ─────────────────────────────────────────────────────────────

export type WakeProgress = {
  /** 0–100, increases as polls succeed / timeout approaches */
  percent: number;
  /** Human-readable status line for display in UI */
  message: string;
  /** True once the server responded with 200 */
  ready: boolean;
};

/**
 * Poll /api/health every WAKE_POLL_MS until the server responds 200,
 * or until WAKE_TIMEOUT_MS elapses.
 *
 * Calls `onProgress` on every tick so the login screen can show a
 * "Server starting up… 34%" indicator instead of a frozen spinner.
 *
 * Returns `true` if the server woke up in time, `false` on timeout.
 *
 * Usage:
 *   const ready = await wakeUpServer((p) => setWakeProgress(p));
 *   if (!ready) { show error }
 *   else { proceed with login }
 */
export const wakeUpServer = async (
  onProgress?: (p: WakeProgress) => void
): Promise<boolean> => {
  const isLocal = API_BASE_URL.includes('localhost') || API_BASE_URL.includes('127.0.0.1');

  // For local development, skip the poller — the server is either up or not
  if (isLocal) {
    try {
      await apiClient.get(HEALTH_ENDPOINT, { timeout: 5_000 });
      onProgress?.({ percent: 100, message: 'Server ready', ready: true });
      return true;
    } catch {
      onProgress?.({ percent: 0, message: 'Local server not responding', ready: false });
      return false;
    }
  }

  const startTime = Date.now();
  let attempt = 0;

  onProgress?.({ percent: 0, message: 'Connecting to server…', ready: false });

  while (Date.now() - startTime < WAKE_TIMEOUT_MS) {
    attempt++;
    const elapsed  = Date.now() - startTime;
    const percent  = Math.min(Math.round((elapsed / WAKE_TIMEOUT_MS) * 90), 90); // cap at 90 until confirmed

    try {
      await apiClient.get(HEALTH_ENDPOINT, { timeout: 8_000 });
      onProgress?.({ percent: 100, message: 'Server ready!', ready: true });
      console.log(`[wakeUpServer] Server awake after ${elapsed}ms (attempt ${attempt})`);
      return true;
    } catch (err) {
      const msg = attempt === 1
        ? 'Server is starting up…'
        : `Server starting up… (${Math.round(elapsed / 1000)}s)`;
      onProgress?.({ percent, message: msg, ready: false });
      console.log(`[wakeUpServer] Attempt ${attempt} failed — retrying in ${WAKE_POLL_MS}ms`);
      await new Promise((res) => setTimeout(res, WAKE_POLL_MS));
    }
  }

  onProgress?.({ percent: 0, message: 'Server did not respond in time', ready: false });
  console.error('[wakeUpServer] Timed out after', WAKE_TIMEOUT_MS, 'ms');
  return false;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const isNetworkError = (error: unknown): boolean => {
  if (axios.isAxiosError(error)) {
    return (
      !error.response && (
        error.code === 'ERR_NETWORK'   ||
        error.code === 'ECONNREFUSED'  ||
        error.code === 'ECONNABORTED'  ||
        error.message.includes('Network Error')
      )
    );
  }
  return false;
};

export const isAuthError = (error: unknown): boolean =>
  axios.isAxiosError(error) && error.response?.status === 401;

export const getBaseUrl = (): string => API_BASE_URL;

export default apiClient;