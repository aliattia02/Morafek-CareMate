/**
 * ============================================================================
 * EFFECTS VISUALIZATION CHART — Mobile Port (React Native)
 * ============================================================================
 *
 * Ported from: frontend/src/components/EffectsVisualization.js (v5.0)
 * Location:    mobile/components/charts/EffectsVisualizationChart.tsx
 *
 * CHART LIBRARY: victory-native
 *   Install: npx expo install victory-native react-native-svg
 *   Docs:    https://formidable.com/open-source/victory/docs/native
 *
 * KEY DIFFERENCES FROM WEB VERSION:
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. DATA SOURCE
 *    Web:    useBloodSugarData() context → recentMealsData / recentInsulinData
 *    Mobile: useActiveEffects() hook → meals / insulinDoses (already fetched)
 *            No second API call needed; hook exposes raw arrays directly.
 *
 * 2. PER-POINT CALCULATION
 *    Web:    calculateNetEffectAtTime() (single all-in-one function)
 *    Mobile: calculateStackedMealEffect() + calculateStackedInsulinEffect()
 *            + calculateTotalCumulativeEffects() (three separate calls per point)
 *            Uses the v4.4 persist-at-100% fix from @/utils/calculations.
 *
 * 3. CUMULATIVE BASELINE CORRECTNESS (from ActiveEffectsDisplay_comparison.tsx)
 *    - allMealsInWindow (not just activeMeals) fed to calculateTotalCumulativeEffects
 *    - Only meals/doses after the daily reset are counted
 *    - Doses normalised to InsulinDose shape before passing to PK functions
 *    - Readings filtered to current daily period only
 *
 * 4. RENDERING
 *    Web:    Recharts ComposedChart (SVG, web)
 *    Mobile: victory-native VictoryChart (SVG via react-native-svg)
 *
 * 5. NO FULLSCREEN API
 *    document.requestFullscreen() removed; replaced with RN Modal pattern (TODO).
 *
 * SERIES RENDERED:
 *   🍽️ Meal Effect       (orange area)    — showMealEffect toggle
 *   💉 Insulin Effect    (purple area)    — showInsulinEffect toggle
 *   📊 Net Effect        (blue dashed)    — showNetEffect toggle
 *   📈 Cumulative Shift  (green solid ⭐) — showCumulativeBaseline toggle
 *   🔶 Meal Dose Bars    (orange bar)     — showDoseMarkers toggle
 *   🔷 Insulin Dose Bars (purple bar)     — showDoseMarkers toggle
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
} from 'react-native';

// ── Chart library ──────────────────────────────────────────────────────────────
// Install: npx expo install victory-native react-native-svg
import {
  VictoryChart,
  VictoryArea,
  VictoryLine,
  VictoryBar,
  VictoryAxis,
  VictoryTheme,
  VictoryScatter,
  VictoryTooltip,
  VictoryVoronoiContainer,
} from 'victory-native';

// ── Mobile calculation stack ───────────────────────────────────────────────────
import { calculateStackedMealEffect } from '@/utils/glucose/meal-pharmacodynamics';
import {
  calculateStackedInsulinEffect,
  calculateStackedInsulinChartEffect,
} from '@/utils/insulin/pharmacodynamics';
import { calculateTotalCumulativeEffects } from '@/utils/calculations';
import { MEAL_ABSORPTION_PROFILES } from '@/constants/shared-constants';

// ── Hooks ──────────────────────────────────────────────────────────────────────
import { useActiveEffects } from '@/hooks/useActiveEffects';
import { usePatientConstants } from '@/hooks/usePatientConstants';
import UnifiedTimePicker from '@/components/forms/UnifiedTimePicker';

// ── Chart utilities (from ChartUtils.tsx) ─────────────────────────────────────
import {
  useCurrentMinute,
  useChartTimeRange,
  processContextMealsForChart,
  processContextInsulinForChart,
  generateXAxisTicks,
  generateSymmetricTicks,
  calculateEffectsAxisDomain,
  calculateDoseAxisDomain,
  formatXAxis,
  findMealsAtTime,
  findInsulinAtTime,
  parseUTCMs,
  VIEW_CONFIGS,
  getLastResetTimeMs,
  getMealDurationHours,
  normaliseDose,
  doseToStacking,
  type TimeRange,
} from '@/utils/ChartUtils';

// ── Types ──────────────────────────────────────────────────────────────────────
import type { Meal } from '@/types/meal.types';
import type { InsulinDose } from '@/types/insulin.types';

// ============================================================
// CONSTANTS
// ============================================================

// VIEW_CONFIGS is imported from ChartUtils (merges shared-constants with safe defaults)

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CHART_HEIGHT = 280;
const CHART_WIDTH  = SCREEN_WIDTH - 32; // 16px padding each side

// ============================================================
// INTERNAL TYPES
// ============================================================

interface EffectsChartPoint {
  timestamp: number;
  formattedTime: string;

  // Rate-of-change series
  mealImpact: number;
  insulinImpact: number;   // always <= 0
  netEffect: number;

  // Cumulative "bank balance"
  cumulativeMealEffect: number;
  cumulativeInsulinEffect: number;
  cumulativeNetBaseline: number;

  // Dose markers (null = no dose at this point)
  mealDoseMarker: number | null;
  insulinDoseMarker: number | null;

  // Tooltip extras
  mealsAdministered: any[];
  insulinAdministered: any[];

  isHistorical: boolean;
  isFuture: boolean;
  isNow: boolean;
}

interface TooltipData {
  point: EffectsChartPoint;
  x: number;
  y: number;
}

export interface EffectsVisualizationChartProps {
  height?: number;
  showControls?: boolean;
  embedded?: boolean;
  defaultView?: string;
  onDataUpdate?: (data: EffectsChartPoint[]) => void;
}

// ============================================================
// HELPER UTILITIES
// (Ported from ActiveEffectsDisplay_comparison.tsx)
// ============================================================

// parseUTCMs, getLastResetTimeMs, getMealDurationHours, normaliseDose, and
// doseToStacking are imported from ChartUtils.

/** Normalise raw API meal → guaranteed id + calculation_summary fields. */
function normaliseMeal(raw: any): any {
  return {
    ...raw,
    id: raw.id ?? String(raw._id ?? ''),
    calculation_summary: raw.calculation_summary ?? {},
    nutrition: raw.nutrition ?? {},
  };
}

/** Get PK duration for a dose (hours). */
function getDoseDurationHours(dose: any, constants: any): number {
  return constants?.medication_factors?.[dose?.insulinType ?? dose?.medication]?.duration_hours ?? 4.0;
}

// ============================================================
// PER-POINT CALCULATION
// ============================================================

/**
 * Calculate all chart series values at a single time point.
 *
 * Mirrors what calculateNetEffectAtTime() does on the web, but using
 * the mobile calculation stack with the v4.4 persist-at-100% fix.
 */
