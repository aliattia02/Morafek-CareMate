/**
 * ============================================================================
 * BLOOD GLUCOSE VISUALIZATION — Mobile Port (React Native)
 * ============================================================================
 *
 * Ported from: frontend/src/components/BloodSugarVisualization.js (v3.0)
 * Location:    mobile/components/charts/BloodGlucoseVisualization.tsx
 *
 * v1.1 FIXES — cumulative effect area was always invisible:
 *
 *   FIX 1 — normaliseMeal() now resolves all backend timestamp aliases
 *            (meal_time, logged_at, created_at, takenAt) in addition to
 *            `timestamp`. Without this, parseUTCMs(m?.timestamp) returned NaN
 *            for every meal because the backend often shapes meals with
 *            meal_time as the date key. This made allMealsInWindow always [],
 *            so calculateTotalCumulativeEffects was never called, and
 *            cumulativeNetBaseline was 0 for every chart point → the
 *            VictoryArea fill collapsed to zero height and was invisible
 *            despite the toggle being on.
 *
 *   FIX 2 — netEffectData now anchors to p.baseBG (baked into each chart
 *            point at generation time) instead of the outer effectiveBaseline
 *            (derived async from stableBaseline). This keeps the net-effect
 *            area and the cumulative area on the same baseline, preventing
 *            visual misalignment when stableBaseline resolves after chart
 *            generation has already run.
 *
 * v1.2 FIXES — align allMealsInWindow / allDosesInWindow with
 *              EffectsVisualizationChart.tsx reset-hour handling:
 *
 *   FIX 3 — allMealsInWindow now adds `mealMs <= now` upper bound so future
 *            meals are excluded from the cumulative bank-balance calculation.
 *            calculateMealCumulativeEffect already guards against this, but the
 *            explicit upper bound reduces array size and matches the intent of
 *            the EffectsVisualizationChart pattern.
 *
 *   FIX 4 — allMealsInWindow lower bound now documented as
 *            Math.min(rangeStart, lastResetMs). For '12h'/'24h' views
 *            rangeStart already equals the daily reset boundary so both are
 *            equivalent. For short views (e.g. '6h' at noon: rangeStart=8AM,
 *            reset=7AM) using lastResetMs ensures post-reset meals eaten
 *            BEFORE rangeStart are counted in the bank balance — matching the
 *            JS version's behaviour and preventing a 0-height cumulative area
 *            for the first hour after the reset window opens.
 *
 *   FIX 5 — Verbose / partially-incorrect comment block replaced with a
 *            concise explanation matching EffectsVisualizationChart.tsx so the
 *            two components stay easy to cross-reference.
 *
 * v1.3 FIXES — useGlucoseReadings returning far fewer points than JS version:
 *
 *   ROOT CAUSE A — Wrong API parameter names:
 *     The hook was sending `start` / `end` but the backend expects
 *     `start_time` / `end_time` (matching glucose.ts → GetGlucoseParams).
 *     The backend silently ignored the unknown keys, so no server-side
 *     filtering occurred and the response shape was unpredictable.
 *
 *   ROOT CAUSE B — Missing filter_by=reading_time:
 *     BloodSugarDataContext.js always passes `filter_by=reading_time` so the
 *     backend filters by bloodSugarTimestamp (actual reading time) rather than
 *     the database insertion timestamp. Without this, readings taken hours
 *     before insertion could fall outside the query window.
 *
 *   ROOT CAUSE C — Narrow fetch window tied to chart range:
 *     The JS context always pre-fetches a FULL 24-hour buffer and filters
 *     client-side. The TSX version was fetching only the visible chart range
 *     (e.g. 12h). A race condition (rangeStart not yet stable after the
 *     ChartUtils 7 AM anchor correction) caused the first fetch to fire with
 *     a future rangeStart → zero readings returned.
 *
 *   FIX 6 — useGlucoseReadings now:
 *     1. Always fetches a full 24-hour buffer using start_time / end_time
 *        with filter_by=reading_time (matching BloodSugarDataContext.js line 488)
 *     2. Also resolves bloodSugarTimestamp (the primary backend field name for
 *        LibreLinkUp / manual readings) in the timestamp normalisation map.
 *     3. Filters the 24h buffer client-side to [rangeStart, rangeEnd] before
 *        exposing `readings` to the chart, matching the JS pattern exactly and
 *        eliminating the rangeStart race condition.
 *
 * v1.4 FIX — historical readings only showing ~2 days regardless of selected range:
 *
 *   ROOT CAUSE — useGlucoseReadings always fetched a fixed 24-hour buffer
 *     (now-24h → now) regardless of the active time range. When the user
 *     selected 3D, week, or month views the buffer was capped at 24h, so
 *     actual reading dots and the connected-readings line only appeared for
 *     the most recent day even though the chart x-axis spanned the full range.
 *     The doctor chart avoids this by receiving all blood-sugar data as a prop
 *     and filtering client-side — this fix mirrors that behaviour.
 *
 *   FIX 7 — useGlucoseReadings now:
 *     1. Fetches from rangeStart → now (instead of now-24h → now), so the
 *        buffer covers the full selected time window.
 *     2. Adds rangeStart as a useCallback dep so a new fetch fires when the
 *        user switches to a longer view (3D, week, month).
 *     3. Keeps rangeEnd out of the dep list — no future readings exist, so
 *        the live "now" tick should not trigger a re-fetch.
 *     4. The client-side filter memo is unchanged — slices the buffer to
 *        [rangeStart, rangeEnd] synchronously on every tick.
 *
 * CHART LIBRARY: victory-native
 *   Install: npx expo install victory-native react-native-svg
 *
 * KEY DIFFERENCES FROM WEB VERSION:
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. DATA SOURCE
 *    Web:    useBloodSugarData() context → recentMealsData, last24hData,
 *            adjustedBaselineForProjection
 *    Mobile: useActiveEffects() → meals / insulinDoses / stableBaseline
 *            + local useGlucoseReadings() hook for actual BG readings.
 *
 * 2. CHART GENERATION
 *    Web:    generateChartTimeline() (async service call)
 *    Mobile: buildBGChartPoint() per time-point using the same mobile
 *            calculation stack as EffectsVisualizationChart + BG projection.
 *
 * 3. DUAL-AXIS APPROACH
 *    Web:    Recharts ComposedChart with two yAxisId (glucose left, cumulative right)
 *    Mobile: Single Victory Y-axis [40-400 mg/dL].
 *            Cumulative effect rendered as VictoryArea fill BETWEEN baseBG
 *            and estimatedBG (same y-space, no manual scaling needed).
 *            Right-axis delta labels via a secondary VictoryAxis.
 *
 * 4. CONFIDENCE LINES
 *    Web:    highConfidenceBG (solid) + lowConfidenceBG (dashed) series
 *    Mobile: Same split — two VictoryLine series with null gaps for inactive
 *            segments. Confidence derived from minutes-since-last-reading.
 *
 * 5. ACTUAL READING DOTS
 *    Web:    Custom SVG dots via dot renderer callback
 *    Mobile: VictoryScatter with per-datum style callback for status colours.
 *
 * 6. NO FULLSCREEN API
 *    document.requestFullscreen() removed; sticky tooltip replaced with
 *    the React Native Modal pattern (matching EffectsVisualizationChart).
 *
 * SERIES RENDERED (all toggleable):
 *   📈 Estimated BG     (purple/blue solid line)  — showEstimatedLine
 *   🔵 Baseline BG      (blue dashed step line)   — showBaseline
 *   🟠 Cumulative Area  (orange fill, right axis) — showCumulativeEffect
 *   🟢 Net Effect Area  (green fill, right axis)  — showNetEffect
 *   🔴 Actual Readings  (coloured scatter dots)   — showActualReadings
 *   🎯 Target / High / Low reference lines        — showTargetRange
 * ============================================================================
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Switch,
  ActivityIndicator,
  StyleSheet,
  Dimensions,
  Modal,
  Platform,
} from 'react-native';

// ── Chart library ──────────────────────────────────────────────────────────────
import {
  VictoryChart,
  VictoryArea,
  VictoryLine,
  VictoryAxis,
  VictoryTheme,
  VictoryScatter,
} from 'victory-native';

// ── Mobile calculation stack ───────────────────────────────────────────────────
import { calculateStackedMealEffect } from '@/utils/glucose/meal-pharmacodynamics';
import {
  calculateStackedInsulinEffect,
  calculateStackedInsulinChartEffect,
} from '@/utils/insulin/pharmacodynamics';
import { calculateTotalCumulativeEffects } from '@/utils/calculations';
import { MEAL_ABSORPTION_PROFILES, getCircadianBaseline } from '@/constants/shared-constants';

// ── Hooks ──────────────────────────────────────────────────────────────────────
import { useActiveEffects } from '@/hooks/useActiveEffects';
import { usePatientConstants } from '@/hooks/usePatientConstants';
import UnifiedTimePicker from '@/components/forms/UnifiedTimePicker';

// ── API client ─────────────────────────────────────────────────────────────────
import apiClient from '@/services/api/client';
import API from '@/services/api/endpoints';

// ── Chart utilities ────────────────────────────────────────────────────────────
import {
  useCurrentMinute,
  useChartTimeRange,
  processContextMealsForChart,
  processContextInsulinForChart,
  generateXAxisTicks,
  getBloodSugarStatusColor,
  getConfidenceLevel,
  findMealsAtTime,
  findInsulinAtTime,
  parseUTCMs,
  VIEW_CONFIGS,
  getLastResetTimeMs,
  getMealDurationHours,
  normaliseDose,
  doseToStacking,
  formatXAxis,
  type TimeRange,
} from '@/utils/ChartUtils';



// ============================================================
// CONSTANTS
// ============================================================

// VIEW_CONFIGS is imported from ChartUtils (merges shared-constants with safe defaults)

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CHART_HEIGHT  = 320;
const CHART_WIDTH   = SCREEN_WIDTH - 32;

/** Primary BG axis domain — keeps chart stable regardless of actual readings. */
const BG_DOMAIN: [number, number] = [40, 400];

