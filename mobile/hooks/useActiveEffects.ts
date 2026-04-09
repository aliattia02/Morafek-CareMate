/**
 * Active Effects Hook - FIXED & ENHANCED DEBUG VERSION
 *
 * 🐛 FIXES:
 * 1. Added detailed logging for calculateNetEffect() return values
 * 2. Added field name checking for cumulative values
 * 3. Added fallback to backend API if local calculations fail
 * 4. Enhanced error tracking for each calculation step
 * 5. Preset (circadian) mode now applies calculateTotalCumulativeEffects after
 *    calculateNetEffect so estimatedBG / projectedFinalBG include meals and
 *    insulin correctly — the zeroed cumulative fields on the preset BaselineResult
 *    were causing estimatedBG = circadianBG + 0 (meals/insulin silently ignored).
 *    The backend fallback is also suppressed in preset mode since it cannot
 *    patch estimatedBG/projectedFinalBG, only the three cumulative fields.
 * 6. FIX: Insulin API endpoint only accepts `days` (not `start`/`end`).
 *    Previously the fetch used { start: startISO, end: endISO } which the
 *    backend silently ignored, so insulin was always fetched with the default
 *    window (~24-48h). Doses older than ~2 days were therefore missing from
 *    the chart even though meals in the same period showed correctly.
 *    Fixed by converting the window to a `days` integer parameter.
 *
 * @module hooks/useActiveEffects_DEBUG
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { usePatientConstants } from './usePatientConstants';
import { useAuthStore } from '@/store/auth.store';
import API from '@/services/api/endpoints';
import apiClient from '@/services/api/client';
import {
  calculateStableBaselineFromReading,
  calculateNetEffect,
} from '@/utils/glucose/blood-glucose-estimation';
import { sanitizeBaseline } from '@/utils/calculations/baseline';
// ✅ FIX: import the Phase 3 "persist-at-100%" fixed version of
// calculateTotalCumulativeEffects from @/utils/calculations (cumulative-effects.ts v4.4).
// The version exported by blood-glucose-estimation.ts lacks Phase 3 — for fully-absorbed
// meals/doses it returns 0 instead of persisting totalCarbs × carbToBgFactor, causing
// correctedEstimatedBG and correctedProjected in preset mode to ignore any meal that has
// finished absorbing.  The old import is removed to prevent accidental use elsewhere.
import { calculateTotalCumulativeEffects } from '@/utils/calculations';
import { getTotalCarbsFromMeal } from '@/utils/glucose/meal-pharmacodynamics';
import {
  MEAL_ABSORPTION_PROFILES,
  getCircadianBaseline,
  type BaselineMode,
  type CircadianProfile,
} from '@/constants/shared-constants';
import type { Meal } from '@/types/meal.types';
import type { InsulinDose } from '@/types/insulin.types';
import type { GlucoseReading } from '@/types/glucose.types';
import type { BaselineResult, NetEffectResult } from '@/types/calculation.types';
import type { SafetyStatusLevel, GlucoseTrend } from '@/types/safety.types';

/**
 * Converts a plain object with numeric string keys ({"0": x, "1": y, …})
 * to a proper array.  This is needed because some backend endpoints serialise
 * Python lists/dicts incorrectly via jsonify(), producing {"0":…,"1":…}
 * instead of a JSON array.
 */
function objectWithNumericKeysToArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as object);
    // FIX (Bug A): was .every() — if ANY non-numeric key existed (e.g. "count",
    // "total", "status" appended by the backend) the whole check failed and
    // returned [].  We now extract ONLY the numeric-keyed values, sorted in
    // order, ignoring any metadata keys that may be present.
    const numericKeys = keys
      .filter(k => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    if (numericKeys.length > 0) {
      return numericKeys.map(k => (value as Record<string, unknown>)[k]) as T[];
    }
  }
  return [];
}

/**
 * Robustly extract an array from an API response object.
 *
 * Problems with the naive `??` chain:
 *   1. `??` only skips null/undefined — NOT empty arrays `[]`.
 *      If the backend returns { "data": [], "0": meal, "1": meal, ... }
 *      the chain stops at `data` and returns [] instead of falling through.
 *   2. Non-array named keys (numbers, strings) are silently ignored.
 *
 * This helper tries each named key in order, skipping any that produce an
 * empty array, then falls back to numeric-key extraction on the root object.
 */
function pickResponseArray<T>(root: unknown, namedKeys: string[]): T[] {
  if (Array.isArray(root) && (root as T[]).length > 0) return root as T[];

  if (root !== null && typeof root === 'object') {
    // 1. Try each named key — skip empty arrays
    for (const key of namedKeys) {
      const candidate = (root as Record<string, unknown>)[key];
      if (Array.isArray(candidate) && candidate.length > 0) return candidate as T[];
    }
    // 2. Fall back: extract numeric-keyed values from the root object itself
    const numeric = objectWithNumericKeysToArray<T>(root);
    if (numeric.length > 0) return numeric;
  }

  return [];
}

export interface UseActiveEffectsOptions {
  autoRefresh?: boolean;
  refreshInterval?: number;
  includeProjections?: boolean;
  patientId?: string;
  debug?: boolean;
  /** 🆕 Fallback to backend if frontend calculations return zeros */
  useFallback?: boolean;
  /**
   * 🆕 How many hours back to fetch meals and insulin doses.
   * Defaults to 24.  Pass the chart's total view window so that switching
   * to 3D/7D view fetches enough data for the full range.
   */
  windowHours?: number;
  /**
   * 🆕 Skip the 48-hour IOB cutoff filter when true.
   *
   * ActiveEffectsDisplay (live IOB / estimatedBG) needs the cutoff — it must
   * only see pharmacologically active doses so the BG estimate is accurate.
   *
   * Visualization charts (EffectsVisualizationChart, BloodGlucoseVisualization)
   * manage their own per-point window filter (cumulativeWindowStart) internally,
   * so the 48-hour pre-filter is redundant and actively harmful for multi-day
   * views (3D / 7D) where valid historical doses were being dropped early.
   *
   * Default: false (safe for live display).
   */
  skipIobCutoff?: boolean;
}

export interface UseActiveEffectsResult {
  // Display Values
  stableBaseline: number | null;
  estimatedBG: number | null;
  projectedFinalBG: number | null;

  // Active Effects
  totalIOB: number;
  totalMOB: number;
  activeInsulinEffect: number;
  activeMealEffect: number;
  currentNetEffect: number;

  // Cumulative Effects (Bank Balance)
  cumulativeMealEffect: number;
  cumulativeInsulinEffect: number;
  cumulativeNetBaseline: number;

  // Safety & Trends
  safetyStatus: SafetyStatusLevel | null;
  trend: GlucoseTrend | null;