function buildChartPoint(
  targetTimestamp: number,
  processedMeals: any[],
  processedInsulin: any[],
  allMealsInWindow: any[],
  allDosesInWindow: any[],
  patientConstants: any,
  now: number,
  halfIntervalMs: number,
  viewConfig: any,
): EffectsChartPoint {
  const targetTime = new Date(targetTimestamp);
  const isHistorical = targetTimestamp <= now;
  const isFuture     = targetTimestamp > now;
  const isNow        = Math.abs(targetTimestamp - now) < halfIntervalMs;

  const resetHour: number = patientConstants?.daily_reset_hour ?? 7;
  const tzOffset:  number = patientConstants?.timezone_offset_minutes ?? 0;

  // ── Meal effect at this time ───────────────────────────────────────────────
  // calculateStackedMealEffect takes (meals, currentTime, constants)
  // Filter to meals that are active at targetTime (not future meals)
  const activeMealsAtTime = processedMeals.filter((meal: any) => {
    const mealMs = typeof meal.timestamp === 'number'
      ? meal.timestamp
      : parseUTCMs(meal.timestamp);
    if (isNaN(mealMs) || mealMs > targetTimestamp) return false;
    const hoursSince = (targetTimestamp - mealMs) / (1000 * 60 * 60);
    return hoursSince < getMealDurationHours(meal);
  });

  const mealResult = activeMealsAtTime.length > 0
    ? calculateStackedMealEffect(activeMealsAtTime, targetTime, patientConstants)
    : { totalBGElevation: 0, totalMOB: 0, totalPendingRise: 0 };

  const mealImpact = (mealResult as any)?.totalBGElevation ?? 0;

  // ── Insulin effect at this time ────────────────────────────────────────────
  const correctionFactor: number = patientConstants?.correction_factor ?? 40;

  const dosesForStackingAtTime: InsulinDoseForStacking[] = processedInsulin
    .map((dose: any) => doseToStacking(dose, targetTime))
    .filter((d): d is InsulinDoseForStacking => d !== null);

  // ── S-CURVE FIX ────────────────────────────────────────────────────────────
  // calculateStackedInsulinChartEffect uses (dose − IOB) × ISF per dose,
  // producing a monotonically-growing S-curve that matches the web version's
  // purple area.  calculateStackedInsulinEffect (activity-rate bell curve)
  // is kept below for IOB / stacking-risk tooltip display only.
  // See pharmacodynamics.ts "S-CURVE CHART API" section for full rationale.
  const chartInsulinResult = dosesForStackingAtTime.length > 0
    ? calculateStackedInsulinChartEffect(dosesForStackingAtTime, correctionFactor)
    : { totalBGImpact: 0, totalIOB: 0 };

  // Always <= 0  (cumulative BG reduction already delivered by absorbed insulin)
  const insulinImpact = chartInsulinResult.totalBGImpact;

  // Keep stacking result available for IOB display / tooltip (not used for chart area)
  const insulinResult = dosesForStackingAtTime.length > 0
    ? calculateStackedInsulinEffect(dosesForStackingAtTime, correctionFactor)
    : { totalIOB: 0, totalBGImpact: 0 };

  const netEffect = mealImpact + insulinImpact;

  // ── Cumulative baseline at this time (the "bank balance") ─────────────────
  // Use allMealsInWindow + allDosesInWindow so fully-absorbed events persist.
  // This is the v4.4 fix from cumulative-effects.ts.
  const allMealsUpToNow = allMealsInWindow.filter((meal: any) => {
    const mealMs = parseUTCMs(meal?.timestamp);
    return !isNaN(mealMs) && mealMs <= targetTimestamp;
  });
  const allDosesUpToNow = allDosesInWindow.filter((dose: any) => {
    const doseMs = parseUTCMs(dose?.administrationTime);
    return !isNaN(doseMs) && doseMs <= targetTimestamp;
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

  // ── Dose markers ───────────────────────────────────────────────────────────
  const mealsAtTime   = findMealsAtTime(processedMeals, targetTimestamp, halfIntervalMs);
  const insulinAtTime = findInsulinAtTime(processedInsulin, targetTimestamp, halfIntervalMs);

  // carbEquiv is NOT set by processContextMealsForChart — it just spreads the
  // raw API meal object. Read total_carb_equiv from calculation_summary (backend
  // field), then fall back through the nutrition object variants, then raw carbs.
  const totalCarbsAtTime = mealsAtTime.reduce((s: number, m: any) => {
    const carbEquiv =
      m.calculation_summary?.total_carb_equiv ??
      m.nutrition?.total_carb_equiv           ??
      m.nutrition?.totalCarbEquiv             ??
      m.nutrition?.totalCarbs                 ??
      m.nutrition?.carbs                      ??
      0;
    return s + carbEquiv;
  }, 0);
  const totalInsulinAtTime = insulinAtTime.reduce((s: number, d: any) => s + (d.dose ?? d.units ?? 0), 0);

  return {
    timestamp: targetTimestamp,
    formattedTime: formatXAxis(
      targetTimestamp,
      viewConfig?.tickFormat === 'HH:mm' ? 'HH:mm' : 'MM/DD HH:mm'
    ),

    mealImpact,
    insulinImpact,
    netEffect,

    cumulativeMealEffect:    (cumulative as any).cumulativeMealEffect    ?? 0,
    cumulativeInsulinEffect: (cumulative as any).cumulativeInsulinEffect ?? 0,
    cumulativeNetBaseline:   (cumulative as any).cumulativeNetBaseline   ?? 0,

    mealDoseMarker:    totalCarbsAtTime > 0   ? totalCarbsAtTime             : null,
    insulinDoseMarker: totalInsulinAtTime > 0 ? -(totalInsulinAtTime * 5)   : null,

    mealsAdministered:   mealsAtTime,
    insulinAdministered: insulinAtTime,

    isHistorical,
    isFuture,
    isNow,
  };
}

// ACTIVE_EFFECTS_OPTIONS is now built inside the component via useMemo
// (keyed on pastHours) so the fetch window automatically matches the
// selected view. It is NOT a static constant any more — see the useMemo
// below.  A useMemo dep-keyed object is NOT recreated every render; it
// is stable for as long as viewConfig.pastHours stays the same, so the
// infinite-loop risk of an inline object literal is avoided.


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
  return { label: 'Custom', pastHours, futureHours, tickInterval, tickFormat, interpolationInterval };
}

// ============================================================
// MAIN COMPONENT
// ============================================================

const EffectsVisualizationChart: React.FC<EffectsVisualizationChartProps> = ({
  height        = CHART_HEIGHT,
  showControls  = true,
  embedded      = false,
  defaultView   = '12h',
  onDataUpdate,
}) => {
  // ── Patient constants ────────────────────────────────────────────────────────
  const { constants: patientConstants } = usePatientConstants();

  // ── View state ───────────────────────────────────────────────────────────────
  // Declared FIRST so it is available to the activeEffectsOptions useMemo below.
  // (Previously declared after that memo, causing a TDZ "Cannot access 'viewMode'
  // before initialization" crash.)
  const [viewMode, setViewMode]                       = useState(defaultView);

  // ── Custom date-range filter ──────────────────────────────────────────────
  const [customRangeStart, setCustomRangeStart] = useState<Date>(() => new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000));
  const [customRangeEnd,   setCustomRangeEnd]   = useState<Date>(() => new Date());
  const [customApplied,    setCustomApplied]    = useState(true);


  // ── Active effects hook (single source for meals + doses) ────────────────────
  // windowHours is derived from the current view mode so the API fetch window
  // always covers the full chart range. useMemo ensures the options object is
  // only recreated when pastHours changes (i.e. the user switches view modes),
  // not on every render — preventing the useActiveEffects infinite-loop issue.
  //
  // BUG FIX: the previous ACTIVE_EFFECTS_OPTIONS static constant had no
  // windowHours, so useActiveEffects always fetched only 24h (32h with buffer).
  // For week/month views this meant rawMeals contained no historical meals,
  // allMealsUpToNow was always empty for historical chart points, and
  // cumulativeNetBaseline was 0 across the entire old portion of the chart.
  const activeEffectsOptions = useMemo(() => {
    // For custom mode derive pastHours from the selected start date; otherwise
    // use the VIEW_CONFIGS entry as before.
    const pastHours = viewMode === 'custom'
      ? Math.max(1, (Date.now() - customRangeStart.getTime()) / 3_600_000)
      : ((VIEW_CONFIGS[viewMode] ?? VIEW_CONFIGS['12h']).pastHours ?? 24);
    return { autoRefresh: true, refreshInterval: 60_000, debug: false, windowHours: pastHours, skipIobCutoff: true };
  }, [viewMode, customRangeStart]);   // customRangeStart only matters when viewMode === 'custom'

  const {
    meals: rawMeals,
    insulinDoses: rawDoses,
    stableBaseline,
    baselineMode,
    isLoading: effectsLoading,
    refresh,
  } = useActiveEffects(activeEffectsOptions);

  // ── Stable callback ref for onDataUpdate ─────────────────────────────────────
  // Storing the prop in a ref means generateChartData doesn't need it in its
  // dependency array, preventing a new callback reference on every render.
  const onDataUpdateRef = useRef(onDataUpdate);
  useEffect(() => { onDataUpdateRef.current = onDataUpdate; }, [onDataUpdate]);
  const [chartData, setChartData]                     = useState<EffectsChartPoint[]>([]);
  const [generating, setGenerating]                   = useState(false);
  const [error, setError]                             = useState<string | null>(null);

  // ── Series toggles ───────────────────────────────────────────────────────────
  const [showMealEffect,        setShowMealEffect]        = useState(true);
  const [showInsulinEffect,     setShowInsulinEffect]      = useState(true);
  const [showNetEffect,         setShowNetEffect]          = useState(false);
  const [showCumulativeBaseline, setShowCumulativeBaseline] = useState(true);
  const [showDoseMarkers,       setShowDoseMarkers]        = useState(true);

  // ── Tooltip state ────────────────────────────────────────────────────────────
  const [tooltipData, setTooltipData] = useState<TooltipData | null>(null);

  // ── About this Chart accordion ───────────────────────────────────────────────
  const [aboutExpanded, setAboutExpanded] = useState(false);

  // ── Shared time hooks (from ChartUtils) ──────────────────────────────────────
  const currentMinute  = useCurrentMinute();
  // Always call hook unconditionally; override result when custom mode is active.
  const _hookTimeRange = useChartTimeRange(viewMode === 'custom' ? '24h' : viewMode, currentMinute);

  const timeRange: TimeRange = useMemo(() => {
    if (viewMode === 'custom' && customApplied) {
      return { start: customRangeStart.getTime(), end: customRangeEnd.getTime(), now: Date.now() };
    }
    // Extend the default future window for the 12h view from 2 h → 6 h so the
    // user can see the full projected effect curve for the next 6 hours.
    if (viewMode === '12h') {
      const nowMs = Date.now();
      return { ..._hookTimeRange, end: nowMs + 6 * 60 * 60 * 1_000 };
    }
    return _hookTimeRange;
  }, [viewMode, customApplied, customRangeStart, customRangeEnd, _hookTimeRange]);

  const viewConfig = useMemo(() => {
    if (viewMode === 'custom') return getCustomViewConfig(customRangeStart, customRangeEnd);
    const cfg = VIEW_CONFIGS[viewMode] ?? VIEW_CONFIGS['12h'];
    // Keep futureHours in sync with the extended 6h future window above so that
    // generateXAxisTicks produces ticks across the full future range.
    if (viewMode === '12h') return { ...cfg, futureHours: 6 };
    return cfg;
  }, [viewMode, customRangeStart, customRangeEnd]);

  // ── Timeout escape hatch ─────────────────────────────────────────────────────
  // useActiveEffects.isLoading can stay true indefinitely if the API returns
  // empty data and calculateEffects() never fires (it is gated on data presence).
  // After LOAD_TIMEOUT_MS we force-clear our spinner regardless, showing the
  // empty-state UI so the screen is never stuck on a loader forever.
  const LOAD_TIMEOUT_MS = 8_000;
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!effectsLoading) return; // already resolved — no timer needed
    const id = setTimeout(() => setTimedOut(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [effectsLoading]);

  // ── Processed meals / insulin (time-range filtered) ──────────────────────────
  // Use primitive start/end as deps (not the timeRange object) to avoid
  // triggering new memos when the hook returns a structurally-identical object.
  const { start: rangeStart, end: rangeEnd } = timeRange;

  const processedMeals = useMemo(
    () => processContextMealsForChart(
      rawMeals.map(normaliseMeal), // ✅ FIX: resolve timestamp aliases + calculation_summary
      timeRange,
      patientConstants ?? undefined, // ✅ FIX: pass constants so protein/fat factors are patient-specific
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawMeals, rangeStart, rangeEnd, patientConstants]
  );

  // ✅ FIX (insulin dose markers): Pre-normalise raw API doses before passing to
  // processContextInsulinForChart. Raw doses from useActiveEffects have their
  // timestamp in 'taken_at' (not 'administrationTime'), so the mobile ChartUtils
  // filter was discarding every dose as "outside time range" → insulinDoseData
  // was always empty → no purple bars rendered.
  //
  // normaliseDose() maps taken_at → administrationTime (string/number), which is
  // the field processContextInsulinForChart and findInsulinAtTime both expect.
  const processedInsulin = useMemo(
    () => processContextInsulinForChart(rawDoses.map(normaliseDose), timeRange),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawDoses, rangeStart, rangeEnd]
  );

  // ── All-window arrays for correct cumulative baseline ────────────────────────
  // We need these separately: allMealsInWindow keeps fully-absorbed meals so the
  // persist-at-100% fix in calculateTotalCumulativeEffects is applied correctly.
  //
  // ── BUG FIX: filter by rangeStart (chart window) NOT today's lastReset ──────
  //
  // PREVIOUS BUG: filtered by lastReset = getLastResetTimeMs(new Date(), ...)
  // which is TODAY's reset boundary.  For any multi-day view, historical chart
  // points (e.g. 18/02 when today is 22/02) need meals from THEIR OWN day, not
  // just from today's window.  Filtering by today's lastReset excluded all
  // historical meals, so allMealsUpToNow was always empty for historical points
  // → cumulativeNetBaseline = 0 for every point except the current reset period,
  // producing the flat green line visible in the chart screenshot.
  //
  // FIX: filter by rangeStart so every meal/dose in the visible chart window is
  // included.  The per-point daily-reset boundary is enforced correctly INSIDE
  // calculateTotalCumulativeEffects → calculateMealCumulativeEffect, which calls
  // _getLastResetTime(targetTime, ...) using each chart point's own timestamp.
  // Each historical point therefore only counts meals/doses from its own daily
  // window, and the cumulative correctly resets to 0 at each day's reset hour.
  const { allMealsInWindow, allDosesInWindow } = useMemo(() => {
    if (!patientConstants) return { allMealsInWindow: [], allDosesInWindow: [] };

    const now = Date.now();
    const resetHour: number = patientConstants?.daily_reset_hour ?? 7;
    const tzOffset:  number = (patientConstants as any)?.timezone_offset_minutes ?? 0;

    // ── KEY FIX: always reach back to the daily reset ──────────────────────
    //
    // ROOT CAUSE of the shape-change bug:
    //   allMealsInWindow was filtered by rangeStart (the chart's visible left
    //   edge). When the user switched to a short view (3H / 6H / 12H),
    //   rangeStart moved forward — excluding meals that were eaten earlier in
    //   the day but AFTER the daily reset. Those meals were therefore missing
    //   from allMealsUpToNow inside buildChartPoint, so
    //   calculateTotalCumulativeEffects returned 0 for all historical points
    //   visible in the short window, and the green cumulative line was flat.
    //
    // FIX: compute lastResetMs for the current wall-clock time and use
    //   Math.min(rangeStart, lastResetMs) as the lower bound.
    //
    //   • Short views (3H/6H/12H): lastResetMs is earlier than rangeStart
    //     → cumulativeWindowStart = lastResetMs
    //     → all meals/doses since this morning's reset are included, so the
    //       cumulative line correctly carries in pre-window effects.
    //
    //   • Multi-day views (3D/Week): rangeStart is earlier than lastResetMs
    //     → cumulativeWindowStart = rangeStart (unchanged behaviour)
    //     → per-point daily-reset logic inside calculateMealCumulativeEffect
    //       still handles day boundaries correctly for each chart point.
    const lastResetMs = getLastResetTimeMs(new Date(now), resetHour, tzOffset);
    const cumulativeWindowStart = Math.min(rangeStart, lastResetMs);

    const mealsInWindow = rawMeals
      .map(normaliseMeal)
      .filter((meal: any) => {
        const mealMs = parseUTCMs(meal?.timestamp);
        // ✅ FIX: use rangeEnd (not `now`) as the upper bound so that
        // future-snapped meals (timestamp = insulinTime + offset) are included.
        // Without this, a pre-meal snap produces a future timestamp that is
        // silently dropped here → calculateTotalCumulativeEffects never sees it
        // → cumulativeNetBaseline stays flat (green line shows no meal effect)
        // even though the orange meal-area renders correctly via processedMeals.
        //
        // calculateAbsorbedFraction(hoursSince <= 0) = 0, so future meals
        // contribute nothing to points before their own timestamp, and the
        // correct cumulative value for points at or after their timestamp.
        return !isNaN(mealMs) && mealMs >= cumulativeWindowStart && mealMs <= rangeEnd;
      });

    const dosesInWindow = rawDoses
      .map(normaliseDose)
      .filter((dose: any) => {
        const doseMs = parseUTCMs(dose?.administrationTime);
        return !isNaN(doseMs) && doseMs >= cumulativeWindowStart && doseMs <= now;
      });

    return { allMealsInWindow: mealsInWindow, allDosesInWindow: dosesInWindow };
  // rangeStart and rangeEnd are primitives from timeRange — safe as deps.
  }, [rawMeals, rawDoses, patientConstants, rangeStart, rangeEnd]);

  // ── Chart generation ──────────────────────────────────────────────────────────
  const generateChartData = useCallback(() => {
    if (!patientConstants) return;

    // ── STABLE EARLY-EXIT: Don't loop on empty data ──────────────────────────
    // If there are no meals or insulin at all, show empty state immediately
    // rather than spinning.  This is the primary guard against the render loop
    // when the API returns empty arrays.
    if (processedMeals.length === 0 && processedInsulin.length === 0) {
      setChartData([]);
      setGenerating(false);
      return;
    }

    setGenerating(true);
    setError(null);

    try {
      const { start, end, now } = timeRange;
      const intervalMs = (viewConfig.interpolationInterval ?? 10) * 60 * 1_000;
      const halfInterval = intervalMs / 2;

      // Build time-point array
      const timePoints: number[] = [];
      for (let t = start; t <= end; t += intervalMs) {
        // Round to minute boundary
        const normalised = Math.round(t / 60_000) * 60_000;
        if (timePoints.length === 0 || timePoints[timePoints.length - 1] !== normalised) {
          timePoints.push(normalised);
        }
      }

      const points: EffectsChartPoint[] = timePoints.map((ts) =>
        buildChartPoint(
          ts,
          processedMeals,
          processedInsulin,
          allMealsInWindow,
          allDosesInWindow,
          patientConstants,
          now ?? Date.now(),
          halfInterval,
          viewConfig,
        )
      );

      setChartData(points);
      // Use the ref so onDataUpdate is NOT in the dependency array.
      // Adding it as a dep would cause a new callback on every render if
      // the parent passes an inline function, restarting the loop.
      onDataUpdateRef.current?.(points);
    } catch (err) {
      console.error('[EffectsVisualizationChart] generateChartData error:', err);
      setError('Failed to generate chart data');
    } finally {
      setGenerating(false);
    }
  }, [
    patientConstants,
    processedMeals,
    processedInsulin,
    allMealsInWindow,
    allDosesInWindow,
    timeRange,
    viewConfig,
    // onDataUpdate intentionally omitted — accessed via onDataUpdateRef
  ]);

  // Regenerate when inputs change (debounced by 200ms to batch rapid updates)
  useEffect(() => {
    const id = setTimeout(generateChartData, 200);
    return () => clearTimeout(id);
  }, [generateChartData]);

  // ── Derived chart config ──────────────────────────────────────────────────────
  const effectsDomain = useMemo(
    () => calculateEffectsAxisDomain(chartData, { includeCumulative: true }),
    [chartData]
  );

  const doseDomain = useMemo(
    () => calculateDoseAxisDomain(chartData),
    [chartData]
  );

  const xTicks = useMemo(
    () => generateXAxisTicks(timeRange, viewConfig),
    [timeRange, viewConfig]
  );

  // ── Victory data formatters ───────────────────────────────────────────────────
  // Victory requires data as { x, y } arrays
  const toXY = (key: keyof EffectsChartPoint) =>
    chartData.map((p) => ({
      x: p.timestamp,
      y: (p[key] as number) ?? 0,
    }));

  const mealEffectData       = useMemo(() => toXY('mealImpact'),            [chartData]);
  const insulinEffectData    = useMemo(() => toXY('insulinImpact'),         [chartData]);
  const netEffectData        = useMemo(() => toXY('netEffect'),             [chartData]);
  const cumulativeData       = useMemo(() => toXY('cumulativeNetBaseline'), [chartData]);
  const mealDoseData         = useMemo(
    () => chartData.filter(p => p.mealDoseMarker !== null).map(p => ({ x: p.timestamp, y: p.mealDoseMarker! })),
    [chartData]
  );
  const insulinDoseData      = useMemo(
    () => chartData.filter(p => p.insulinDoseMarker !== null).map(p => ({ x: p.timestamp, y: p.insulinDoseMarker! })),
    [chartData]
  );

  // ── Combined Y domain — shared between VictoryChart domain prop and X-axis pin ──
  // Must come AFTER insulinDoseData (which it depends on). Extracted so that
  // yDomain[0] can be passed as axisValue to the X-axis, pinning its ticks to the
  // chart bottom rather than floating at y=0 mid-chart when insulin effects push
  // the domain below zero — matching the web Recharts XAxis bottom behaviour.
  const yDomain = useMemo<[number, number]>(() => {
    const insulinMin = insulinDoseData.length > 0
      ? Math.min(...insulinDoseData.map(d => d.y))
      : 0;
    return [
      Math.min(effectsDomain[0], doseDomain[0], insulinMin, -10),
      Math.max(effectsDomain[1], doseDomain[1]),
    ];
  }, [effectsDomain, doseDomain, insulinDoseData]);

  // ── Dual-axis scaling ────────────────────────────────────────────────────────
  // Victory Native has a single shared y-domain per chart.  To show an
  // independent right axis (0–60 dose scale) alongside the left effects axis
  // (e.g. -260 to +200), we:
  //   1. Map bar data from dose-space [-60,60] → main yDomain via scaleToMain().
  //   2. Position right-axis ticks at those same scaled coordinates.
  //   3. Label each tick with its original dose value (absolute, so both sides
  //      read 0→60 upward from zero).
  // This is the standard Victory dual-axis pattern.
  const DOSE_SCALE: [number, number] = [-60, 60];
  const DOSE_RAW_TICKS = [-60, -40, -20, 0, 20, 40, 60];

  // Map a value from dose-space to main y-space
  const scaleToMain = useCallback(
    (doseValue: number): number => {
      const [dMin, dMax] = DOSE_SCALE;
      const [yMin, yMax] = yDomain;
      return yMin + ((doseValue - dMin) / (dMax - dMin)) * (yMax - yMin);
    },
    [yDomain]
  );

  // Scaled bar data — bars now live in main y-space but represent dose amounts
  const scaledMealDoseData = useMemo(
    () => mealDoseData.map(p => ({ x: p.x, y: scaleToMain(Math.min(p.y, 60)) })),
    [mealDoseData, scaleToMain]
  );
  const scaledInsulinDoseData = useMemo(
    () => insulinDoseData.map(p => ({ x: p.x, y: scaleToMain(Math.max(p.y, -60)) })),
    [insulinDoseData, scaleToMain]
  );

  // Right-axis tick positions (in main y-space) paired with their dose labels
  const doseAxisTicks = useMemo(
    () => DOSE_RAW_TICKS.map(v => scaleToMain(v)),
    [scaleToMain]
  );

  // ── Loading / error states ────────────────────────────────────────────────────
  // Only show full-screen spinner on the FIRST load (effects are still fetching
  // AND we have no chart data yet).  Once effectsLoading is false — even with
  // empty data — we fall through to the chart render which shows the "no data"
  // empty state instead of spinning forever.
  // Show spinner only while genuinely loading AND not yet timed out.
  // timedOut = true after LOAD_TIMEOUT_MS — breaks the infinite spinner
  // caused by useActiveEffects.isLoading never flipping to false on empty data.
  const showFullScreenLoader = effectsLoading && !timedOut && chartData.length === 0;

  if (showFullScreenLoader) {
    return (
      <View style={[styles.centered, { height }]}>
        <ActivityIndicator size="large" color="#2196F3" />
        <Text style={styles.loadingText}>Loading effects data…</Text>
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

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.container, embedded && styles.embedded]}>

      {/* ── Header ── */}
      {showControls && (
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle}>Insulin, Meal &amp; Net Effects</Text>
            <Text style={styles.headerSubtitle}>
              Blue dashed = Current rate · Green = Cumulative shift
            </Text>
          </View>
          <TouchableOpacity
            onPress={refresh}
            style={styles.refreshBtn}
            hitSlop={8}
          >
            <Text style={styles.refreshIcon}>{effectsLoading ? '⏳' : '🔄'}</Text>
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
              <Text
                style={[
                  styles.viewModeBtnText,
                  viewMode === key && styles.viewModeBtnTextActive,
                ]}
              >
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
          <ToggleRow label="🍽️ Meal Effect"     color="#FF9800" value={showMealEffect}        onChange={setShowMealEffect}        />
          <ToggleRow label="💉 Insulin Effect"   color="#9C27B0" value={showInsulinEffect}     onChange={setShowInsulinEffect}     />
          <ToggleRow label="📈 Cumulative ⭐"    color="#4CAF50" value={showCumulativeBaseline} onChange={setShowCumulativeBaseline} bold />
          <ToggleRow label="📌 Dose Markers"    color="#607D8B" value={showDoseMarkers}        onChange={setShowDoseMarkers}        />
        </View>
      )}

      {/* ── Victory Chart ── */}
      <View style={styles.chartWrapper}>
        {chartData.length > 0 ? (
          <VictoryChart
            width={CHART_WIDTH}
            height={height}
            theme={VictoryTheme.material}
            domain={{
              x: [timeRange.start, timeRange.end],
              y: yDomain,
            }}
            padding={{ top: 16, bottom: 48, left: 56, right: 56 }}
          >
            {/* X Axis — pinned to the bottom of the y domain via axisValue={yDomain[0]}.
                By default Victory anchors the X-axis at y=0, which sits mid-chart
                whenever the domain extends below zero (insulin effects). Setting
                axisValue to the minimum y value locks it to the chart floor, matching
                the web Recharts XAxis behaviour where ticks always appear at the bottom. */}
            <VictoryAxis
              tickValues={xTicks}
              tickFormat={(t: number) => formatXAxis(t, viewConfig?.tickFormat)}
              axisValue={yDomain[0]}
              style={{
                tickLabels: { fontSize: 9, angle: -45, textAnchor: 'end', fill: '#666' },
                grid:       { stroke: '#f0f0f0', strokeDasharray: '3 3' },
              }}
            />

            {/* Y Axis — effects */}
            <VictoryAxis
              dependentAxis
              tickFormat={(v: number) => `${Math.round(v)}`}
              style={{
                tickLabels: { fontSize: 9, fill: '#666' },
                grid:       { stroke: '#f0f0f0', strokeDasharray: '3 3' },
              }}
            />

            {/* Y Axis (right) — independent 0–60 dose scale.
                Ticks are positioned in main y-space (doseAxisTicks = scaled
                coordinates of [-60,-40,-20,0,20,40,60]) but labelled with their
                original dose values so the axis reads 0→60 on both sides of zero,
                completely independent of the left effects scale. */}
            <VictoryAxis
              dependentAxis
              orientation="right"
              tickValues={doseAxisTicks}
              tickFormat={(_v: number, i: number) => `${Math.abs(DOSE_RAW_TICKS[i])}`}
              style={{
                axis:       { stroke: '#607D8B', strokeWidth: 1 },
                tickLabels: { fontSize: 8, fill: '#607D8B' },
                grid:       { stroke: 'none' },
                ticks:      { stroke: '#607D8B', size: 4 },
              }}
            />

            {/* Zero reference — horizontal line at y=0.
                Must NOT use dependentAxis: without it Victory treats this as an
                X-type axis and axisValue={0} positions it at y=0 in chart space,
                creating the dashed horizontal baseline we want.
                With dependentAxis it would be a second Y-axis placed at x=0,
                which lands directly on top of the primary Y-axis (the left-overlap bug). */}
            <VictoryAxis
              axisValue={0}
              tickFormat={() => ''}
              style={{
                axis:  { stroke: '#999', strokeWidth: 1.5, strokeDasharray: '3 3' },
                ticks: { size: 0 },
                grid:  { stroke: 'none' },
              }}
            />

            {/* "Now" vertical reference line
                ─────────────────────────────────────────────────────────────
                WHY dependentAxis is required here (mirrors BloodGlucoseVisualization):
                  Victory interprets `axisValue` differently depending on axis type:
                    • Non-dependentAxis (X-axis):  axisValue = Y position
                      → draws a HORIZONTAL line at that Y value.
                    • dependentAxis    (Y-axis):  axisValue = X position
                      → draws a VERTICAL line at that X value.
                  Without `dependentAxis`, Victory treats timeRange.now
                  (a Unix ms timestamp, ~1.7 × 10¹²) as a Y position —
                  far outside yDomain — and the line is drawn off-screen.
                  `dependentAxis` places the axis at the correct X timestamp,
                  producing the visible vertical "now" separator.
            */}
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

            {/* Dose markers — bars pre-scaled into main y-space so they render
                correctly on the shared domain while the right axis labels show
                the original dose units (0–60 independent scale). */}
            {showDoseMarkers && scaledMealDoseData.length > 0 && (
              <VictoryBar
                data={scaledMealDoseData}
                barWidth={6}
                style={{ data: { fill: '#FF9800', opacity: 0.8 } }}
              />
            )}
            {showDoseMarkers && scaledInsulinDoseData.length > 0 && (
              <VictoryBar
                data={scaledInsulinDoseData}
                barWidth={6}
                style={{ data: { fill: '#9C27B0', opacity: 0.8 } }}
              />
            )}

            {/* Meal effect area (orange) */}
            {showMealEffect && (
              <VictoryArea
                data={mealEffectData}
                interpolation="monotoneX"
                style={{
                  data: { fill: '#FF9800', fillOpacity: 0.25, stroke: '#FF9800', strokeWidth: 2 },
                }}
              />
            )}

            {/* Insulin effect area (purple, negative) */}
            {showInsulinEffect && (
              <VictoryArea
                data={insulinEffectData}
                interpolation="monotoneX"
                style={{
                  data: { fill: '#9C27B0', fillOpacity: 0.25, stroke: '#9C27B0', strokeWidth: 2 },
                }}
              />
            )}

            {/* Net effect line (blue dashed) */}
            {showNetEffect && (
              <VictoryLine
                data={netEffectData}
                interpolation="monotoneX"
                style={{
                  data: { stroke: '#2196F3', strokeWidth: 2.5, strokeDasharray: '5 5' },
                }}
              />
            )}

            {/* Cumulative baseline line (green solid ⭐) */}
            {showCumulativeBaseline && (
              <VictoryLine
                data={cumulativeData}
                interpolation="monotoneX"
                style={{
                  data: { stroke: '#4CAF50', strokeWidth: 3 },
                }}
              />
            )}
          </VictoryChart>
        ) : (
          <View style={[styles.centered, { height: height * 0.7 }]}>
            {generating ? (
              <>
                <ActivityIndicator size="small" color="#2196F3" />
                <Text style={styles.emptyText}>Calculating…</Text>
              </>
            ) : (
              <>
                <Text style={styles.emptyIcon}>📊</Text>
                <Text style={styles.emptyText}>No meal or insulin data in this period.</Text>
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
              { color: '#FF9800', label: 'Meal Effect',        desc: 'Instantaneous BG elevation from active meals',             area: true  },
              { color: '#9C27B0', label: 'Insulin Effect',     desc: 'Instantaneous BG reduction from active insulin (negative)', area: true  },
              { color: '#2196F3', label: 'Net Effect',         desc: 'Combined meal + insulin rate-of-change',                   line: true, dashed: true  },
              { color: '#4CAF50', label: 'Cumulative Shift ⭐', desc: 'Running "bank balance" from the day\'s reset hour',        line: true, dashed: false },
            ].map(({ color, label, desc, area, line, dashed }) => (
              <View key={label} style={styles.aboutSeriesRow}>
                {area
                  ? <View style={[styles.aboutArea, { backgroundColor: color }]} />
                  : <View style={[styles.aboutLine, { backgroundColor: color }, dashed && styles.aboutLineDashed]} />
                }
                <View style={styles.aboutSeriesText}>
                  <Text style={styles.aboutSeriesLabel}>{label}</Text>
                  <Text style={styles.aboutSeriesDesc}>{desc}</Text>
                </View>
              </View>
            ))}

            {/* Dose markers */}
            <Text style={[styles.aboutSectionLabel, { marginTop: 12 }]}>Dose Markers</Text>
            {[
              { color: '#FF9800', label: 'Meal bar',    desc: 'Carb-equivalent at logged meal time'   },
              { color: '#9C27B0', label: 'Insulin bar', desc: 'Units × scale at injection time'       },
            ].map(({ color, label, desc }) => (
              <View key={label} style={styles.aboutSeriesRow}>
                <View style={[styles.aboutBar, { backgroundColor: color }]} />
                <View style={styles.aboutSeriesText}>
                  <Text style={styles.aboutSeriesLabel}>{label}</Text>
                  <Text style={styles.aboutSeriesDesc}>{desc}</Text>
                </View>
              </View>
            ))}

            {/* Reference lines */}
            <Text style={[styles.aboutSectionLabel, { marginTop: 12 }]}>Reference Lines</Text>
            {[
              { color: '#da2a2a', desc: 'Current time (Now)'               },
              { color: '#2196F3', desc: 'Zero baseline (no net effect)'     },
            ].map(({ color, desc }) => (
              <View key={desc} style={styles.aboutRefRow}>
                <Text style={[styles.aboutDash, { color }]}>– –</Text>
                <Text style={styles.aboutRefDesc}>{desc}</Text>
              </View>
            ))}

            {/* How it works note */}
            <View style={styles.aboutNoteBox}>
              <Text style={styles.aboutNoteText}>
                The Cumulative Shift resets each day at your configured reset hour (default 7 AM). Meals push it up; insulin pushes it down. The "bank balance" persists at full effect once absorption is complete.
              </Text>
            </View>
          </View>
        )}
      </View>

      {/* ── Now summary ── */}
      {chartData.length > 0 && (() => {
        const nowPoint = chartData.find(p => p.isNow) ?? chartData[Math.floor(chartData.length / 2)];
        const baseline = stableBaseline ?? patientConstants?.target_glucose ?? 100;
        const estimatedBG = baseline + nowPoint.cumulativeNetBaseline;

        return (
          <View style={styles.nowSummary}>
            <View style={styles.nowSummaryMain}>
              <Text style={styles.nowLabel}>Current BG Estimate</Text>
              <Text style={[
                styles.nowBG,
                estimatedBG > 180 ? styles.textHigh :
                estimatedBG < 70  ? styles.textLow  :
                styles.textNormal
              ]}>
                {Math.round(estimatedBG)} mg/dL
              </Text>
              <Text style={styles.nowDetail}>
                Baseline {Math.round(baseline)} + Cumulative{' '}
                {nowPoint.cumulativeNetBaseline > 0 ? '+' : ''}
                {Math.round(nowPoint.cumulativeNetBaseline)}
                {baselineMode === 'preset' ? ' vs circadian' : ' vs reading baseline'}
              </Text>
            </View>

            <View style={styles.nowSummaryRight}>
              <SummaryPill
                label="Meal"
                value={`+${Math.round(nowPoint.mealImpact)}`}
                color="#FF9800"
              />
              <SummaryPill
                label="Insulin"
                value={`${Math.round(nowPoint.insulinImpact)}`}
                color="#9C27B0"
              />
              <SummaryPill
                label="Net"
                value={`${nowPoint.netEffect > 0 ? '+' : ''}${Math.round(nowPoint.netEffect)}`}
                color="#2196F3"
              />
            </View>
          </View>
        );
      })()}

      {/* ── Tap-to-inspect tooltip modal ── */}
      {tooltipData !== null && (
        <TooltipModal
          data={tooltipData.point}
          stableBaseline={stableBaseline ?? patientConstants?.target_glucose ?? 100}
          onClose={() => setTooltipData(null)}
        />
      )}
    </View>
  );
};