/** Cumulative effect deltas shown on the right axis (in mg/dL from baseline). */
const CUMULATIVE_DELTAS = [-150, -100, -50, 0, 50, 100, 150];

const ACTIVE_EFFECTS_OPTIONS_BASE = {
  autoRefresh:     true,
  refreshInterval: 60_000,
  debug:           false,
  skipIobCutoff:   true,  // chart re-filters doses per point; 48h pre-filter is redundant here
};

const LOAD_TIMEOUT_MS = 8_000;

// ============================================================
// TYPES
// ============================================================

interface BGChartPoint {
  timestamp:  number;
  formattedTime: string;

  // ── Blood glucose series (left Y-axis, 40-400 mg/dL) ──
  /** Non-null only at actual reading timestamps. */
  actualBG:          number | null;
  /** Constant stable baseline for the current day. */
  baseBG:            number;
  /** baseline + cumulativeNetBaseline — shown when confidence ≥ high. */
  highConfidenceBG:  number | null;
  /** baseline + cumulativeNetBaseline — shown when confidence < high. */
  lowConfidenceBG:   number | null;

  // ── Cumulative "bank balance" (drives the area fill) ──
  cumulativeNetBaseline:   number;
  cumulativeMealEffect:    number;
  cumulativeInsulinEffect: number;

  // ── Instantaneous rate-of-change ──
  netEffect:     number;
  mealImpact:    number;
  insulinImpact: number;

  // ── Metadata ──
  isActualReading: boolean;
  isHistorical:    boolean;
  isFuture:        boolean;
  isNow:           boolean;
  confidenceLevel: string;
  confidenceColor: string;

  // ── Dose markers for tooltip ──
  mealsAdministered:   any[];
  insulinAdministered: any[];
}

interface TooltipData {
  point: BGChartPoint;
}

export interface BloodGlucoseVisualizationProps {
  height?:        number;
  showControls?:  boolean;
  embedded?:      boolean;
  defaultView?:   string;
  onDataUpdate?:  (data: BGChartPoint[]) => void;
}

// ============================================================
// HELPERS (same pattern as EffectsVisualizationChart)
// ============================================================

// parseUTCMs, getLastResetTimeMs, getMealDurationHours, normaliseDose,
// doseToStacking, and formatXAxis are all imported from ChartUtils.

/** Normalise a raw meal: resolve every timestamp alias the backend might use.
 *  Kept local because it carries extra timestamp-alias resolution logic specific
 *  to the BG visualization that differs from the EffectsVisualizationChart version. */
function normaliseMeal(raw: any): any {
  const timestamp =
    raw.timestamp  ??
    raw.meal_time  ??
    raw.logged_at  ??
    raw.created_at ??
    raw.takenAt    ??
    null;

  return {
    ...raw,
    id:                  raw.id ?? String(raw._id ?? ''),
    timestamp,
    calculation_summary: raw.calculation_summary ?? {},
    nutrition:           raw.nutrition ?? {},
  };
}

// ============================================================
// PER-POINT CALCULATION
// ============================================================

/**
 * Build a single chart data point for the BG visualization.
 *
 * Calculates:
 *   1. Instantaneous meal / insulin effects (mealImpact, insulinImpact)
 *   2. Cumulative "bank balance" (cumulativeNetBaseline)
 *   3. BG projection = stableBaseline + cumulativeNetBaseline
 *   4. Confidence classification (drives high/low confidence line split)
 *   5. Actual reading overlay (matched from the readings array)
 */
function buildBGChartPoint(
  targetTimestamp:   number,
  processedMeals:    any[],
  processedInsulin:  any[],
  allMealsInWindow:  any[],
  allDosesInWindow:  any[],
  actualReadings:    Array<{ timestamp: number; bloodSugar: number }>,
  stableBaseline:    number,
  patientConstants:  any,
  minutesSinceReading: number,
  now:               number,
  halfIntervalMs:    number,
  viewConfig:        any,
  baselineMode?:     'dynamic' | 'preset',
  circadianProfile?: any,
): BGChartPoint {
  const targetTime = new Date(targetTimestamp);
  const isHistorical = targetTimestamp <= now;
  const isFuture     = targetTimestamp > now;
  const isNow        = Math.abs(targetTimestamp - now) < halfIntervalMs;

  const resetHour: number = patientConstants?.daily_reset_hour ?? 7;
  const tzOffset:  number = patientConstants?.timezone_offset_minutes ?? 0;
  const correctionFactor  = patientConstants?.correction_factor ?? 40;

  // baseBG: in preset mode evaluate the circadian curve at this specific hour;
  // in dynamic mode use the single back-calculated baseline (existing behaviour).
  const pointHour = ((targetTimestamp + tzOffset * 60_000) / 3_600_000) % 24;
  const baseBG = (baselineMode === 'preset' && circadianProfile)
    ? getCircadianBaseline(pointHour, circadianProfile)
    : stableBaseline;

  // ── Actual reading at this time slot ──────────────────────────────────────
  let actualBG: number | null = null;
  let isActualReading = false;
  for (const reading of actualReadings) {
    if (Math.abs(reading.timestamp - targetTimestamp) <= halfIntervalMs) {
      actualBG = reading.bloodSugar;
      isActualReading = true;
      break;
    }
  }

  // ── Meal effect (instantaneous rate-of-change) ────────────────────────────
  const activeMealsAtTime = processedMeals.filter((meal: any) => {
    const mealMs = typeof meal.timestamp === 'number'
      ? meal.timestamp
      : parseUTCMs(meal.timestamp);
    if (isNaN(mealMs) || mealMs > targetTimestamp) return false;
    return (targetTimestamp - mealMs) / (1_000 * 60 * 60) < getMealDurationHours(meal);
  });

  const mealResult = activeMealsAtTime.length > 0
    ? calculateStackedMealEffect(activeMealsAtTime, targetTime, patientConstants)
    : { totalBGElevation: 0 };
  const safeNumInline = (v: any): number => (typeof v === 'number' && !isNaN(v) && isFinite(v)) ? v : 0;
  const mealImpact = safeNumInline((mealResult as any)?.totalBGElevation);

  // ── Insulin effect (cumulative S-curve for chart area) ─────────────────────
  const dosesForStacking: InsulinDoseForStacking[] = processedInsulin
    .map((dose: any) => doseToStacking(dose, targetTime))
    .filter((d): d is InsulinDoseForStacking => d !== null);

  const chartInsulinResult = dosesForStacking.length > 0
    ? calculateStackedInsulinChartEffect(dosesForStacking, correctionFactor)
    : { totalBGImpact: 0, totalIOB: 0 };
  const insulinImpact = safeNumInline(chartInsulinResult.totalBGImpact); // always <= 0

  const netEffect = mealImpact + insulinImpact;

  // ── Cumulative baseline ("bank balance" at this time) ─────────────────────
  const allMealsUpToNow = allMealsInWindow.filter((meal: any) => {
    const ms = parseUTCMs(meal?.timestamp);
    return !isNaN(ms) && ms <= targetTimestamp;
  });
  const allDosesUpToNow = allDosesInWindow.filter((dose: any) => {
    const ms = parseUTCMs(dose?.administrationTime);
    return !isNaN(ms) && ms <= targetTimestamp;
  });

  const cumulative = (allMealsUpToNow.length > 0 || allDosesUpToNow.length > 0)
    ? calculateTotalCumulativeEffects(
        allMealsUpToNow,
        allDosesUpToNow,
        targetTime,
        patientConstants,
        MEAL_ABSORPTION_PROFILES as any,
        resetHour,
        tzOffset,
      )
    : { cumulativeMealEffect: 0, cumulativeInsulinEffect: 0, cumulativeNetBaseline: 0 };

  const safeNum = (v: any): number => (typeof v === 'number' && !isNaN(v) && isFinite(v)) ? v : 0;
  const cumulativeNetBaseline   = safeNum((cumulative as any).cumulativeNetBaseline);
  const cumulativeMealEffect    = safeNum((cumulative as any).cumulativeMealEffect);
  const cumulativeInsulinEffect = safeNum((cumulative as any).cumulativeInsulinEffect);

  // ── BG projection ──────────────────────────────────────────────────────────
  const estimatedBG = baseBG + cumulativeNetBaseline;

  // ── Confidence classification ─────────────────────────────────────────────
  const confidenceInfo = getConfidenceLevel(
    { isActualReading, isFuture, timestamp: targetTimestamp },
    minutesSinceReading
  );
  const isHighConfidence =
    confidenceInfo.level === 'actual' ||
    confidenceInfo.level === 'high' ||
    confidenceInfo.level === 'projected_high';

  // ── Dose markers ──────────────────────────────────────────────────────────
  const mealsAtTime   = findMealsAtTime(processedMeals, targetTimestamp, halfIntervalMs);
  const insulinAtTime = findInsulinAtTime(processedInsulin, targetTimestamp, halfIntervalMs);

  return {
    timestamp:    targetTimestamp,
    formattedTime: formatXAxis(targetTimestamp, viewConfig?.tickFormat),

    actualBG,
    baseBG,
    highConfidenceBG: isHighConfidence ? (actualBG ?? estimatedBG) : null,
    lowConfidenceBG:  !isHighConfidence ? estimatedBG : null,

    cumulativeNetBaseline,
    cumulativeMealEffect,
    cumulativeInsulinEffect,

    netEffect,
    mealImpact,
    insulinImpact,

    isActualReading,
    isHistorical,
    isFuture,
    isNow,
    confidenceLevel: confidenceInfo.level,
    confidenceColor: confidenceInfo.color,

    mealsAdministered:   mealsAtTime,
    insulinAdministered: insulinAtTime,
  };
}