  // Detailed Breakdowns
  baselineDetails: BaselineResult | null;
  netEffectDetails: NetEffectResult | null;

  // 🆕 Backend fallback data
  backendData: any | null;
  usingBackend: boolean;

  // 🆕 Raw fetched arrays — exposed so chart components (e.g. EffectsVisualizationChart)
  //    can pass them directly to processMealsForChart / processInsulinForChart
  //    without a second API call.
  meals: Meal[];
  insulinDoses: InsulinDose[];

  // Meta
  isLoading: boolean;
  error: string | null;
  lastUpdate: Date | null;
  calculationErrors: string[];

  // 🆕 Active baseline mode resolved from patient constants
  baselineMode: 'dynamic' | 'preset';

  // 🆕 Baseline sanitization — set when the raw value was outside hard bounds
  baselineWarnings: string[];
  baselineSanitizeStatus: 'ok' | 'hard_clamped' | null;

  // Actions
  refresh: () => Promise<void>;
  setMeals: (meals: Meal[]) => void;
  setInsulinDoses: (doses: InsulinDose[]) => void;
  setLatestReading: (reading: GlucoseReading | null) => void;
}

/**
 * Hook for calculating active effects with comprehensive debugging
 */
export function useActiveEffects(
  options: UseActiveEffectsOptions = {}
): UseActiveEffectsResult {
  const {
    autoRefresh = true,
    refreshInterval = 60000,
    includeProjections = true,
    debug = true,
    useFallback = true,   // 🆕 Enable backend fallback by default
    windowHours = 24,     // 🆕 Default to 24h; caller passes chart range
    skipIobCutoff = false, // 🆕 Charts set true; live display keeps false
  } = options;

  // Get patient constants
  const { constants, isLoading: constantsLoading } = usePatientConstants();

  // Get token from auth store
  const token = useAuthStore((state) => state.token);

  // ── Atomic data state ────────────────────────────────────────────────────
  // All three are updated in ONE setState call inside fetchData() so that
  // calculateEffects() is never triggered with a partially-loaded snapshot
  // (e.g. doses populated but meals still empty → estimatedBG = -67 mg/dL).
  const [fetchedData, setFetchedData] = useState<{
    meals: Meal[];
    doses: InsulinDose[];
    reading: GlucoseReading | null;
    ready: boolean;
  }>({ meals: [], doses: [], reading: null, ready: false });

  // Convenience aliases — keep existing internal usage working without churn
  const meals       = fetchedData.meals;
  const insulinDoses = fetchedData.doses;
  const latestReading = fetchedData.reading;

  // Setters still exposed in the public API (used by chart components)
  const setMeals        = (m: Meal[])                => setFetchedData(prev => ({ ...prev, meals: m }));
  const setInsulinDoses = (d: InsulinDose[])         => setFetchedData(prev => ({ ...prev, doses: d }));
  const setLatestReading = (r: GlucoseReading | null) => setFetchedData(prev => ({ ...prev, reading: r }));

  // Calculation results
  const [baselineDetails, setBaselineDetails] = useState<BaselineResult | null>(null);
  const [netEffectDetails, setNetEffectDetails] = useState<NetEffectResult | null>(null);

  // 🆕 Backend fallback
  const [backendData, setBackendData] = useState<any | null>(null);
  const [usingBackend, setUsingBackend] = useState(false);

  // Meta state
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [calculationErrors, setCalculationErrors] = useState<string[]>([]);
  const [resolvedBaselineMode, setResolvedBaselineMode] = useState<'dynamic' | 'preset'>('dynamic');
  const [baselineWarnings, setBaselineWarnings] = useState<string[]>([]);
  const [baselineSanitizeStatus, setBaselineSanitizeStatus] = useState<'ok' | 'hard_clamped' | null>(null);

  // Refs for throttling
  const lastCalculationMinute = useRef<number>(0);
  const refreshTimer = useRef<NodeJS.Timeout | null>(null);

  /**
   * 🆕 Fetch backend data as fallback
   */
  const fetchBackendFallback = useCallback(async () => {
    try {
      if (debug) console.log('[useActiveEffects] 🌐 Fetching backend fallback...');

      const timezoneOffsetMinutes = -new Date().getTimezoneOffset();
      const response = await apiClient.get('/api/active-effects-full', {
        params: { timezone_offset_minutes: timezoneOffsetMinutes },
      });

      if (debug) console.log('[useActiveEffects] ✅ Backend fallback received:', JSON.stringify(response.data, null, 2));

      setBackendData(response.data);
      setUsingBackend(true);

      return response.data;
    } catch (err) {
      console.error('[useActiveEffects] ❌ Backend fallback failed:', err);
      setCalculationErrors(prev => [...prev, 'Backend fallback failed']);
      return null;
    }
  }, [debug]);

  /**
   * Helper to extract carbs from meal
   */
  const debugMealCarbs = (meal: Meal, index: number): number => {
    const finalCarbs = getTotalCarbsFromMeal(meal);

    if (debug) {
      console.log(`[useActiveEffects] 🍽️ Meal ${index + 1} carb extraction:`, {
        id: meal.id,
        type: meal.mealType,
        timestamp: meal.timestamp,
        'calculation_summary.total_carb_equiv': meal.calculation_summary?.total_carb_equiv,
        'nutrition.totalCarbEquiv': meal.nutrition?.totalCarbEquiv,
        'nutrition.carbs': meal.nutrition?.carbs,
        'foodItems count': meal.foodItems?.length || 0,
        'FINAL carbs': finalCarbs,
        '⚠️ WARNING': finalCarbs === 0 ? 'NO CARBS FOUND!' : null
      });

      // 🆕 Check each food item
      if (meal.foodItems && meal.foodItems.length > 0) {
        console.log(`[useActiveEffects]    📊 Food items breakdown:`);
        meal.foodItems.forEach((item: any, idx: number) => {
          console.log(`[useActiveEffects]       ${idx + 1}. ${item.name || 'Unknown'}:`, {
            carbs: item.carbs,
            carbEquiv: item.carbEquiv,
            quantity: item.quantity,
          });
        });
      } else {
        console.log(`[useActiveEffects]    ⚠️ NO FOOD ITEMS ARRAY`);
      }
    }

    return finalCarbs;
  };

  /**
   * Fetch data from backend
   */
  const fetchData = useCallback(async () => {
    try {
      if (!token) {
        throw new Error('No authentication token');
      }

      const currentTime = new Date();

      if (debug) {
        console.log('[useActiveEffects] 📡 Fetching data from API...');
      }

      // Calculate fetch window — add 8h buffer beyond the chart range so
      // meals/insulin that started before the window edge still have their
      // full absorption curve available.
      const windowEnd   = new Date();
      const windowStart = new Date(windowEnd.getTime() - (windowHours + 8) * 60 * 60 * 1000);
      const startISO    = windowStart.toISOString();
      const endISO      = windowEnd.toISOString();

      // ── FIX: Insulin endpoint only accepts `days`, not `start`/`end` ──────
      // The GET /api/insulin-data endpoint (insulin.ts → getDoses) only reads
      // the `days` query param. Passing `start`/`end` is silently ignored by
      // the backend, which then falls back to its default window (~24-48h).
      // This caused doses older than ~2 days to vanish from the chart even
      // though meals in the same period displayed correctly (meals endpoint
      // does support `start`/`end`).
      //
      // Fix: convert the desired window to a `days` integer.
      // +8h buffer is already baked into windowHours by the lines above;
      // we add +1 to round up so a fractional day is never truncated.
      const insulinDays = Math.ceil((windowHours + 8) / 24) + 1;

      if (debug) {
        console.log(`[useActiveEffects] 💉 Fetching insulin with days=${insulinDays} (windowHours=${windowHours})`);
      }

      // Use apiClient (not bare axios) so the configured baseURL is applied and
      // the request interceptor attaches the Bearer token automatically.
      // Bare axios.get with a path-only string resolves relative to the page
      // origin, which on Expo web is the dev server (localhost:8081), not Flask.
      //
      // IMPORTANT: Blood sugar is date-filtered to the last 24 h.
      // Without a filter the backend returns ALL readings (2 500+, ~490 KB).
      // On Render free tier this causes ECONNABORTED timeouts when several
      // concurrent callers each download the full payload simultaneously.
      const bsWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const bsWindowEnd   = new Date().toISOString();
      const [mealsRes, insulinRes, readingRes] = await Promise.all([
        apiClient.get(API.MEALS.MEALS_ONLY,    { params: { start: startISO, end: endISO } }),
        // ✅ FIX: use `days` param — the only param the insulin endpoint respects
        apiClient.get(API.INSULIN.DATA,         { params: { days: insulinDays } }),
        apiClient.get(API.BLOOD_SUGAR.LIST, {
          params: {
            start_time: bsWindowStart,
            end_time:   bsWindowEnd,
            filter_by:  'reading_time',
          }
        }).catch(() => null),
      ]);

      // ── DEBUG: log full response structure so we can see the shape ─────────
      console.log('[useActiveEffects] mealsRes.data shape:',
        JSON.stringify(mealsRes.data).slice(0, 300));
      console.log('[useActiveEffects] insulinRes.data shape:',
        JSON.stringify(insulinRes.data).slice(0, 300));

      // ── Extract meals ──────────────────────────────────────────────────────
      // FIX (Bug C): replaced ?? chain with pickResponseArray().
      // `??` does NOT skip empty arrays — if any named key resolves to []
      // the chain stops there and never reaches the numeric-keyed root object.
      // pickResponseArray() explicitly skips empty-array candidates and falls
      // back to numeric-key extraction on the root, handling all known shapes:
      //   { meals: [...] }  |  { "0":{}, "1":{} }  |  [...]  |  { data: [], "0":{} }
      const fetchedMeals: Meal[] = pickResponseArray<Meal>(
        mealsRes.data,
        ['meals', 'meal_list', 'data', 'items', 'results'],
      );

      // ── Extract insulin doses ──────────────────────────────────────────────
      const rawDoses: InsulinDose[] = pickResponseArray<InsulinDose>(
        insulinRes.data,
        ['insulin_logs', 'insulinDoses', 'doses', 'data', 'items', 'results', 'logs'],
      );

      // ── Normalise dose field names ─────────────────────────────────────────
      // The backend returns { taken_at, medication, dose } but the stacking
      // functions (calculateStackedInsulinEffect, calculateInsulinCumulativeEffect)
      // look for { administrationTime, insulinType, units }.
      // Without this step both fields are `undefined` for every dose, so
      // activeDoses is always 0 and IOB / cumulative insulin effect are always 0.
      const normalisedDoses: InsulinDose[] = rawDoses.map((d: any) => ({
        ...d,
        // Resolve administrationTime from whichever field the backend sent
        administrationTime: d.administrationTime ?? d.taken_at ?? d.takenAt ?? null,
        // Resolve insulinType from whichever field the backend sent
        insulinType: d.insulinType ?? d.insulin_type ?? d.medication ?? 'regular_insulin',
        // Resolve units — calculation functions prefer `units` over `dose`
        units: d.units ?? d.dose ?? 0,
      }));

      // ── Filter to relevant window ──────────────────────────────────────────
      // The API returns every dose ever logged (oldest was 345 hours ago).
      //
      // Two boundaries determine relevance:
      //
      // 1. IOB lookback (48h from T1D_BG_CONSTANTS).
      //    Long-acting insulins can be active for up to 42h (degludec), 31h
      //    (glargine U300), 23.5h (glargine). A flat 24h cutoff silently drops
      //    doses that are still pharmacologically active. We use the constant
      //    already defined for this purpose: iob_lookback_hours = 48.
      //
      // 2. Daily reset boundary (lastResetMs).
      //    Doses before the last reset cannot contribute to the current day's
      //    cumulative baseline regardless of how long-acting they are — the
      //    reset defines "today's" accounting window. This is timezone-aware:
      //    at 6:59 AM with a 7 AM reset, lastResetMs is yesterday 7 AM (≈23h
      //    ago), not midnight.
      //
      // We keep doses that pass EITHER boundary — i.e. the earlier cutoff wins.
      // This means: keep if (doseMs >= iobCutoffMs) OR (doseMs >= lastResetMs).
      // Equivalently: drop only if doseMs < BOTH cutoffs.
      //
      // Downstream cumulative-effects.ts already applies the reset filter
      // internally, so pre-reset doses that slip through the IOB window are
      // still correctly excluded from today's baseline calculation.
      //
      // NOTE: For multi-day chart views the caller passes windowHours > 48, so
      // insulinDays covers the full range. We still apply the IOB/reset filter
      // here to avoid accumulating stale doses in the calculation arrays, but
      // the chart's allDosesInWindow filter in EffectsVisualizationChart uses
      // rangeStart (the chart's left edge) as its lower bound, so historical
      // chart points correctly see doses from their own daily windows.
      const iobLookbackHours = 48; // T1D_BG_CONSTANTS.iob_lookback_hours
      const iobCutoffMs = currentTime.getTime() - iobLookbackHours * 60 * 60 * 1000;

      // Compute lastResetMs using the patient's actual reset hour + timezone.
      // Falls back to constants defaults if not yet loaded.
      const resetHour   = constants?.daily_reset_hour ?? 7;
      const tzOffset    = (constants as any)?.timezone_offset_minutes ?? 0;
      const offsetMs    = tzOffset * 60 * 1000;
      const localNow    = new Date(currentTime.getTime() + offsetMs);
      const localReset  = new Date(localNow);
      localReset.setUTCHours(resetHour, 0, 0, 0);
      if (localNow.getTime() < localReset.getTime()) {
        localReset.setUTCDate(localReset.getUTCDate() - 1);
      }
      const lastResetMs = localReset.getTime() - offsetMs;

      const fetchedDoses: InsulinDose[] = normalisedDoses.filter((d: any) => {
        const ts = d.administrationTime;
        if (!ts) return false;
        const hasZone = ts.endsWith('Z') || ts.includes('+') || /T.*-\d{2}:\d{2}$/.test(ts);
        const doseMs = hasZone
          ? new Date(ts).getTime()
          : new Date(ts.replace(' ', 'T') + 'Z').getTime();
        if (isNaN(doseMs)) return false;

        // Visualization charts (skipIobCutoff=true) re-filter doses per chart
        // point using cumulativeWindowStart, so the 48h pre-filter here is
        // redundant and harmful for multi-day views — skip it entirely.
        //
        // Live display (skipIobCutoff=false, the default) must keep both
        // boundaries so estimatedBG / IOB only reflect active pharmacology.
        if (skipIobCutoff) return true;

        // Keep if within IOB lookback window OR within today's reset window
        return doseMs >= iobCutoffMs || doseMs >= lastResetMs;
      });

      if (debug && normalisedDoses.length !== fetchedDoses.length) {
        console.log(
          `[useActiveEffects] 🗑️ Dropped ${normalisedDoses.length - fetchedDoses.length} stale dose(s)` +
          ` (kept ${fetchedDoses.length}${skipIobCutoff ? ' — IOB cutoff skipped (chart mode)' : ` within ${iobLookbackHours}h IOB window or today's reset window`})`
        );
      }

      // ── Normalise reading to GlucoseReading shape ───────────────────────────
      // The backend API returns readings with `bloodSugar` and `bloodSugarTimestamp`
      // (or `timestamp`) fields, but calculateStableBaselineFromReading() expects:
      //   - reading.value      (number  — the BG value in mg/dL)
      //   - reading.timestamp  (number  — UTC milliseconds)
      //
      // Without this normalisation:
      //   reading.value === undefined  →  readingValue = NaN
      //   NaN - cumulativeNetEffect   = NaN  →  stableBaseline = NaN
      //   NaN ?? fallback             = NaN  (not caught by ??)
      //   baseBG = NaN  →  SVG path: "M56,NaN..."  →  chart broken
      //
      // ✅ FIX: Explicitly resolve both field variants here before storing.
      function normaliseReading(r: any): any | null {
        if (!r) return null;
        const rawTs = r.bloodSugarTimestamp ?? r.timestamp ?? r.readingTime ?? r.reading_time ?? r.taken_at ?? null;
        const tsMs = (typeof rawTs === 'number' && isFinite(rawTs))
          ? rawTs
          : rawTs
            ? (() => {
                const hasZone = String(rawTs).endsWith('Z') || String(rawTs).includes('+') || /T.*-\d{2}:\d{2}$/.test(String(rawTs));
                return hasZone ? new Date(rawTs).getTime() : new Date(String(rawTs).replace(' ', 'T') + 'Z').getTime();
              })()
            : NaN;
        const bgValue = r.bloodSugar ?? r.blood_sugar ?? r.value ?? r.glucose_value ?? NaN;
        if (isNaN(tsMs) || isNaN(Number(bgValue))) return null;
        return {
          ...r,
          value:     Number(bgValue),    // field expected by calculateStableBaselineFromReading
          timestamp: tsMs,               // UTC ms — expected by getDoseTimestamp / getMealTimestamp
          bloodSugar: Number(bgValue),   // keep for downstream consumers
        };
      }

      const fetchedReading: GlucoseReading | null =
        normaliseReading(
          readingRes?.data?.reading ??
          readingRes?.data?.readings?.[0] ??
          (Array.isArray(readingRes?.data) ? readingRes.data[0] : null) ??
          null
        );

      // Warn with full shape to diagnose extraction failures
      if (fetchedMeals.length === 0) {
        console.warn('[useActiveEffects] ⚠️ fetchedMeals is EMPTY.',
          'mealsRes.data keys:', Object.keys(mealsRes.data ?? {}).slice(0, 15),
          'fetchedMeals type:', typeof fetchedMeals, Array.isArray(fetchedMeals) ? '(array)' : '');
      }
      if (fetchedDoses.length === 0) {
        console.warn('[useActiveEffects] ⚠️ fetchedDoses is EMPTY.',
          'insulinRes.data keys:', Object.keys(insulinRes.data ?? {}).slice(0, 15),
          'fetchedDoses type:', typeof fetchedDoses, Array.isArray(fetchedDoses) ? '(array)' : '');
      }

      // Debug-only verbose block (debug: false in production)
      if (debug) {
        console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('[useActiveEffects] 📊 DATA FETCH COMPLETE');
        console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('[useActiveEffects] Fetched meals:', fetchedMeals.length);
        console.log('[useActiveEffects] Fetched doses:', fetchedDoses.length);
        console.log('[useActiveEffects] Latest reading:', fetchedReading?.bloodSugar || 'none');

        console.log('');
        console.log('[useActiveEffects] 🔍 MEAL CARB EXTRACTION DEBUG:');
        fetchedMeals.forEach((meal: Meal, idx: number) => {
          debugMealCarbs(meal, idx);
        });

        const totalCarbs = fetchedMeals.reduce((sum: number, meal: Meal) =>
          sum + getTotalCarbsFromMeal(meal), 0
        );

        console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('[useActiveEffects] 📈 TOTAL CARBS ACROSS ALL MEALS:', totalCarbs, 'g');

        if (totalCarbs === 0 && fetchedMeals.length > 0) {
          console.error('[useActiveEffects] ⚠️ CRITICAL: ALL MEALS HAVE ZERO CARBS!');
          console.error('[useActiveEffects] This will cause all calculations to return 0.');
          setCalculationErrors(prev => [...prev, 'All meals have zero carbs']);
        }
        console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('');
      }

      // ── ATOMIC UPDATE ────────────────────────────────────────────────────
      // All three pieces of data land in one setState call so React batches
      // them into a single re-render. The useEffect below watches `fetchedData`
      // and only fires calculateEffects() once, with a coherent snapshot.
      // Previously these were three separate setStates, causing calculateEffects
      // to run after each one — e.g. meals populated but doses still [], which
      // produced estimatedBG = baseline + (−full insulin effect) = −67 mg/dL.
      setFetchedData({
        meals:   fetchedMeals,
        doses:   fetchedDoses,
        reading: fetchedReading,
        ready:   true,
      });

      // Release the spinner when there is genuinely no data to calculate with.
      if (fetchedMeals.length === 0 && fetchedDoses.length === 0 && !fetchedReading) {
        setIsLoading(false);
        setLastUpdate(new Date());
      }

      return { meals: fetchedMeals, doses: fetchedDoses, reading: fetchedReading };
    } catch (err) {
      console.error('[useActiveEffects] ❌ Error fetching data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
      setCalculationErrors(prev => [...prev, 'Data fetch failed']);
      return null;
    }
  // ── BUG FIX: windowHours was missing from the dep array. ────────────────────
  // fetchData previously closed over the INITIAL windowHours=24 permanently,
  // so even if EffectsVisualizationChart passed pastHours=168 for the week
  // view, the API always fetched only the last 32h of meals and doses.
  // Historical chart points (e.g. 18/02 on a 7-day view) had no data in
  // rawMeals, so allMealsUpToNow was always empty → cumulativeNetBaseline = 0.
  // Adding windowHours to the dep array ensures fetchData is recreated and
  // re-runs whenever the caller changes the fetch window.
  }, [token, debug, windowHours]);

  /**
   * Perform all calculations with enhanced debugging
   */
  const calculateEffects = useCallback(async () => {
    if (!constants || constantsLoading) {
      if (debug) {
        console.log('[useActiveEffects] ⏳ Waiting for constants...');
      }
      return;
    }

    // Throttle to once per minute
    const currentMinute = Math.floor(Date.now() / 60000);
    if (currentMinute === lastCalculationMinute.current) {
      if (debug) {
        console.log('[useActiveEffects] 🚫 Calculation throttled (same minute)');
      }
      return;
    }
    lastCalculationMinute.current = currentMinute;

    try {
      setIsLoading(true);
      setError(null);
      // FIX: Avoid creating a new empty array reference if errors are already
      // cleared — useState bails out only on primitive equality, so [] !== []
      // always triggers a re-render even when there's nothing to clear.
      setCalculationErrors(prev => (prev.length === 0 ? prev : []));
      setUsingBackend(false);

      const currentTime = new Date();

      if (debug) {
        console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('[useActiveEffects] 🔬 STARTING CALCULATIONS');
        console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('[useActiveEffects] Current time:', currentTime.toISOString());
        console.log('[useActiveEffects] Meals to process:', meals.length);
        console.log('[useActiveEffects] Doses to process:', insulinDoses.length);
        console.log('[useActiveEffects] Has reading:', !!latestReading);
        console.log('[useActiveEffects] Constants loaded:', !!constants);
      }

      // 1. Calculate baseline
      // ── Stable baseline (mode-aware) ─────────────────────────────────────────
      const resolvedMode: 'dynamic' | 'preset' =
        ((constants as any)?.baseline_mode === 'preset') ? 'preset' : 'dynamic';

      setResolvedBaselineMode(resolvedMode);

      let baseline: BaselineResult | null = null;
      try {
        if (resolvedMode === 'preset') {
          // ── Preset: circadian profile lookup at current local hour ──
          if (debug) {
            console.log('[useActiveEffects] 📊 Calculating baseline from circadian profile (preset mode)...');
          }

          const tzOffsetMin = (constants as any)?.timezone_offset_minutes ?? 0;
          const localHour = (
            currentTime.getUTCHours() +
            currentTime.getUTCMinutes() / 60 +
            currentTime.getUTCSeconds() / 3600 +
            tzOffsetMin / 60
          ) % 24;

          const circadianBG = getCircadianBaseline(
            localHour,
            (constants as any)?.circadian_profile as CircadianProfile | undefined
          );

          baseline = {
            stableBaseline: circadianBG,
            baselineMode: 'preset',
            readingValue: latestReading?.value ?? circadianBG,
            readingTimestamp: null,
            cumulativeMealEffect: 0,
            cumulativeInsulinEffect: 0,
            cumulativeNetEffect: latestReading != null
              ? latestReading.value - circadianBG
              : 0,
            mealsCount: meals.length,
            insulinCount: insulinDoses.length,
            confidence: 1.0,
            warnings: [],
          } as unknown as BaselineResult;

          if (debug) {
            console.log('[useActiveEffects] 🌙 Preset baseline', {
              hourFloat: localHour.toFixed(2),
              presetValue: circadianBG,
              readingDelta: (baseline as any).cumulativeNetEffect,
            });
          }

        } else if (latestReading) {
          // ── Dynamic mode: back-calculate from the most recent reading ──
          if (debug) {
            console.log('[useActiveEffects] 📊 Calculating baseline from reading (dynamic mode)...');
          }

          try {
            const rawBaselineResult = calculateStableBaselineFromReading(
              latestReading,
              meals,
              insulinDoses,
              currentTime,
              constants,
              MEAL_ABSORPTION_PROFILES,
              constants.daily_reset_hour || 7,
              constants.timezone_offset_minutes || 0
            );

            // ── Hard-clamp baseline to physiological limits ──────────────────
            // Clamps values < 55 or > 220 mg/dL and emits a CRITICAL warning.
            // Does NOT do soft blending — values inside the hard bounds pass through unchanged.
            const sanitized = sanitizeBaseline(rawBaselineResult.stableBaseline);
            if (sanitized.warnings.length > 0) {
              console.warn('[useActiveEffects] ⚠️ Baseline clamped:', sanitized);
              setBaselineWarnings(sanitized.warnings);
              setBaselineSanitizeStatus(sanitized.status);
            } else {
              setBaselineWarnings([]);
              setBaselineSanitizeStatus('ok');
            }

            baseline = {
              ...rawBaselineResult,
              stableBaseline: sanitized.value,
              warnings: [...(rawBaselineResult.warnings ?? []), ...sanitized.warnings],
            };

            if (debug) {
              console.log('[useActiveEffects] 📍 Dynamic baseline', {
                stableBaseline: baseline?.stableBaseline,
                readingValue:   baseline?.readingValue,
                cumulativeNet:  (baseline as any)?.cumulativeNetEffect,
              });
            }
          } catch (err) {
            console.error('[useActiveEffects] ❌ Dynamic baseline failed:', err);
            setCalculationErrors(prev => [...prev, 'Dynamic baseline failed']);
          }
        } else {
          if (debug) {
            console.log('[useActiveEffects] ⚠️ Dynamic mode but no reading available — baseline will be null');
          }
        }

        setBaselineDetails(baseline);
      } catch (err) {
        console.error('[useActiveEffects] ❌ Baseline calculation failed:', err);
        setCalculationErrors(prev => [...prev, 'Baseline calculation failed']);
      }

      // 2. Calculate net effect
      let netEffect: NetEffectResult | null = null;
      try {
        if (debug) {
          console.log('[useActiveEffects] 📊 Calculating net effect...');
        }

        netEffect = calculateNetEffect(
          baseline,
          meals,
          insulinDoses,
          currentTime,
          constants,
          MEAL_ABSORPTION_PROFILES
        );

        // ── Dynamic mode: fix projectedFinalBG double-counting of IOB ───────────
        //
        // calculateNetEffect computes projectedFinalBG as:
        //
        //   projectedFinalBG = baselineValue
        //     + cumulativeResult.cumulativeNetBaseline   // already includes absorbed insulin
        //     + mealEffects.totalPendingRise
        //     - insulinEffects.totalBGImpact             // subtracts IOB × corrFactor AGAIN
        //
        // cumulativeNetBaseline = cumulativeMealEffect − cumulativeInsulinEffect
        // cumulativeInsulinEffect already represents the full absorbed dose impact
        // (persists at 100% in Phase 3). Subtracting totalBGImpact (IOB × corrFactor)
        // on top partially double-counts the insulin's lowering effect, making
        // projectedFinalBG systematically too low and causing false hypoglycemia alerts.
        //
        // FIX: rebuild projectedFinalBG from estimatedBG (which is already correct)
        // plus only the truly pending (not-yet-absorbed) IOB/MOB contributions.
        //
        //   pending_net_effect = totalMOB × carbFactor − totalIOB × corrFactor
        //   projectedFinalBG   = estimatedBG + pending_net_effect
        //
        // This matches the backend formula and the preset-mode fix below.
        if (resolvedMode === 'dynamic' && netEffect) {
          const corrFactor = constants.correction_factor ?? 40;
          const carbFactor = (constants as any)?.carb_to_bg_factor
                            ?? (constants as any)?.carb_to_bg_ratio ?? 4;
          const pendingNetEffect = (netEffect.totalMOB ?? 0) * carbFactor
                                 - (netEffect.totalIOB ?? 0) * corrFactor;
          const correctedProjected = (netEffect.estimatedBG ?? 0) + pendingNetEffect;

          if (debug) {
            console.log('[useActiveEffects] 🩺 Dynamic: fixed projectedFinalBG double-count', {
              estimatedBG:          netEffect.estimatedBG,
              totalMOB:             netEffect.totalMOB,
              totalIOB:             netEffect.totalIOB,
              pendingNetEffect,
              oldProjectedFinalBG:  netEffect.projectedFinalBG,
              correctedProjected,
            });
          }

          netEffect = {
            ...netEffect,
            projectedFinalBG: correctedProjected,
          } as NetEffectResult;
        }

        // ── Preset mode correction ──────────────────────────────────────────────
        // calculateNetEffect receives a preset baseline whose cumulativeMealEffect
        // and cumulativeInsulinEffect are both zeroed (preset baselines carry no
        // reading to back-calculate from).  This causes:
        //
        //   estimatedBG      = circadianBG + 0          ← meals/insulin ignored
        //   projectedFinalBG = circadianBG + pendingOnly ← anchored to wrong base
        //   cumulativeMealEffect/InsulinEffect           ← both show 0 to callers
        //
        // Fix: run the Phase 3-fixed calculateTotalCumulativeEffects (imported
        // from @/utils/calculations, NOT from blood-glucose-estimation) to get the
        // real absorbed-PK cumulative, then overwrite the stale fields.
        //
        // ⚠️  IMPORTANT — must use the @/utils/calculations version:
        //   blood-glucose-estimation's version lacks the Phase 3 "persist-at-100%"
        //   behaviour.  For meals/doses past their absorption duration it returns 0,
        //   making correctedEstimatedBG = circadianBG (ignores the finished meal).
        //   The fixed version persists totalCarbs × carbToBgFactor until the
        //   daily reset, matching the backend and ActiveEffectsDisplay.
        //
        // FIX: Compute the pending BG delta directly from netEffect.totalIOB /
        // netEffect.totalMOB rather than extracting it from calculateNetEffect's
        // raw projectedFinalBG.
        //
        // WHY the old approach was wrong in preset mode
        // ─────────────────────────────────────────────
        // The preset baseline carries:
        //   cumulativeNetEffect = latestReading.value − circadianBG  (e.g. 130 − 87 = +43)
        // calculateNetEffect bakes this offset into its internal estimatedBG:
        //   netEffect.estimatedBG = circadianBG + 43 = 130
        // calculateNetEffect then computes projectedFinalBG using the FULL initial
        // dose size (e.g. 0.52 u) rather than just the active IOB fraction (0.11 u):
        //   projectedFinalBG = 130 − (0.52 × 40) = 109
        //   pendingDelta     = 109 − 130 = −20.8      ← wildly inflated
        //   correctedProjected = 38 + (−20.8) = 17 ❌  (should be ~34)
        //
        // The comment "pendingDelta is independent of the baseline's cumulative fields"
        // was incorrect: the reading-based offset in cumulativeNetEffect leaks through
        // netEffect.estimatedBG and inflates the extracted pendingDelta.
        //
        // FIX: build pendingNetEffect directly from the correctly active-only IOB/MOB
        // fractions that calculateNetEffect exposes on its return value.  This matches
        // the backend formula and CalculationComparison.tsx:
        //   pending_net_effect = totalMOB × carbFactor − totalIOB × corrFactor
        //
        // Example: 0 × 4 − 0.11 × 40 = −4.4 → correctedProjected = 38 − 4.4 = 33.6 ✅
        if (resolvedMode === 'preset' && netEffect) {
          const resetHour = constants.daily_reset_hour ?? 7;
          const tzOffset  = constants.timezone_offset_minutes ?? 0;

          // ✅ Phase 3-fixed cumulative (from @/utils/calculations)
          const pkCumulative = calculateTotalCumulativeEffects(
            meals,
            insulinDoses,
            currentTime,
            constants,
            MEAL_ABSORPTION_PROFILES,
            resetHour,
            tzOffset
          );

          const stableBaseline       = baseline?.stableBaseline ?? (constants.target_glucose ?? 100);
          const correctedEstimatedBG = stableBaseline + pkCumulative.cumulativeNetBaseline;

          // ✅ FIX: Compute pending delta directly from exposed IOB/MOB values.
          // netEffect.totalIOB and netEffect.totalMOB are the correctly
          // active-only fractions computed by calculateNetEffect's PK stacking —
          // they are unaffected by the preset baseline's reading-based offset.
          const corrFactor        = constants.correction_factor ?? 40;
          const carbFactor        = (constants as any)?.carb_to_bg_factor
                                   ?? (constants as any)?.carb_to_bg_ratio ?? 4;
          const pendingNetEffect  = (netEffect.totalMOB ?? 0) * carbFactor
                                   - (netEffect.totalIOB ?? 0) * corrFactor;
          const correctedProjected = correctedEstimatedBG + pendingNetEffect;

          netEffect = {
            ...netEffect,
            estimatedBG:             correctedEstimatedBG,
            projectedFinalBG:        correctedProjected,
            cumulativeMealEffect:    pkCumulative.cumulativeMealEffect,
            cumulativeInsulinEffect: pkCumulative.cumulativeInsulinEffect,
            cumulativeBaseline:      pkCumulative.cumulativeNetBaseline,
          } as NetEffectResult;

          if (debug) {
            console.log('[useActiveEffects] 🌙 Preset: patched estimatedBG with PK cumulative', {
              circadian:       stableBaseline,
              pkCumulativeNet: pkCumulative.cumulativeNetBaseline,
              correctedEstimatedBG,
              correctedProjected,
            });
          }
        }

        if (debug) {
          console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('[useActiveEffects] 🔍 NET EFFECT OBJECT STRUCTURE:');
          console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log(JSON.stringify(netEffect, null, 2));
          console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('');

          console.log('[useActiveEffects] 🆕 FIELD NAME CHECK:');
          console.log('[useActiveEffects]   Has cumulativeMealEffect?', 'cumulativeMealEffect' in (netEffect || {}));
          console.log('[useActiveEffects]   Has cumulativeInsulinEffect?', 'cumulativeInsulinEffect' in (netEffect || {}));
          console.log('[useActiveEffects]   Has cumulativeBaseline?', 'cumulativeBaseline' in (netEffect || {}));
          console.log('[useActiveEffects]   Has cumulative_meal_effect?', 'cumulative_meal_effect' in (netEffect || {}));
          console.log('[useActiveEffects]   Has cumulative_insulin_effect?', 'cumulative_insulin_effect' in (netEffect || {}));
          console.log('[useActiveEffects]   Has cumulative_net_baseline?', 'cumulative_net_baseline' in (netEffect || {}));
          console.log('');

          console.log('[useActiveEffects] 📊 EXTRACTED VALUES:');
          console.log('[useActiveEffects]   Total IOB:', netEffect?.totalIOB || 0, 'units');
          console.log('[useActiveEffects]   Total MOB:', netEffect?.totalMOB || 0, 'g');
          console.log('[useActiveEffects]   Active Insulin Effect:', netEffect?.activeInsulinEffect || 0, 'mg/dL/hr');
          console.log('[useActiveEffects]   Active Meal Effect:', netEffect?.activeMealEffect || 0, 'mg/dL/hr');
          console.log('[useActiveEffects]   Current Net Effect:', netEffect?.currentNetEffect || 0, 'mg/dL/hr');
          console.log('[useActiveEffects]   Cumulative Meal:', netEffect?.cumulativeMealEffect || 0, 'mg/dL');
          console.log('[useActiveEffects]   Cumulative Insulin:', netEffect?.cumulativeInsulinEffect || 0, 'mg/dL');
          console.log('[useActiveEffects]   Cumulative Baseline:', netEffect?.cumulativeBaseline || 0, 'mg/dL');
          console.log('[useActiveEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('');
        }

        // 🆕 Check if cumulative values are all zero — but only trigger the
        // backend fallback when there are meals/doses AFTER today's reset that
        // should have contributed.  If every item is legitimately pre-reset
        // (e.g. the user hasn't eaten yet today) then zero is CORRECT and
        // fetching the backend just wastes bandwidth and causes extra re-renders.
        const cumulativeIsZero = (
          (netEffect?.cumulativeMealEffect || 0) === 0 &&
          (netEffect?.cumulativeInsulinEffect || 0) === 0 &&
          (netEffect?.cumulativeBaseline || 0) === 0
        );

        // Determine the daily reset boundary so we can count post-reset items
        const resetHour = constants.daily_reset_hour ?? 7;
        const tzOffset  = constants.timezone_offset_minutes ?? 0;
        const utcMidnight = new Date(currentTime);
        utcMidnight.setUTCHours(0, 0, 0, 0);
        const patientMidnight = new Date(utcMidnight.getTime() - tzOffset * 60 * 1000);
        const todayResetMs = patientMidnight.getTime() + resetHour * 60 * 60 * 1000;
        const lastResetMs  = currentTime.getTime() >= todayResetMs
          ? todayResetMs
          : todayResetMs - 24 * 60 * 60 * 1000;

        const mealsAfterReset = meals.filter(m => {
          const ts = String((m as any).timestamp ?? '');
          const hasZone = ts.endsWith('Z') || ts.includes('+') || /T.*-\d{2}:\d{2}$/.test(ts);
          const ms = hasZone ? new Date(ts).getTime() : new Date(ts.replace(' ', 'T') + 'Z').getTime();
          return !isNaN(ms) && ms >= lastResetMs;
        });
        const dosesAfterReset = insulinDoses.filter(d => {
          const ts = String((d as any).taken_at ?? (d as any).administrationTime ?? '');
          const hasZone = ts.endsWith('Z') || ts.includes('+') || /T.*-\d{2}:\d{2}$/.test(ts);
          const ms = hasZone ? new Date(ts).getTime() : new Date(ts.replace(' ', 'T') + 'Z').getTime();
          return !isNaN(ms) && ms >= lastResetMs;
        });
        const hasPostResetData = mealsAfterReset.length > 0 || dosesAfterReset.length > 0;

        if (cumulativeIsZero && hasPostResetData && useFallback && resolvedMode !== 'preset') {
          console.warn('[useActiveEffects] ⚠️ All cumulative values are 0 - using backend fallback');
          const backend = await fetchBackendFallback();

          if (backend) {
            // Map backend data to frontend structure
            netEffect = {
              ...netEffect,
              cumulativeMealEffect: backend.cumulative?.cumulative_meal_effect ||
                                   backend.cumulative_meal_effect || 0,
              cumulativeInsulinEffect: backend.cumulative?.cumulative_insulin_effect ||
                                      backend.cumulative_insulin_effect || 0,
              cumulativeBaseline: backend.cumulative?.cumulative_net_baseline ||
                                  backend.cumulative_net_baseline || 0,
            } as NetEffectResult;

            console.log('[useActiveEffects] ✅ Backend fallback applied:', {
              cumulativeMeal: netEffect.cumulativeMealEffect,
              cumulativeInsulin: netEffect.cumulativeInsulinEffect,
              cumulativeBaseline: netEffect.cumulativeBaseline,
            });
          }
        }

        setNetEffectDetails(netEffect);

      } catch (err) {
        console.error('[useActiveEffects] ❌ Net effect calculation failed:', err);
        setCalculationErrors(prev => [...prev, 'Net effect calculation failed']);

        // Try backend fallback on error
        if (useFallback) {
          await fetchBackendFallback();
        }
      }

      setLastUpdate(new Date());
      setIsLoading(false);

    } catch (err) {
      console.error('[useActiveEffects] ❌ Error calculating active effects:', err);
      setError(err instanceof Error ? err.message : 'Calculation error');
      setCalculationErrors(prev => [...prev, 'General calculation error']);
      setIsLoading(false);
    }
  }, [constants, constantsLoading, meals, insulinDoses, latestReading, debug, useFallback, fetchBackendFallback]);

  /**
   * Refresh calculations
   */
  const refresh = useCallback(async () => {
    lastCalculationMinute.current = 0;

    if (debug) {
      console.log('[useActiveEffects] 🔄 Manual refresh triggered');
    }

    // Only fetch — the useEffect watching [meals, insulinDoses, latestReading]
    // will trigger calculateEffects() once state propagates, avoiding the
    // stale-closure bug where calculateEffects() would see the old empty arrays.
    await fetchData();
  }, [fetchData, debug]);

  // ── Stable ref so the polling effect never needs fetchData in its dep array ──
  // fetchData is a useCallback that changes whenever token/debug/windowHours
  // changes. Putting it directly in the effect's dep array caused the effect
  // to re-run (and therefore re-register the interval) on every parent
  // re-render, stacking concurrent fetch loops on Render free tier until
  // timeouts occurred. The ref always points to the latest version of
  // fetchData without being a reactive dependency.
  const fetchDataRef = useRef(fetchData);
  useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);

  // Auto-refresh setup — aligned to minute boundary (:00 seconds)
  // Mirrors the pattern used in ActiveEffectsDisplay so all live data
  // updates fire at the same wall-clock tick as the chart recalculation
  // driven by useCurrentMinute() in ChartUtils.
  useEffect(() => {
    if (!autoRefresh || constantsLoading) return;  // ✅ FIX: wait for real constants

    if (debug) {
      console.log('[useActiveEffects] ⚙️ Setting up auto-refresh (minute-aligned):', refreshInterval, 'ms');
    }

    // Immediate fetch on mount so data is available right away.
    // calculateEffects() is triggered reactively via the useEffect below
    // that watches fetchedData — calling calculateEffects directly here
    // would capture stale closure values.
    fetchDataRef.current();

    // Snap the first interval tick to the next :00 boundary, then keep a
    // steady 60 s cadence from there — same as ActiveEffectsDisplay.
    const msUntilNextMinute = 60_000 - (Date.now() % 60_000);
    let intervalId: ReturnType<typeof setInterval>;

    const timeoutId = setTimeout(() => {
      fetchDataRef.current();
      intervalId = setInterval(() => fetchDataRef.current(), refreshInterval);
      refreshTimer.current = intervalId;
    }, msUntilNextMinute);

    return () => {
      clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
      if (refreshTimer.current) {
        clearInterval(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  // fetchData intentionally EXCLUDED — the ref pattern above handles updates.
  // Including fetchData here caused an infinite re-registration loop.
  }, [autoRefresh, refreshInterval, debug, constantsLoading]);

  // Calculate when data changes — fires once per fetch because fetchedData is
  // updated atomically (all three fields land in one setState call above).
  // The old pattern watched [meals, insulinDoses, latestReading] separately,
  // which triggered up to 3 calculateEffects() calls per fetch cycle.
  useEffect(() => {
    if (fetchedData.ready && (fetchedData.meals.length > 0 || fetchedData.doses.length > 0 || fetchedData.reading)) {
      calculateEffects();
    }
  }, [fetchedData, constants, calculateEffects]);

  // Extract display values with backend fallback
  const extractValue = (
    frontendValue: any,
    backendPath: string,
    defaultValue: any = 0
  ) => {
    if (usingBackend && backendData) {
      const keys = backendPath.split('.');
      let value = backendData;
      for (const key of keys) {
        value = value?.[key];
      }
      return value ?? defaultValue;
    }
    return frontendValue ?? defaultValue;
  };

  const stableBaseline = baselineDetails?.stableBaseline ??
                        (usingBackend ? backendData?.bg_estimates?.stable_baseline : null);
  const estimatedBG = netEffectDetails?.estimatedBG ??
                     (usingBackend ? backendData?.bg_estimates?.current_estimated_bg : null);
  const projectedFinalBG = netEffectDetails?.projectedFinalBG ?? null;

  const totalIOB = extractValue(netEffectDetails?.totalIOB, 'iob.total_active_insulin');
  const totalMOB = extractValue(netEffectDetails?.totalMOB, 'mob.total_active_carbs');
  const activeInsulinEffect = extractValue(netEffectDetails?.activeInsulinEffect, 'iob.total_bg_reduction');
  const activeMealEffect = extractValue(netEffectDetails?.activeMealEffect, 'mob.expected_bg_impact');
  const currentNetEffect = extractValue(netEffectDetails?.currentNetEffect, 'net_effect');

  const cumulativeMealEffect = extractValue(
    netEffectDetails?.cumulativeMealEffect,
    'cumulative.cumulative_meal_effect'
  );
  const cumulativeInsulinEffect = extractValue(
    netEffectDetails?.cumulativeInsulinEffect,
    'cumulative.cumulative_insulin_effect'
  );
  const cumulativeNetBaseline = extractValue(
    netEffectDetails?.cumulativeBaseline,
    'cumulative.cumulative_net_baseline'
  );

  const safetyStatus = netEffectDetails?.safetyStatus ?? null;
  const trend = netEffectDetails?.trend ?? null;

  return {
    // Display Values
    stableBaseline,
    estimatedBG,
    projectedFinalBG,

    // Active Effects
    totalIOB,
    totalMOB,
    activeInsulinEffect,
    activeMealEffect,
    currentNetEffect,

    // Cumulative Effects
    cumulativeMealEffect,
    cumulativeInsulinEffect,
    cumulativeNetBaseline,

    // Safety & Trends
    safetyStatus,
    trend,

    // Detailed Breakdowns
    baselineDetails,
    netEffectDetails,

    // Backend fallback
    backendData,
    usingBackend,

    // Raw fetched arrays — consumed by EffectsVisualizationChart so it can
    // pass real Meal / InsulinDose objects to processMealsForChart /
    // processInsulinForChart without making a second network request.
    meals,
    insulinDoses,

    // Meta
    isLoading,
    error,
    lastUpdate,
    calculationErrors,

    // Active baseline mode
    baselineMode: resolvedBaselineMode,

    // Baseline sanitization
    baselineWarnings,
    baselineSanitizeStatus,

    // Actions
    refresh,
    setMeals,
    setInsulinDoses,
    setLatestReading,
  };
}

export default useActiveEffects;