// ============================================================
// SUB-COMPONENTS
// ============================================================

// ── ToggleRow ─────────────────────────────────────────────────

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

// ── LegendItem ───────────────────────────────────────────────

const LegendItem: React.FC<{ color: string; label: string; dashed: boolean }> = ({
  color, label, dashed
}) => (
  <View style={styles.legendItem}>
    <View style={[
      styles.legendLine,
      { backgroundColor: color },
      dashed && styles.legendLineDashed,
    ]} />
    <Text style={styles.legendLabel}>{label}</Text>
  </View>
);

// ── SummaryPill ──────────────────────────────────────────────

const SummaryPill: React.FC<{ label: string; value: string; color: string }> = ({
  label, value, color
}) => (
  <View style={[styles.pill, { borderColor: color }]}>
    <Text style={styles.pillLabel}>{label}</Text>
    <Text style={[styles.pillValue, { color }]}>{value}</Text>
  </View>
);

// ── TooltipModal ─────────────────────────────────────────────

interface TooltipModalProps {
  data:            EffectsChartPoint;
  stableBaseline:  number;
  onClose:         () => void;
}

const TooltipModal: React.FC<TooltipModalProps> = ({ data, stableBaseline, onClose }) => {
  const estimatedBG  = stableBaseline + data.cumulativeNetBaseline;
  const hasMealDose  = data.mealsAdministered.length > 0;
  const hasInsulinDose = data.insulinAdministered.length > 0;

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.modalCard}>
          {/* Header */}
          <View style={styles.modalHeader}>
            <Text style={styles.modalTime}>
              {data.formattedTime}
              {data.isNow ? '  🔴 Now' : ''}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Text style={styles.modalClose}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView>
            {/* Current BG estimate (shown only at "Now") */}
            {data.isNow && (
              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>📊 Current BG Estimate</Text>
                <Text style={styles.modalBig}>{Math.round(estimatedBG)} mg/dL</Text>
                <Text style={styles.modalMuted}>
                  Baseline {Math.round(stableBaseline)}{' '}
                  {data.cumulativeNetBaseline >= 0 ? '+' : ''}
                  {Math.round(data.cumulativeNetBaseline)} cumulative
                </Text>
              </View>
            )}

            {/* Doses */}
            {(hasMealDose || hasInsulinDose) && (
              <View style={[styles.modalSection, { borderColor: '#2196F3' }]}>
                <Text style={styles.modalSectionTitle}>💊 Doses at this time</Text>

                {hasMealDose && (
                  <>
                    <Text style={[styles.modalLabel, { color: '#FF9800' }]}>
                      🍽️ Meals ({data.mealsAdministered.length})
                    </Text>
                    {data.mealsAdministered.map((m: any, i: number) => (
                      <Text key={i} style={styles.modalItem}>
                        • {m.mealType ?? 'Meal'}: {(m.carbEquiv ?? 0).toFixed(1)}g carbs
                      </Text>
                    ))}
                  </>
                )}

                {hasInsulinDose && (
                  <>
                    <Text style={[styles.modalLabel, { color: '#9C27B0', marginTop: 8 }]}>
                      💉 Insulin ({data.insulinAdministered.length})
                    </Text>
                    {data.insulinAdministered.map((d: any, i: number) => (
                      <Text key={i} style={styles.modalItem}>
                        • {d.insulinType ?? d.medication}: {(d.dose ?? d.units ?? 0).toFixed(1)}u
                      </Text>
                    ))}
                  </>
                )}
              </View>
            )}

            {/* Current activity */}
            {(data.mealImpact > 0.1 || Math.abs(data.insulinImpact) > 0.1) && (
              <View style={[styles.modalSection, { backgroundColor: '#fff9e6' }]}>
                <Text style={[styles.modalSectionTitle, { color: '#E65100' }]}>
                  ⚡ Current Activity (Rate)
                </Text>
                {data.mealImpact > 0.1 && (
                  <Text style={styles.modalRow}>
                    🍽️ Meal:{' '}
                    <Text style={{ color: '#FF9800', fontWeight: '700' }}>
                      +{Math.round(data.mealImpact)} mg/dL
                    </Text>
                  </Text>
                )}
                {Math.abs(data.insulinImpact) > 0.1 && (
                  <Text style={styles.modalRow}>
                    💉 Insulin:{' '}
                    <Text style={{ color: '#9C27B0', fontWeight: '700' }}>
                      {Math.round(data.insulinImpact)} mg/dL
                    </Text>
                  </Text>
                )}
                <Text style={[styles.modalRow, { marginTop: 6, fontWeight: '600' }]}>
                  Net:{' '}
                  <Text style={{
                    color: data.netEffect > 0 ? '#FF9800' : data.netEffect < 0 ? '#4CAF50' : '#666',
                    fontWeight: '700',
                  }}>
                    {data.netEffect > 0 ? '+' : ''}{Math.round(data.netEffect)} mg/dL
                  </Text>
                </Text>
              </View>
            )}

            {/* Cumulative bank balance */}
            <View style={[styles.modalSection, { borderColor: '#4CAF50', backgroundColor: '#e8f5e9' }]}>
              <Text style={[styles.modalSectionTitle, { color: '#2E7D32' }]}>
                📈 Cumulative Shift (Bank Balance)
              </Text>
              <Text style={styles.modalRow}>
                Meals:    <Text style={{ color: '#FF9800' }}>+{Math.round(data.cumulativeMealEffect)}</Text>
              </Text>
              <Text style={styles.modalRow}>
                Insulin:  <Text style={{ color: '#9C27B0' }}>{Math.round(data.cumulativeInsulinEffect)}</Text>
              </Text>
              <Text style={[styles.modalRow, { fontWeight: '700', marginTop: 6 }]}>
                Net shift:{' '}
                <Text style={{
                  color: data.cumulativeNetBaseline > 0 ? '#FF6B00'
                       : data.cumulativeNetBaseline < 0 ? '#2E7D32'
                       : '#666',
                  fontSize: 16,
                }}>
                  {data.cumulativeNetBaseline > 0 ? '+' : ''}
                  {Math.round(data.cumulativeNetBaseline)} mg/dL
                </Text>
              </Text>
              <Text style={styles.modalMuted}>
                {data.cumulativeNetBaseline > 0 ? 'Above baseline ⬆️'
                : data.cumulativeNetBaseline < 0 ? 'Below baseline ⬇️'
                : 'At baseline ➡️'}
              </Text>
            </View>

            <Text style={styles.modalFooter}>
              {data.isHistorical ? '📊 Historical' : '🔮 Projected'}
            </Text>
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
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
  },
  embedded: {
    borderRadius: 0,
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
    backgroundColor: '#2196F3',
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
  headerText: { flex: 1 },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  headerSubtitle: {
    fontSize: 11,
    color: '#888',
    marginTop: 2,
  },
  refreshBtn: {
    padding: 4,
    marginLeft: 8,
  },
  refreshIcon: {
    fontSize: 20,
  },

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
    backgroundColor: '#2196F3',
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
  viewModeBtnCustom:     { borderWidth: 1.5, borderColor: '#2196F3', backgroundColor: 'transparent' },
  customRangePanel:      { paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0', backgroundColor: '#f0f8ff' },
  customRangeRow:        { flexDirection: 'row', gap: 8, marginBottom: 4 },
  customRangePicker:     { flex: 1 },
  customRangeApplyBtn:   { backgroundColor: '#2196F3', borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  customRangeAppliedBtn: { backgroundColor: '#1565C0' },
  customRangeApplyText:  { color: '#fff', fontWeight: '700', fontSize: 14 },

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
    color: '#2E7D32',
  },
  toggleSwitch: {
    transform: [{ scaleX: 0.75 }, { scaleY: 0.75 }],
  },

  // ── Chart wrapper ──
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
  aboutBar: {
    width: 6,
    height: 16,
    borderRadius: 2,
    opacity: 0.8,
    flexShrink: 0,
    marginLeft: 7,
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
    backgroundColor: '#f8f9ff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e0e8ff',
  },
  nowSummaryMain: {
    flex: 1,
  },
  nowLabel: {
    fontSize: 11,
    color: '#666',
    marginBottom: 2,
  },
  nowBG: {
    fontSize: 28,
    fontWeight: '700',
  },
  textHigh:   { color: '#FF6B00' },
  textLow:    { color: '#E53935' },
  textNormal: { color: '#2196F3' },
  nowDetail: {
    fontSize: 11,
    color: '#888',
    marginTop: 2,
  },
  nowSummaryRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
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
  pillLabel: {
    fontSize: 10,
    color: '#888',
  },
  pillValue: {
    fontSize: 12,
    fontWeight: '700',
  },

  // ── Tooltip modal ──
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    maxHeight: '80%',
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
  modalTime: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  modalClose: {
    fontSize: 18,
    color: '#888',
    padding: 4,
  },
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
  modalBig: {
    fontSize: 28,
    fontWeight: '700',
    color: '#2196F3',
  },
  modalLabel: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  modalItem: {
    fontSize: 12,
    color: '#444',
    paddingLeft: 8,
    marginBottom: 2,
  },
  modalRow: {
    fontSize: 13,
    color: '#444',
    marginBottom: 4,
  },
  modalMuted: {
    fontSize: 11,
    color: '#888',
    marginTop: 4,
    fontStyle: 'italic',
  },
  modalFooter: {
    textAlign: 'center',
    fontSize: 11,
    color: '#999',
    marginVertical: 12,
  },
});

export default React.memo(EffectsVisualizationChart);