// ============================================================
// GLUCOSE READINGS HOOK  (v1.3 — matches JS BloodSugarDataContext pattern)
// ============================================================

interface GlucoseReading {
  timestamp:  number;
  bloodSugar: number;
  source?:    string;
}

/**
 * Fetch blood glucose readings for the full selected time range.
 *
 *   1. Fetches the entire [rangeStart, now] window using the correct backend
 *      param names `start_time` / `end_time` with `filter_by=reading_time`.
 *      This matches the doctor chart's behaviour: readings are fetched for the
 *      full selected range (not just the last 24 hours), so switching to a 3D,
 *      week, or month view shows actual readings across that whole period.
 *
 *      For views with a future window (rangeEnd > now) the fetch upper bound is
 *      capped at `now` — there are no future readings to retrieve.
 *
 *   2. Filters the fetched buffer client-side to [rangeStart, rangeEnd] before
 *      exposing `readings` to the chart, eliminating the rangeStart race-condition
 *      that caused 0 readings on first render when the ChartUtils 7AM anchor
 *      correction fires.
 *
 *   3. Timestamp normalisation resolves `bloodSugarTimestamp` first — the
 *      primary field name for both LibreLinkUp CGM readings and manual entries
 *      returned by the /api/blood-sugar endpoint.
 *
 * Refresh strategy:
 *   • On rangeStart change: a new fetch fires immediately to load the wider window.
 *   • On interval: re-fetches every refreshIntervalMs (default 60s) to pick up
 *     new readings at the leading edge.
 *   • rangeEnd-only changes (e.g. live "now" tick) only trigger a client-side
 *     re-filter via the derived `readings` memo — no extra network request.
 */
function useGlucoseReadings(
  rangeStart: number,
  rangeEnd:   number,
  refreshIntervalMs = 60_000,
): {
  readings:   GlucoseReading[];
  isLoading:  boolean;
  error:      string | null;
  refresh:    () => void;
} {
  // Buffer covers [rangeStart, now] — re-populated when rangeStart changes.
  const [buffer,    setBuffer]    = useState<GlucoseReading[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error,     setError]     = useState<string | null>(null);

  // ── Fetch the full range window ───────────────────────────────────────────
  // rangeStart is a dep so the buffer is refreshed whenever the user picks a
  // longer view (e.g. 24h → 3D → week). We cap the upper bound at `now`
  // because the API holds no future readings.
  const fetchBuffer = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const now         = Date.now();
      const fetchStart  = rangeStart;           // honour the full selected window
      const fetchEnd    = Math.min(rangeEnd, now); // no future readings exist

      // ✅ FIX A: Use start_time / end_time — the param names the backend
      //           actually reads (matching glucose.ts → GetGlucoseParams and
      //           BloodSugarDataContext.js line 488).
      //
      // ✅ FIX B: filter_by=reading_time tells the backend to filter on
      //           bloodSugarTimestamp (when the reading was TAKEN) rather than
      //           the database insertion timestamp. Without this, a reading
      //           taken at 8 PM but inserted at midnight could be excluded from
      //           an 8 PM–8 AM query window.
      const response: any = await (apiClient as any).get(API.BLOOD_SUGAR.LIST, {
        params: {
          start_time: new Date(fetchStart).toISOString(),
          end_time:   new Date(fetchEnd).toISOString(),
          filter_by:  'reading_time',
        },
      });

      // Normalise to a consistent shape. Handle both array and {data:[...]} shapes.
      const raw: any[] = Array.isArray(response)
        ? response
        : response?.data ?? response?.readings ?? [];

      const normalised: GlucoseReading[] = raw
        .map((r: any) => {
          // ✅ FIX C: bloodSugarTimestamp is the primary field name returned by
          //           the /api/blood-sugar endpoint for both CGM (LibreLinkUp)
          //           and manual readings. It must be checked FIRST before the
          //           generic aliases, otherwise every reading from this endpoint
          //           falls back to NaN and is discarded by the .filter() below.
          const ts =
            r.bloodSugarTimestamp != null ? parseUTCMs(r.bloodSugarTimestamp) :
            r.timestamp           != null ? parseUTCMs(r.timestamp) :
            r.readingTime         != null ? parseUTCMs(r.readingTime) :
            r.reading_time        != null ? parseUTCMs(r.reading_time) :
            r.taken_at            != null ? parseUTCMs(r.taken_at) : NaN;

          const bg =
            r.bloodSugar   ?? r.blood_sugar  ??
            r.value        ?? r.glucose_value ?? NaN;

          return {
            timestamp:  ts,
            bloodSugar: Number(bg),
            source:     r.source ?? 'meter',
          };
        })
        .filter(r => !isNaN(r.timestamp) && !isNaN(r.bloodSugar) && r.bloodSugar > 0)
        .sort((a, b) => a.timestamp - b.timestamp);

      setBuffer(normalised);
      console.log(
        `[BloodGlucoseVisualization] fetched ${normalised.length} readings ` +
        `from ${new Date(rangeStart).toISOString()} → now (${raw.length} raw)`
      );
    } catch (err: any) {
      console.warn('[BloodGlucoseVisualization] readings fetch failed:', err?.message);
      setError(err?.message ?? 'Failed to load readings');
    } finally {
      setIsLoading(false);
    }
  // rangeStart is a dep: a wider view (3D, week, month) must trigger a new
  // fetch to load readings beyond the old window.
  // rangeEnd is intentionally omitted — the live "now" tick advances rangeEnd
  // every minute but there are no new future readings to fetch for that extra minute.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeStart]);

  // Fetch immediately whenever rangeStart changes (i.e. the user switches view
  // mode), then keep the buffer fresh on a minute-boundary-aligned interval.
  // The minute-boundary alignment ensures this fetch fires at the same wall-clock
  // tick as useCurrentMinute() → chart recalculation, so the chart never
  // re-renders with stale readings on the first tick of a new minute.
  useEffect(() => {
    fetchBuffer();

    const msUntilNextMinute = 60_000 - (Date.now() % 60_000);
    let intervalId: ReturnType<typeof setInterval>;

    const timeoutId = setTimeout(() => {
      fetchBuffer();
      intervalId = setInterval(fetchBuffer, refreshIntervalMs);
    }, msUntilNextMinute);

    return () => {
      clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
    };
  }, [fetchBuffer, refreshIntervalMs]);

  // ── FIX D: Client-side range filter — mirrors JS: last24hData.filter(...) ──
  // This is derived synchronously so the chart always sees the correct slice
  // for the active view without waiting for a network round-trip.
  const readings = useMemo(
    () => buffer.filter(r => r.timestamp >= rangeStart && r.timestamp <= rangeEnd),
    [buffer, rangeStart, rangeEnd]
  );

  return { readings, isLoading, error, refresh: fetchBuffer };
}


// ============================================================
// CUSTOM VIEW CONFIG  — auto-selects tick density from duration
// ============================================================

function getCustomViewConfig(start: Date, end: Date): any {
  const durationHours = (end.getTime() - start.getTime()) / 3_600_000;
  const futureHours   = Math.max(0, (end.getTime() - Date.now()) / 3_600_000);
  const pastHours     = Math.max(0, (Date.now() - start.getTime()) / 3_600_000);
  let tickFormat: string;
  let tickInterval: number;
  let interpolationInterval: number;
  if (durationHours <= 6)        { tickFormat = 'HH:mm'; tickInterval = 1;  interpolationInterval = 5;  }
  else if (durationHours <= 24)  { tickFormat = 'HH:mm'; tickInterval = 3;  interpolationInterval = 15; }
  else if (durationHours <= 72)  { tickFormat = 'DD/MM'; tickInterval = 12; interpolationInterval = 30; }
  else if (durationHours <= 168) { tickFormat = 'DD/MM'; tickInterval = 24; interpolationInterval = 60; }
  else                           { tickFormat = 'DD/MM'; tickInterval = 72; interpolationInterval = 60; }
  return { label: 'Custom', pastHours, futureHours, tickInterval, tickFormat, interpolationInterval, mealLookback: pastHours, insulinLookback: pastHours };
}

// ============================================================
// MAIN COMPONENT
// ============================================================

const BloodGlucoseVisualization: React.FC<BloodGlucoseVisualizationProps> = ({
  height       = CHART_HEIGHT,
  showControls = true,
  embedded     = false,
  defaultView  = '12h',
  onDataUpdate,
}) => {
  // ── Patient constants ────────────────────────────────────────────────────────
  const { constants: patientConstants } = usePatientConstants();
  const effectiveTarget: number =
    patientConstants?.target_glucose ?? 100;

  // ── Stable callback ref (avoids deps on onDataUpdate) ────────────────────────
  const onDataUpdateRef = useRef(onDataUpdate);
  useEffect(() => { onDataUpdateRef.current = onDataUpdate; }, [onDataUpdate]);

  // ── View state ───────────────────────────────────────────────────────────────
  const [viewMode,    setViewMode]    = useState(defaultView);
  const [chartData,   setChartData]   = useState<BGChartPoint[]>([]);
  const [generating,  setGenerating]  = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  // ── Series toggles ───────────────────────────────────────────────────────────
  const [showBaseline,          setShowBaseline]          = useState(true);
  const [showActualReadings,    setShowActualReadings]    = useState(true);
  const [showEstimatedLine,     setShowEstimatedLine]     = useState(true);
  const [showTargetRange,       setShowTargetRange]       = useState(false);
  const [showNetEffect,         setShowNetEffect]         = useState(false);
  const [showCumulativeEffect,  setShowCumulativeEffect]  = useState(true);

  // ── Tooltip state ────────────────────────────────────────────────────────────
  const [tooltipData,   setTooltipData]   = useState<TooltipData | null>(null);

  // ── About this Chart accordion ───────────────────────────────────────────────
  const [aboutExpanded, setAboutExpanded] = useState(false);

  // ── Custom date-range filter ──────────────────────────────────────────────
  const [customRangeStart, setCustomRangeStart] = useState<Date>(() => new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000));
  const [customRangeEnd,   setCustomRangeEnd]   = useState<Date>(() => new Date());
  const [customApplied,    setCustomApplied]    = useState(true);


  // ── Time hooks ───────────────────────────────────────────────────────────────
  const currentMinute  = useCurrentMinute();
  // Always call hook unconditionally; override result when custom mode is active.
  const _hookTimeRange = useChartTimeRange(viewMode === 'custom' ? '24h' : viewMode, currentMinute);

  const timeRange: TimeRange = useMemo(() => {
    if (viewMode === 'custom' && customApplied) {
      return { start: customRangeStart.getTime(), end: customRangeEnd.getTime(), now: Date.now() };
    }
    return _hookTimeRange;
  }, [viewMode, customApplied, customRangeStart, customRangeEnd, _hookTimeRange]);

  const viewConfig = useMemo(() =>
    viewMode === 'custom'
      ? getCustomViewConfig(customRangeStart, customRangeEnd)
      : (VIEW_CONFIGS[viewMode] ?? VIEW_CONFIGS['12h']),
  [viewMode, customRangeStart, customRangeEnd]);

  const { start: rangeStart, end: rangeEnd } = timeRange;

  // ── Active effects options — window matches current view ─────────────────────
  // MUST be computed before useActiveEffects (avoids TDZ / "cannot access before
  // initialization" crash).  Passing windowHours causes the hook to fetch meals
  // and insulin for the full chart range from the backend (not just 24h).
  const totalViewHours = (viewConfig.pastHours ?? 24) + (viewConfig.futureHours ?? 4);
  const activeEffectsOptions = useMemo(() => ({
    ...ACTIVE_EFFECTS_OPTIONS_BASE,
    windowHours: totalViewHours,
  }), [totalViewHours]);

  // ── Active effects (meals, insulin, baseline) ────────────────────────────────
  const {
    meals:        rawMeals,
    insulinDoses: rawDoses,
    stableBaseline,
    baselineMode,
    isLoading:    effectsLoading,
    refresh:      refreshEffects,
  } = useActiveEffects(activeEffectsOptions);

  // ✅ FIX: Guard against NaN. `stableBaseline` from useActiveEffects can be NaN
  // (not null/undefined) when calculateStableBaselineFromReading receives a reading
  // whose .value field is undefined (API returns bloodSugar not value).
  // JavaScript's ?? operator does NOT catch NaN — only null/undefined — so
  // `NaN ?? fallback` returns NaN, propagating into every chart baseBG → SVG path
  // coordinates become "M56,NaN..." and the BG summary shows "NaN mg/dL".
  const effectiveBaseline: number =
    (stableBaseline !== null && stableBaseline !== undefined && !Number.isNaN(stableBaseline))
      ? stableBaseline
      : effectiveTarget;

  // ── Glucose readings ─────────────────────────────────────────────────────────
  // useGlucoseReadings now fetches a full 24h buffer and filters client-side.
  // rangeStart / rangeEnd are only used for the client-side slice — no new
  // network request fires on view-mode switch.
  const {
    readings: glucoseReadings,
    refresh:  refreshReadings,
  } = useGlucoseReadings(rangeStart, rangeEnd);

  /** Minutes since the most recent actual reading (used for confidence). */
  const minutesSinceReading = useMemo(() => {
    if (glucoseReadings.length === 0) return 999;
    const latest = glucoseReadings[glucoseReadings.length - 1].timestamp;
    return (Date.now() - latest) / 60_000;
  }, [glucoseReadings]);

  // ── Timeout escape hatch ─────────────────────────────────────────────────────
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!effectsLoading) return;
    const id = setTimeout(() => setTimedOut(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [effectsLoading]);

  const refresh = useCallback(() => {
    refreshEffects();
    refreshReadings();
  }, [refreshEffects, refreshReadings]);

  // ── Processed meals / insulin (time-range filtered) ──────────────────────────
  const processedMeals = useMemo(
    () => processContextMealsForChart(
      rawMeals.map(normaliseMeal),  // ✅ FIX: normalise first so calculation_summary
      timeRange,                    //         and timestamp aliases (meal_time etc.)
      patientConstants,             //         are resolved before chart filtering
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawMeals, rangeStart, rangeEnd, patientConstants]
  );

  const processedInsulin = useMemo(
    () => processContextInsulinForChart(rawDoses.map(normaliseDose), timeRange),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawDoses, rangeStart, rangeEnd]
  );

  // ── All-window arrays for correct cumulative baseline ────────────────────────
  // These are kept separate from processedMeals/processedInsulin: they include
  // FULLY-ABSORBED events (past their PK duration) so the persist-at-100% fix
  // in calculateTotalCumulativeEffects correctly holds their bank-balance value.
  //
  // LOWER BOUND — Math.min(rangeStart, lastResetMs):
  //   For '12h'/'24h' views rangeStart IS the daily reset boundary (useChartTimeRange
  //   anchors those views to 7AM), so both values are equal.  For short views
  //   (e.g. '6h' at noon: rangeStart=8AM but lastReset=7AM), Math.min gives 7AM,
  //   ensuring post-reset meals eaten BETWEEN the reset and rangeStart are still
  //   included in the bank balance.  This is more complete than using rangeStart
  //   alone (which would silently drop that first hour of meals from the cumulative).
  //   For multi-day views (3D): Math.min(72h_ago, today_7AM) = 72h_ago = rangeStart,
  //   so all historical meals are correctly included.
  //
  // UPPER BOUND — now:
  //   Future meals are excluded from the bank balance.
  //   calculateMealCumulativeEffect already returns 0 for mealMs > targetTime, so
  //   this is an upfront filter that reduces array size and makes intent explicit.
  //
  // Per-point daily-reset boundary is enforced INSIDE calculateTotalCumulativeEffects
  // → calculateMealCumulativeEffect / calculateInsulinCumulativeEffect, which call
  // _getLastResetTime(targetTime, resetHour, tz) for each chart point's own timestamp.
  // Each historical point therefore only counts meals/doses from its own daily window,
  // and the cumulative correctly resets to 0 at each day's reset hour.
  const { allMealsInWindow, allDosesInWindow } = useMemo(() => {
    if (!patientConstants) return { allMealsInWindow: [], allDosesInWindow: [] };

    const resetHour: number = patientConstants?.daily_reset_hour ?? 7;
    const tzOffset:  number = (patientConstants as any)?.timezone_offset_minutes ?? 0;
    const now        = Date.now();
    const lastResetMs = getLastResetTimeMs(new Date(), resetHour, tzOffset);
    // Extend lower bound to the last daily reset so that post-reset meals
    // eaten before the chart window opens (short views) are still counted.
    const startBound  = Math.min(rangeStart, lastResetMs);

    return {
      allMealsInWindow: rawMeals
        .map(normaliseMeal)
        .filter((m: any) => {
          const ms = parseUTCMs(m?.timestamp);
          // ✅ FIX: use rangeEnd (not `now`) so future-snapped meals
          // (timestamp = insulinTime + offset) are included and reach
          // calculateTotalCumulativeEffects. calculateAbsorbedFraction
          // returns 0 for points before the meal's own timestamp, so
          // including future meals here is safe.
          return !isNaN(ms) && ms >= startBound && ms <= rangeEnd;
        }),
      allDosesInWindow: rawDoses
        .map(normaliseDose)
        .filter((d: any) => {
          const ms = parseUTCMs(d?.administrationTime);
          return !isNaN(ms) && ms >= startBound && ms <= now;
        }),
    };
  // rangeStart and rangeEnd are stable primitives from timeRange — safe as deps.
  }, [rawMeals, rawDoses, patientConstants, rangeStart, rangeEnd]);

  // ── Chart generation ──────────────────────────────────────────────────────────
  const generateChartData = useCallback(() => {
    if (!patientConstants) return;

    setGenerating(true);
    setError(null);

    try {
      const { start, end, now } = timeRange;
      const intervalMs   = (viewConfig.interpolationInterval ?? 10) * 60 * 1_000;
      const halfInterval = intervalMs / 2;

      // Build normalised time-point array (minute-aligned)
      const timePoints: number[] = [];
      for (let t = start; t <= end; t += intervalMs) {
        const normalised = Math.round(t / 60_000) * 60_000;
        if (timePoints.length === 0 || timePoints[timePoints.length - 1] !== normalised) {
          timePoints.push(normalised);
        }
      }

      const points: BGChartPoint[] = timePoints.map(ts =>
        buildBGChartPoint(
          ts,
          processedMeals,
          processedInsulin,
          allMealsInWindow,
          allDosesInWindow,
          glucoseReadings,
          effectiveBaseline,
          patientConstants,
          minutesSinceReading,
          now ?? Date.now(),
          halfInterval,
          viewConfig,
          (baselineMode ?? 'dynamic') as 'dynamic' | 'preset',
          (patientConstants as any)?.circadian_profile ?? undefined,
        )
      );

      setChartData(points);
      onDataUpdateRef.current?.(points);
    } catch (err) {
      console.error('[BloodGlucoseVisualization] generateChartData error:', err);
      setError('Failed to generate chart');
    } finally {
      setGenerating(false);
    }
  }, [
    patientConstants,
    processedMeals,
    processedInsulin,
    allMealsInWindow,
    allDosesInWindow,
    glucoseReadings,
    effectiveBaseline,
    baselineMode,
    minutesSinceReading,
    timeRange,
    viewConfig,
    // onDataUpdate accessed via ref — intentionally omitted
  ]);

  // Debounced regeneration on any input change
  useEffect(() => {
    const id = setTimeout(generateChartData, 200);
    return () => clearTimeout(id);
  }, [generateChartData]);

  // ── Victory data arrays ───────────────────────────────────────────────────────

  // Connected actual readings — joins nearby readings, breaks on gaps larger than
  // a threshold that scales with the view window.
  //
  // A fixed 20-min cap was fine for CGM data (5-min intervals) but broke SMBG
  // lines completely on multi-day views: readings 3–6 hours apart each produced
  // a null break, leaving every dot isolated.
  //
  // Formula: pastHours × 12 min, floored at 20 min.
  //   3h  → 20 min   (CGM: sensor gap detection still works)
  //   12h → 120 min  (SMBG: allows up to 2h between readings)
  //   3d  → 816 min  (~13.6h — keeps SMBG readings joined across a day)
  //   week→ ~20h     (one gap per day at most)
  //   month→ ~86h    (effectively never breaks)
  const MAX_READING_GAP_MS = Math.max(20, (viewConfig.pastHours ?? 3) * 12) * 60 * 1000;
  const connectedReadingsData = useMemo(() => {
    const pts = chartData
      .filter(p => p.isActualReading && p.actualBG !== null)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (pts.length === 0) return [];
    const result: Array<{ x: number; y: number | null }> = [];
    for (let i = 0; i < pts.length; i++) {
      result.push({ x: pts[i].timestamp, y: pts[i].actualBG! });
      if (i < pts.length - 1 && pts[i + 1].timestamp - pts[i].timestamp > MAX_READING_GAP_MS) {
        result.push({ x: pts[i].timestamp + 1, y: null });
      }
    }
    return result;
  }, [chartData]);

  // Baseline step line — constant value
  const baselineData = useMemo(
    () => chartData.map(p => ({ x: p.timestamp, y: p.baseBG })),
    [chartData]
  );

  // ── Cumulative net baseline area ─────────────────────────────────────────────
  //
  // Single orange area matching BloodSugarVisualization.js exactly:
  //   JS: <Area yAxisId="cumulative" dataKey="cumulativeNetBaseline" fill="url(#gradient)" />
  //   The separate cumulative y-axis in JS auto-centres at 0, so the fill goes
  //   upward when net > 0 and downward when net < 0.
  //
  //   Mobile: y0=baseBG is the zero-line in BG space.
  //   y = baseBG + cumulativeNetBaseline — unconditional, no clamping.
  //   Fills upward (meals dominant) or downward (insulin dominant) naturally.

  const cumulativeNetData = useMemo(
    () => chartData.map(p => ({
      x:  p.timestamp,
      y:  p.baseBG + p.cumulativeNetBaseline,
      y0: p.baseBG,
    })),
    [chartData]
  );

  // Net effect area — instantaneous rate-of-change, same unconditional pattern.
  const netEffectData = useMemo(
    () => chartData.map(p => ({
      x:  p.timestamp,
      y:  p.baseBG + p.netEffect,
      y0: p.baseBG,
    })),
    [chartData]
  );

  // Actual readings scatter points (coloured by status)
  const actualReadingsData = useMemo(
    () => chartData
      .filter(p => p.isActualReading && p.actualBG !== null)
      .map(p => ({
        x:     p.timestamp,
        y:     p.actualBG!,
        color: getBloodSugarStatusColor(p.actualBG!, effectiveTarget),
        point: p,
      })),
    [chartData, effectiveTarget]
  );

  // ── Right-axis ticks (cumulative deltas, positioned in BG space) ──────────────
  const cumulativeAxisTicks = useMemo(
    () => CUMULATIVE_DELTAS.map(d => effectiveBaseline + d),
    [effectiveBaseline]
  );

  // ── X-axis ticks ─────────────────────────────────────────────────────────────
  const xTicks = useMemo(
    () => generateXAxisTicks(timeRange, viewConfig),
    [timeRange, viewConfig]
  );

  // ── Reference line values ─────────────────────────────────────────────────────
  const targetHigh = effectiveTarget * 1.3;
  const targetLow  = effectiveTarget * 0.7;

  // ── Loading / error states ────────────────────────────────────────────────────
  const showLoader = effectsLoading && !timedOut && chartData.length === 0;

  if (showLoader) {
    return (
      <View style={[styles.centered, { height }]}>
        <ActivityIndicator size="large" color="#8031A7" />
        <Text style={styles.loadingText}>Loading blood glucose data…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.centered, { height }]}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={refresh}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── "Now" point for summary strip ────────────────────────────────────────────
  const nowPoint = chartData.find(p => p.isNow) ?? chartData[Math.floor(chartData.length / 2)];
  const currentEstimatedBG = nowPoint
    ? nowPoint.baseBG + nowPoint.cumulativeNetBaseline
    : effectiveBaseline;

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.container, embedded && styles.embedded]}>

      {/* ── Header ── */}
      {showControls && (
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle}>Blood Glucose</Text>
            <Text style={styles.headerSubtitle}>
              Baseline + cumulative net effect = projected BG
            </Text>
          </View>
          <TouchableOpacity onPress={refresh} style={styles.refreshBtn} hitSlop={8}>
            <Text style={styles.refreshIcon}>
              {effectsLoading ? '⏳' : '🔄'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── View mode selector ── */}
      {showControls && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.viewModeScroll}
          contentContainerStyle={styles.viewModeRow}
        >
          {Object.entries(VIEW_CONFIGS).map(([key, cfg]) => (
            <TouchableOpacity
              key={key}
              style={[
                styles.viewModeBtn,
                viewMode === key && styles.viewModeBtnActive,
              ]}
              onPress={() => setViewMode(key)}
            >
              <Text style={[
                styles.viewModeBtnText,
                viewMode === key && styles.viewModeBtnTextActive,
              ]}>
                {(cfg as any).label ?? key}
              </Text>
            </TouchableOpacity>
          ))}
          {/* 📅 Custom date-range button */}
          <TouchableOpacity
            style={[styles.viewModeBtn, styles.viewModeBtnCustom, viewMode === 'custom' && styles.viewModeBtnActive]}
            onPress={() => setViewMode('custom')}
          >
            <Text style={[styles.viewModeBtnText, viewMode === 'custom' && styles.viewModeBtnTextActive]}>
              📅 Range
            </Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {/* ── Custom date-range panel ── */}
      {showControls && viewMode === 'custom' && (
        <View style={styles.customRangePanel}>
          <View style={styles.customRangeRow}>
            <View style={styles.customRangePicker}>
              <UnifiedTimePicker
                label="From"
                value={customRangeStart}
                onChange={(iso) => { setCustomRangeStart(new Date(iso)); setCustomApplied(false); }}
                mode="custom"
                showModeSelector
                displayFormat="datetime"
              />
            </View>
            <View style={styles.customRangePicker}>
              <UnifiedTimePicker
                label="To"
                value={customRangeEnd}
                onChange={(iso) => { setCustomRangeEnd(new Date(iso)); setCustomApplied(false); }}
                mode="custom"
                showModeSelector
                displayFormat="datetime"
              />
            </View>
          </View>
          <TouchableOpacity
            style={[styles.customRangeApplyBtn, customApplied && styles.customRangeAppliedBtn]}
            onPress={() => setCustomApplied(true)}
            disabled={customApplied}
          >
            <Text style={styles.customRangeApplyText}>
              {customApplied ? '✓ Applied' : 'Apply Range'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Series toggles ── */}
      {showControls && (
        <View style={styles.toggleGrid}>
          <ToggleRow
            label="🔵 T1D Baseline"
            color="#2196F3"
            value={showBaseline}
            onChange={setShowBaseline}
          />
          <ToggleRow
            label="🔴 Actual Readings"
            color="#E53935"
            value={showActualReadings}
            onChange={setShowActualReadings}
          />
          <ToggleRow
            label="🟣 BG Readings"
            color="#8031A7"
            value={showEstimatedLine}
            onChange={setShowEstimatedLine}
          />

          <ToggleRow
            label="🟠 Cumulative Shift ⭐"
            color="#FF9800"
            value={showCumulativeEffect}
            onChange={setShowCumulativeEffect}
            bold
          />

        </View>
      )}

      {/* ── Victory Chart ── */}
      <View style={styles.chartWrapper}>
        {chartData.length > 0 ? (
          <VictoryChart
            width={CHART_WIDTH}
            height={height}
            theme={VictoryTheme.material}
            domain={{ x: [timeRange.start, timeRange.end], y: BG_DOMAIN }}
            padding={{ top: 16, bottom: 48, left: 56, right: 56 }}
          >
            {/* X Axis — pinned to BG_DOMAIN[0] so ticks are always at the chart floor */}
            <VictoryAxis
              tickValues={xTicks}
              tickFormat={(t: number) => formatXAxis(t, viewConfig?.tickFormat)}
              axisValue={BG_DOMAIN[0]}
              style={{
                tickLabels: { fontSize: 9, angle: -45, textAnchor: 'end', fill: '#666' },
                grid:       { stroke: '#f0f0f0', strokeDasharray: '3 3' },
              }}
            />

            {/* Y Axis (left) — Blood Glucose */}
            <VictoryAxis
              dependentAxis
              tickValues={[40, 80, 100, 120, 140, 180, 200, 250, 300, 350, 400]}
              tickFormat={(v: number) => `${Math.round(v)}`}
              label="mg/dL"
              style={{
                axisLabel:  { fontSize: 10, fill: '#444', padding: 38 },
                tickLabels: { fontSize: 9,  fill: '#666' },
                grid:       { stroke: '#f0f0f0', strokeDasharray: '3 3' },
              }}
            />

            {/* Y Axis (right) — Cumulative effect deltas from baseline. */}
            {showCumulativeEffect && (
              <VictoryAxis
                dependentAxis
                orientation="right"
                tickValues={cumulativeAxisTicks}
                tickFormat={(_v: number, i: number) => {
                  const delta = CUMULATIVE_DELTAS[i];
                  return delta === 0 ? '0' : delta > 0 ? `+${delta}` : `${delta}`;
                }}
                style={{
                  axis:       { stroke: '#FF9800', strokeWidth: 1 },
                  tickLabels: { fontSize: 8, fill: '#FF9800' },
                  grid:       { stroke: 'none' },
                  ticks:      { stroke: '#FF9800', size: 4 },
                }}
              />
            )}

            {showTargetRange && (
              <VictoryAxis
                axisValue={targetHigh}
                tickFormat={() => ''}
                style={{ axis: { stroke: '#FF8800', strokeWidth: 1, strokeDasharray: '5 5' } }}
              />
            )}
            {showTargetRange && (
              <VictoryAxis
                axisValue={effectiveTarget}
                tickFormat={() => ''}
                style={{ axis: { stroke: '#4CAF50', strokeWidth: 1, strokeDasharray: '3 3' } }}
              />
            )}
            {showTargetRange && (
              <VictoryAxis
                axisValue={targetLow}
                tickFormat={() => ''}
                style={{ axis: { stroke: '#E53935', strokeWidth: 1, strokeDasharray: '5 5' } }}
              />
            )}

            {/* "Now" vertical reference line */}
            {timeRange.now && (
              <VictoryAxis
                dependentAxis
                axisValue={timeRange.now}
                tickFormat={() => ''}
                style={{
                  axis:       { stroke: '#da2a2a', strokeWidth: 1.5, strokeDasharray: '5 4' },
                  grid:       { stroke: 'none' },
                  ticks:      { stroke: 'none', size: 0 },
                  tickLabels: { fill: 'none', fontSize: 0 },
                }}
              />
            )}

            {/* ── Cumulative net effect area (orange) ── */}
            {showCumulativeEffect && (
              <VictoryArea
                data={cumulativeNetData}
                defined={(d: any) => d.y !== null && d.y !== undefined && !isNaN(d.y) && d.y0 !== null && !isNaN(d.y0)}
                interpolation="monotoneX"
                style={{
                  data: {
                    fill: '#FF9800',
                    fillOpacity: 0.4,
                    stroke: '#FF9800',
                    strokeWidth: 1,
                  },
                }}
              />
            )}

            {/* ── Instantaneous net effect area (green) ── */}
            {showNetEffect && (
              <VictoryArea
                data={netEffectData}
                defined={(d: any) => d.y !== null && d.y !== undefined && !isNaN(d.y) && d.y0 !== null && !isNaN(d.y0)}
                interpolation="monotoneX"
                style={{
                  data: {
                    fill: '#4CAF50',
                    fillOpacity: 0.25,
                    stroke: '#4CAF50',
                    strokeWidth: 1.5,
                  },
                }}
              />
            )}

            {/* ── T1D Baseline line (blue dashed step) ── */}
            {showBaseline && (
              <VictoryLine
                data={baselineData}
                interpolation="stepAfter"
                style={{
                  data: {
                    stroke: '#2196F3',
                    strokeWidth: 2,
                    strokeDasharray: '8 4',
                    opacity: 0.8,
                  },
                }}
              />
            )}

            {/* ── Connected readings line ── */}
            {showEstimatedLine && (
              <VictoryLine
                data={connectedReadingsData}
                defined={(d: any) => d.y !== null && d.y !== undefined && !isNaN(d.y)}
                interpolation="monotoneX"
                style={{
                  data: {
                    stroke: '#8031A7',
                    strokeWidth: 2.5,
                  },
                }}
              />
            )}

            {/* ── Actual reading dots (coloured by BG status) ── */}
            {showActualReadings && actualReadingsData.length > 0 && (
              <VictoryScatter
                data={actualReadingsData}
                size={3}
                style={{
                  data: {
                    fill:        ({ datum }: any) => datum.color ?? '#2196F3',
                    stroke:      '#fff',
                    strokeWidth: 1,
                  },
                }}
                events={Platform.OS !== 'web' ? [{
                  target: 'data',
                  eventHandlers: {
                    onPress: () => [{
                      target: 'data',
                      mutation: ({ datum }: any) => {
                        setTooltipData({ point: datum.point });
                        return null;
                      },
                    }],
                  },
                }] : []}
              />
            )}
          </VictoryChart>
        ) : (
          // ── Empty / generating state ──
          <View style={[styles.centered, { height: height * 0.7 }]}>
            {generating ? (
              <>
                <ActivityIndicator size="small" color="#8031A7" />
                <Text style={styles.emptyText}>Calculating…</Text>
              </>
            ) : (
              <>
                <Text style={styles.emptyIcon}>📊</Text>
                <Text style={styles.emptyText}>
                  No blood glucose data in this period.
                </Text>
                <TouchableOpacity style={styles.retryBtn} onPress={refresh}>
                  <Text style={styles.retryText}>Refresh</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}
      </View>

      {/* ── About this Chart (collapsible, default collapsed) ── */}
      <View style={styles.aboutContainer}>
        <TouchableOpacity
          style={styles.aboutHeader}
          onPress={() => setAboutExpanded(prev => !prev)}
          activeOpacity={0.7}
          hitSlop={8}
        >
          <Text style={styles.aboutHeaderText}>About this Chart</Text>
          <Text style={styles.aboutChevron}>{aboutExpanded ? '▲' : '▼'}</Text>
        </TouchableOpacity>

        {aboutExpanded && (
          <View style={styles.aboutBody}>

            {/* Series */}
            <Text style={styles.aboutSectionLabel}>Series</Text>
            {[
              { color: '#8031A7', label: 'BG Readings',      desc: 'Connected actual glucose readings',            line: true,  dashed: false },
              { color: '#2196F3', label: 'T1D Baseline',     desc: baselineMode === 'preset' ? 'Circadian baseline (24h curve)' : 'Stable baseline (from reading)',  line: true,  dashed: true  },
              { color: '#FF9800', label: 'Cumulative Shift ⭐', desc: 'Net meal + insulin "bank balance" from baseline', line: false, dashed: false },
              { color: '#4CAF50', label: 'Net Effect',        desc: 'Instantaneous rate-of-change area',           line: false, dashed: false },
              { color: '#E53935', label: 'Actual Readings',   desc: 'Individual fingerstick / CGM dots',           dot: true },
            ].map(({ color, label, desc, line, dashed, dot }) => (
              <View key={label} style={styles.aboutSeriesRow}>
                {dot  ? <View style={[styles.aboutDot,  { backgroundColor: color }]} /> :
                 line ? <View style={[styles.aboutLine, { backgroundColor: color }, dashed && styles.aboutLineDashed]} /> :
                        <View style={[styles.aboutArea, { backgroundColor: color }]} />}
                <View style={styles.aboutSeriesText}>
                  <Text style={styles.aboutSeriesLabel}>{label}</Text>
                  <Text style={styles.aboutSeriesDesc}>{desc}</Text>
                </View>
              </View>
            ))}

            {/* Reference lines */}
            <Text style={[styles.aboutSectionLabel, { marginTop: 12 }]}>Reference Lines</Text>
            {[
              { color: '#FF8800', desc: 'High threshold  (130% of target)' },
              { color: '#4CAF50', desc: 'Target glucose' },
              { color: '#E53935', desc: 'Low threshold   (70% of target)'  },
              { color: '#da2a2a', desc: 'Current time (Now)'               },
            ].map(({ color, desc }) => (
              <View key={desc} style={styles.aboutRefRow}>
                <Text style={[styles.aboutDash, { color }]}>– –</Text>
                <Text style={styles.aboutRefDesc}>{desc}</Text>
              </View>
            ))}

            {/* Right axis note */}
            <View style={styles.aboutNoteBox}>
              <Text style={styles.aboutNoteText}>
                The right axis shows cumulative BG delta from baseline (±150 mg/dL). Orange ticks align with the Cumulative Shift area.
              </Text>
            </View>
          </View>
        )}
      </View>

      {/* ── Now summary strip ── */}
      {chartData.length > 0 && nowPoint && (
        <View style={styles.nowSummary}>
          <View style={styles.nowSummaryMain}>
            <Text style={styles.nowLabel}>Current BG Estimate</Text>
            <Text style={[
              styles.nowBG,
              currentEstimatedBG > targetHigh ? styles.textHigh :
              currentEstimatedBG < targetLow  ? styles.textLow  :
              styles.textNormal,
            ]}>
              {Math.round(currentEstimatedBG)} mg/dL
            </Text>
            <Text style={styles.nowDetail}>
              Baseline {Math.round(effectiveBaseline)}{' '}
              {nowPoint.cumulativeNetBaseline >= 0 ? '+' : ''}
              {Math.round(nowPoint.cumulativeNetBaseline)} cumulative
            </Text>
          </View>

          <View style={styles.nowSummaryRight}>
            <SummaryPill
              label="Meals"
              value={`+${Math.round(nowPoint.cumulativeMealEffect)}`}
              color="#FF9800"
            />
            <SummaryPill
              label="Insulin"
              value={`${Math.round(nowPoint.cumulativeInsulinEffect)}`}
              color="#9C27B0"
            />
            <SummaryPill
              label="Net"
              value={`${nowPoint.cumulativeNetBaseline >= 0 ? '+' : ''}${Math.round(nowPoint.cumulativeNetBaseline)}`}
              color="#2196F3"
            />
          </View>
        </View>
      )}

      {/* ── Tap-to-inspect tooltip modal ── */}
      {tooltipData !== null && (
        <BGTooltipModal
          data={tooltipData.point}
          stableBaseline={effectiveBaseline}
          targetGlucose={effectiveTarget}
          onClose={() => setTooltipData(null)}
        />
      )}
    </View>
  );
};

// ============================================================
// SUB-COMPONENTS
// ============================================================

// ── ToggleRow ──────────────────────────────────────────────────────────────────

interface ToggleRowProps {
  label:    string;
  color:    string;
  value:    boolean;
  onChange: (v: boolean) => void;
  bold?:    boolean;
}

const ToggleRow: React.FC<ToggleRowProps> = ({ label, color, value, onChange, bold }) => (
  <View style={styles.toggleRow}>
    <View style={[styles.toggleSwatch, { backgroundColor: color }]} />
    <Text style={[styles.toggleLabel, bold && styles.toggleLabelBold]}>{label}</Text>
    <Switch
      value={value}
      onValueChange={onChange}
      trackColor={{ true: color, false: '#ccc' }}
      thumbColor={value ? '#fff' : '#f4f3f4'}
      style={styles.toggleSwitch}
    />
  </View>
);

// ── LegendItem ─────────────────────────────────────────────────────────────────

const LegendItem: React.FC<{ color: string; label: string; dashed: boolean; isCircle?: boolean }> = ({
  color, label, dashed, isCircle
}) => (
  <View style={styles.legendItem}>
    {isCircle ? (
      <View style={[styles.legendDot, { backgroundColor: color }]} />
    ) : (
      <View style={[
        styles.legendLine,
        { backgroundColor: color },
        dashed && styles.legendLineDashed,
      ]} />
    )}
    <Text style={styles.legendLabel}>{label}</Text>
  </View>
);

// ── SummaryPill ────────────────────────────────────────────────────────────────

const SummaryPill: React.FC<{ label: string; value: string; color: string }> = ({
  label, value, color
}) => (
  <View style={[styles.pill, { borderColor: color }]}>
    <Text style={styles.pillLabel}>{label}</Text>
    <Text style={[styles.pillValue, { color }]}>{value}</Text>
  </View>
);

// ── BGTooltipModal ─────────────────────────────────────────────────────────────

interface BGTooltipModalProps {
  data:          BGChartPoint;
  stableBaseline: number;
  targetGlucose:  number;
  onClose:        () => void;
}

const BGTooltipModal: React.FC<BGTooltipModalProps> = ({
  data, stableBaseline, targetGlucose, onClose
}) => {
  const estimatedBG      = data.baseBG + data.cumulativeNetBaseline;
  const hasMeals         = data.mealsAdministered.length > 0;
  const hasInsulin       = data.insulinAdministered.length > 0;
  const bgColor          = getBloodSugarStatusColor(estimatedBG, targetGlucose);

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity
        style={styles.modalOverlay}
        activeOpacity={1}
        onPress={onClose}
      >
        <TouchableOpacity activeOpacity={1} style={styles.modalCard}>

          {/* ── Header ── */}
          <View style={styles.modalHeader}>
            <Text style={styles.modalTime}>
              {data.formattedTime}
              {data.isNow   ? '  🔴 Now'    : ''}
              {data.isFuture ? '  🔮 Future' : ''}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Text style={styles.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView>
            {/* ── Blood Glucose section ── */}
            <View style={styles.modalSection}>
              <Text style={styles.modalSectionTitle}>📊 Blood Glucose</Text>

              {data.actualBG != null && (
                <View style={styles.modalRow}>
                  <Text style={styles.modalLabel}>Actual Reading:</Text>
                  <Text style={[styles.modalValue, { color: bgColor }]}>
                    {Math.round(data.actualBG)} mg/dL
                  </Text>
                </View>
              )}

              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>T1D Baseline:</Text>
                <Text style={[styles.modalValue, { color: '#2196F3' }]}>
                  {Math.round(data.baseBG)} mg/dL
                </Text>
              </View>

              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>Cumulative Effect:</Text>
                <Text style={[
                  styles.modalValue,
                  { color: data.cumulativeNetBaseline >= 0 ? '#FF9800' : '#2196F3' },
                ]}>
                  {data.cumulativeNetBaseline >= 0 ? '+' : ''}
                  {Math.round(data.cumulativeNetBaseline)} mg/dL
                </Text>
              </View>

              <View style={[styles.modalRow, styles.modalRowHighlight]}>
                <Text style={[styles.modalLabel, { fontWeight: '700' }]}>Projected BG:</Text>
                <Text style={[styles.modalValue, { color: bgColor, fontWeight: '700' }]}>
                  {Math.round(estimatedBG)} mg/dL
                </Text>
              </View>

              <Text style={styles.modalFormula}>
                {Math.round(data.baseBG)} + {Math.round(data.cumulativeNetBaseline)} = {Math.round(estimatedBG)}
              </Text>
            </View>

            {/* ── Cumulative Bank Balance ── */}
            <View style={[styles.modalSection, { borderColor: '#FF9800' }]}>
              <Text style={styles.modalSectionTitle}>🏦 Cumulative Bank Balance</Text>
              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>🍽️ Meals (absorbed):</Text>
                <Text style={[styles.modalValue, { color: '#FF9800' }]}>
                  +{Math.round(data.cumulativeMealEffect)} mg/dL
                </Text>
              </View>
              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>💉 Insulin (absorbed):</Text>
                <Text style={[styles.modalValue, { color: '#9C27B0' }]}>
                  {Math.round(data.cumulativeInsulinEffect)} mg/dL
                </Text>
              </View>
              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>Net:</Text>
                <Text style={[
                  styles.modalValue,
                  { color: data.cumulativeNetBaseline >= 0 ? '#FF9800' : '#2196F3' },
                ]}>
                  {data.cumulativeNetBaseline >= 0 ? '+' : ''}
                  {Math.round(data.cumulativeNetBaseline)} mg/dL
                </Text>
              </View>
            </View>

            {/* ── Instantaneous Rate of Change ── */}
            <View style={[styles.modalSection, { borderColor: '#4CAF50' }]}>
              <Text style={styles.modalSectionTitle}>⚡ Instantaneous Rate of Change</Text>
              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>🍽️ Meal Impact:</Text>
                <Text style={[styles.modalValue, { color: '#FF9800' }]}>
                  +{Math.round(data.mealImpact)} mg/dL
                </Text>
              </View>
              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>💉 Insulin Impact:</Text>
                <Text style={[styles.modalValue, { color: '#9C27B0' }]}>
                  {Math.round(data.insulinImpact)} mg/dL
                </Text>
              </View>
              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>Net Effect:</Text>
                <Text style={[
                  styles.modalValue,
                  { color: data.netEffect >= 0 ? '#FF9800' : '#2196F3' },
                ]}>
                  {data.netEffect >= 0 ? '+' : ''}{Math.round(data.netEffect)} mg/dL
                </Text>
              </View>
            </View>

            {/* ── Confidence ── */}
            <View style={styles.modalSection}>
              <View style={styles.modalRow}>
                <Text style={styles.modalLabel}>Confidence:</Text>
                <Text style={[styles.modalValue, { color: data.confidenceColor }]}>
                  {data.confidenceLevel.replace(/_/g, ' ')}
                </Text>
              </View>
            </View>

            {/* ── Meals at this time ── */}
            {hasMeals && (
              <View style={[styles.modalSection, { borderColor: '#FF9800' }]}>
                <Text style={styles.modalSectionTitle}>
                  🍽️ Meals ({data.mealsAdministered.length})
                </Text>
                {data.mealsAdministered.map((meal: any, idx: number) => {
                  const carbs =
                    meal.calculation_summary?.total_carb_equiv ??
                    meal.nutrition?.total_carb_equiv ??
                    meal.nutrition?.totalCarbEquiv ??
                    meal.carbEquiv ?? 0;
                  return (
                    <View key={idx} style={styles.doseItem}>
                      <Text style={styles.doseTime}>
                        {new Date(meal.timestamp).toLocaleTimeString([], {
                          hour: '2-digit', minute: '2-digit'
                        })}
                      </Text>
                      <Text style={styles.doseDetail}>
                        {carbs.toFixed(1)}g carb equiv
                      </Text>
                      {meal.foodItems?.slice(0, 3).map((item: any, i: number) => (
                        <Text key={i} style={styles.foodItem}>
                          • {item.name ?? item.food_name}
                        </Text>
                      ))}
                      {(meal.foodItems?.length ?? 0) > 3 && (
                        <Text style={styles.foodItemMore}>
                          … and {meal.foodItems.length - 3} more
                        </Text>
                      )}
                    </View>
                  );
                })}
              </View>
            )}

            {/* ── Insulin at this time ── */}
            {hasInsulin && (
              <View style={[styles.modalSection, { borderColor: '#9C27B0' }]}>
                <Text style={styles.modalSectionTitle}>
                  💉 Insulin ({data.insulinAdministered.length})
                </Text>
                {data.insulinAdministered.map((dose: any, idx: number) => (
                  <View key={idx} style={styles.doseItem}>
                    <Text style={styles.doseTime}>
                      {new Date(dose.administrationTime ?? dose.taken_at).toLocaleTimeString([], {
                        hour: '2-digit', minute: '2-digit'
                      })}
                    </Text>
                    <Text style={styles.doseDetail}>
                      {(dose.dose ?? dose.units ?? 0).toFixed(1)} U{' '}
                      {dose.medication ?? dose.insulinType ?? ''}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            <Text style={styles.modalFooter}>Tap outside to close</Text>
          </ScrollView>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
};

// ============================================================
// STYLESHEET
// ============================================================

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  embedded: {
    borderRadius: 0,
    shadowOpacity: 0,
    elevation: 0,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#666',
  },
  errorText: {
    fontSize: 14,
    color: '#E53935',
    textAlign: 'center',
    marginBottom: 12,
  },
  retryBtn: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: '#8031A7',
    borderRadius: 8,
  },
  retryText: {
    color: '#fff',
    fontWeight: '600',
  },
  emptyIcon: {
    fontSize: 36,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 13,
    color: '#999',
    textAlign: 'center',
  },

  // ── Header ──
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  headerText:     { flex: 1 },
  headerTitle:    { fontSize: 16, fontWeight: '700', color: '#1a1a1a' },
  headerSubtitle: { fontSize: 11, color: '#888', marginTop: 2 },
  refreshBtn:     { padding: 4, marginLeft: 8 },
  refreshIcon:    { fontSize: 20 },

  // ── View mode ──
  viewModeScroll: {
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  viewModeRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  viewModeBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#f5f5f5',
  },
  viewModeBtnActive: {
    backgroundColor: '#8031A7',
  },
  viewModeBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#555',
  },
  viewModeBtnTextActive: {
    color: '#fff',
  },

  // ── Custom date-range panel ──
  viewModeBtnCustom:      { borderWidth: 1.5, borderColor: '#8031A7', backgroundColor: 'transparent' },
  customRangePanel:       { paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0', backgroundColor: '#fdf8ff' },
  customRangeRow:         { flexDirection: 'row', gap: 8, marginBottom: 4 },
  customRangePicker:      { flex: 1 },
  customRangeApplyBtn:    { backgroundColor: '#8031A7', borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  customRangeAppliedBtn:  { backgroundColor: '#6a1b9a' },
  customRangeApplyText:   { color: '#fff', fontWeight: '700', fontSize: 14 },

  // ── Toggles ──
  toggleGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '48%',
    marginBottom: 4,
  },
  toggleSwatch: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 6,
  },
  toggleLabel: {
    flex: 1,
    fontSize: 11,
    color: '#444',
  },
  toggleLabelBold: {
    fontWeight: '700',
    color: '#E65100',
  },
  toggleSwitch: {
    transform: [{ scaleX: 0.75 }, { scaleY: 0.75 }],
  },

  // ── Chart ──
  chartWrapper: {
    paddingHorizontal: 0,
  },

  // ── About this Chart (collapsible) ──
  aboutContainer: {
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    marginTop: 4,
  },
  aboutHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  aboutHeaderText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
  },
  aboutChevron: { fontSize: 11, color: '#9ca3af' },
  aboutBody: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  aboutSectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  aboutSeriesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 10,
  },
  aboutDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: '#fff',
    flexShrink: 0,
  },
  aboutLine: {
    width: 20,
    height: 3,
    borderRadius: 1.5,
    flexShrink: 0,
  },
  aboutLineDashed: {
    opacity: 0.55,
  },
  aboutArea: {
    width: 20,
    height: 10,
    borderRadius: 3,
    opacity: 0.45,
    flexShrink: 0,
  },
  aboutSeriesText: { flex: 1 },
  aboutSeriesLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
  },
  aboutSeriesDesc: {
    fontSize: 11,
    color: '#6b7280',
    marginTop: 1,
  },
  aboutRefRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 5,
  },
  aboutDash: {
    fontSize: 13,
    fontWeight: '700',
    width: 28,
    letterSpacing: 1,
  },
  aboutRefDesc: {
    fontSize: 12,
    color: '#374151',
  },
  aboutNoteBox: {
    marginTop: 12,
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    padding: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#d1d5db',
  },
  aboutNoteText: {
    fontSize: 11,
    color: '#6b7280',
    lineHeight: 16,
  },

  // ── Now summary ──
  nowSummary: {
    flexDirection: 'row',
    padding: 12,
    margin: 12,
    backgroundColor: '#f8f4ff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e0d4f0',
  },
  nowSummaryMain:  { flex: 1 },
  nowLabel:        { fontSize: 11, color: '#666', marginBottom: 2 },
  nowBG:           { fontSize: 28, fontWeight: '700' },
  textHigh:        { color: '#FF6B00' },
  textLow:         { color: '#E53935' },
  textNormal:      { color: '#8031A7' },
  nowDetail:       { fontSize: 11, color: '#888', marginTop: 2 },
  nowSummaryRight: { alignItems: 'flex-end', gap: 4 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: '#fff',
  },
  pillLabel: { fontSize: 10, color: '#888' },
  pillValue: { fontSize: 12, fontWeight: '700' },

  // ── Modal ──
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    maxHeight: '85%',
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  modalTime:  { fontSize: 15, fontWeight: '700', color: '#1a1a1a' },
  modalClose: { fontSize: 18, color: '#888', padding: 4 },
  modalSection: {
    marginHorizontal: 16,
    marginTop: 12,
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#f9fafb',
    borderWidth: 1.5,
    borderColor: '#e0e0e0',
  },
  modalSectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#333',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  modalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  modalRowHighlight: {
    backgroundColor: '#f0ebff',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginTop: 4,
  },
  modalLabel: {
    fontSize: 13,
    color: '#555',
  },
  modalValue: {
    fontSize: 13,
    fontWeight: '600',
  },
  modalFormula: {
    fontSize: 11,
    color: '#888',
    textAlign: 'center',
    marginTop: 4,
    fontStyle: 'italic',
  },
  doseItem: {
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
    marginBottom: 4,
  },
  doseTime:     { fontSize: 12, fontWeight: '600', color: '#333' },
  doseDetail:   { fontSize: 12, color: '#555' },
  foodItem:     { fontSize: 11, color: '#777', paddingLeft: 8, marginTop: 2 },
  foodItemMore: { fontSize: 11, color: '#999', fontStyle: 'italic', paddingLeft: 8 },
  modalFooter:  {
    textAlign: 'center',
    fontSize: 11,
    color: '#999',
    marginVertical: 12,
  },
});

export default React.memo(BloodGlucoseVisualization);