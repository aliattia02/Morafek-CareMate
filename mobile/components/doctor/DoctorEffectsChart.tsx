/**
 * DoctorEffectsChart
 * Location: mobile/components/doctor/DoctorEffectsChart.tsx
 *
 * A data-driven adaptation of EffectsVisualizationChart for the doctor patient
 * view. Accepts pre-fetched meals + patient constants as props instead of
 * calling the patient's own hooks (useActiveEffects, usePatientConstants).
 *
 * WHAT'S SHOWN vs EffectsVisualizationChart:
 *   ✅ Meal effect area (orange)      — MOB curve across time
 *   ✅ Cumulative meal baseline (green) — bank-balance line
 *   ✅ Net effect line (blue dashed)
 *   ✅ Meal dose bars (orange)
 *   ✅ Stats summary (active carbs, peak impact, TIR equivalent)
 *   ⚠️ Insulin effects (purple area) — NOT available.
 *       The doctor API does not expose a patient's insulin dose history.
 *       The net-effect line therefore reflects meals only.
 *
 * Visual language mirrors EffectsVisualizationChart exactly.
 */

import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Switch,
  StyleSheet,
  Dimensions,
  Modal,
} from 'react-native';
import {
  VictoryChart,
  VictoryArea,
  VictoryLine,
  VictoryBar,
  VictoryAxis,
  VictoryScatter,
} from 'victory-native';

import { calculateStackedMealEffect } from '@/utils/glucose/meal-pharmacodynamics';
import {
  calculateStackedInsulinChartEffect,
} from '@/utils/insulin/pharmacodynamics';
import { calculateTotalCumulativeEffects } from '@/utils/calculations';
import { MEAL_ABSORPTION_PROFILES } from '@/constants/shared-constants';

import {
  parseUTCMs,
  processContextMealsForChart,
  getMealDurationHours,
  normaliseDose,
  doseToStacking,
  getLastResetTimeMs,
  formatXAxis,
  useCurrentMinute,
  VIEW_CONFIGS as BASE_VIEW_CONFIGS,
} from '@/utils/ChartUtils';
import UnifiedTimePicker from '@/components/forms/UnifiedTimePicker';

import type { MealResponse } from '@/types/api';
import type { PatientConstantsData, InsulinDoseResponse } from '@/services/api/doctor';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CHART_HEIGHT = 260;
const CHART_WIDTH  = SCREEN_WIDTH - 48;

// Extend the shared VIEW_CONFIGS with doctor-only week/month views.
// Using BASE_VIEW_CONFIGS as the foundation keeps shared timing values in sync
// with the patient chart as ChartUtils evolves.
const VIEW_CONFIGS = {
  ...BASE_VIEW_CONFIGS,
  // BASE_VIEW_CONFIGS (from ChartUtils) merges SHARED_CONSTANTS.VIEW_MODE_CONFIGS,
  // which only provides `interpolationInterval` — never `stepMins`.  Without this
  // override, viewCfg.stepMins is undefined for 3h/6h/12h/24h, STEP becomes NaN,
  // the for-loop in buildChartData never advances, and the chart renders 0 points.
  // Derive stepMins directly from interpolationInterval so the two stay in sync
  // automatically when shared-constants.ts is regenerated from the backend.
  '3h':  { ...BASE_VIEW_CONFIGS['3h'],  stepMins: BASE_VIEW_CONFIGS['3h']?.interpolationInterval  ?? 1  },
  '6h':  { ...BASE_VIEW_CONFIGS['6h'],  stepMins: BASE_VIEW_CONFIGS['6h']?.interpolationInterval  ?? 5  },
  '12h': { ...BASE_VIEW_CONFIGS['12h'], stepMins: BASE_VIEW_CONFIGS['12h']?.interpolationInterval ?? 10 },
  '24h': { ...BASE_VIEW_CONFIGS['24h'], stepMins: BASE_VIEW_CONFIGS['24h']?.interpolationInterval ?? 15 },
  week:  { label: 'Week',  pastHours: 168, futureHours: 0, tickInterval: 24, tickFormat: 'DD/MM', stepMins: 60  },
  month: { label: 'Month', pastHours: 720, futureHours: 0, tickInterval: 72, tickFormat: 'DD/MM', stepMins: 120 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface EffectsPoint {
  timestamp:        number;
  mealImpact:       number;
  insulinImpact:    number;
  cumulativeBaseline: number;
  netEffect:        number;
  doseMarker:       number | null;
  insulinDoseMarker: number | null;
  meals:            any[];
  insulinDoses:     any[];
}

interface TooltipData {
  point: EffectsPoint;
}

export interface DoctorEffectsChartProps {
  meals:        MealResponse[];
  insulinDoses: InsulinDoseResponse[];
  constants:    PatientConstantsData | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// parseUTCMs, getMealDurationHours, normaliseDose, doseToStacking,
// getLastResetTimeMs, formatXAxis all imported from ChartUtils.

// formatTick replaced by formatXAxis from ChartUtils.

// normaliseMeal removed — replaced by processContextMealsForChart (imported from
// ChartUtils) which gives identical meal processing to the patient chart, including
// timezone-aware carb-equiv computation and correct timestamp normalisation.

/**
 * Build chart data for the full time range using the same per-point
 * calculation pattern as EffectsVisualizationChart.buildChartPoint().
 * Now includes insulin effects from the doctor API.
 */
function buildChartData(
  normalisedMeals: any[],
  normalisedDoses: any[],
  rangeStart: number,
  rangeEnd: number,
  stepMins: number,
  constants: PatientConstantsData | null,
  now: number,
): EffectsPoint[] {
  const resetHour        = (constants as any)?.daily_reset_hour ?? 7;
  const tzOffset         = (constants as any)?.timezone_offset_minutes ?? 0;
  const correctionFactor = (constants as any)?.correction_factor ?? 40;

  const HALF_STEP = (stepMins / 2) * 60_000;
  const STEP      = stepMins * 60_000;

  // ✅ FIX: processContextMealsForChart converts timestamps to numbers.
  // Use a numeric fast-path so both string and number timestamps work.
  const getMealMs = (m: any): number =>
    typeof m.timestamp === 'number' ? m.timestamp : parseUTCMs(m.timestamp);

  // ── Cumulative window — always reach back to the daily reset ──────────────
  // Using rangeStart as the lower bound causes the same shape-change bug fixed
  // in EffectsVisualizationChart: switching to a short view (3H/6H/12H) moves
  // rangeStart forward past meals eaten earlier today, so allMealsInWindow is
  // empty for those points and cumulativeNetBaseline stays flat at 0.
  //
  // Fix: extend the lower bound to the patient's last daily reset so that all
  // meals/doses from today's window are always included, regardless of how
  // short the visible chart range is.
  const lastResetMs       = getLastResetTimeMs(new Date(now), resetHour, tzOffset);
  const cumulativeWindowStart = Math.min(rangeStart, lastResetMs);

  const allMealsInWindow = normalisedMeals.filter(m => {
    const ms = getMealMs(m);
    // ✅ FIX: use rangeEnd (not `now`) so future-snapped meals (timestamp =
    // insulinTime + offset) reach calculateTotalCumulativeEffects and appear
    // in the green cumulative line. Safe: calculateAbsorbedFraction returns
    // 0 for any chart point before the meal's own timestamp.
    return !isNaN(ms) && ms >= cumulativeWindowStart && ms <= rangeEnd;
  });
  const allDosesInWindow = normalisedDoses.filter(d => {
    const ms = parseUTCMs(d.administrationTime);
    return !isNaN(ms) && ms >= cumulativeWindowStart && ms <= now;
  });

  const points: EffectsPoint[] = [];

  for (let ts = rangeStart; ts <= rangeEnd; ts += STEP) {
    const targetTime = new Date(ts);

    // ── Meal effect ────────────────────────────────────────────────────────
    const activeMeals = normalisedMeals.filter(m => {
      const mealMs = getMealMs(m);
      if (isNaN(mealMs) || mealMs > ts) return false;
      return (ts - mealMs) / 3_600_000 < getMealDurationHours(m);
    });

    const mealResult = activeMeals.length > 0
      ? calculateStackedMealEffect(activeMeals, targetTime, constants ?? {})
      : { totalBGElevation: 0 };

    const mealImpact = (mealResult as any).totalBGElevation ?? 0;

    // ── Insulin effect (S-curve, same as EffectsVisualizationChart) ────────
    const dosesForStacking = normalisedDoses
      .map(d => doseToStacking(d, targetTime))
      .filter((d): d is InsulinDoseForStacking => d !== null);

    const chartInsulinResult = dosesForStacking.length > 0
      ? calculateStackedInsulinChartEffect(dosesForStacking, correctionFactor)
      : { totalBGImpact: 0, totalIOB: 0 };

    const insulinImpact = chartInsulinResult.totalBGImpact; // always <= 0

    const netEffect = mealImpact + insulinImpact;

    // ── Cumulative bank-balance ────────────────────────────────────────────
    const mealsUpToNow = allMealsInWindow.filter(m => getMealMs(m) <= ts);
    const dosesUpToNow = allDosesInWindow.filter(d => parseUTCMs(d.administrationTime) <= ts);

    const cumulative = (mealsUpToNow.length > 0 || dosesUpToNow.length > 0)
      ? calculateTotalCumulativeEffects(
          mealsUpToNow,
          dosesUpToNow,
          targetTime,
          constants ?? {},
          MEAL_ABSORPTION_PROFILES as any,
          resetHour,
          tzOffset,
        )
      : { cumulativeNetBaseline: 0 };

    const cumulativeBaseline = (cumulative as any).cumulativeNetBaseline ?? 0;

    // ── Dose markers ───────────────────────────────────────────────────────
    const mealsAtTs = normalisedMeals.filter(m => {
      const mealMs = getMealMs(m);
      return !isNaN(mealMs) && Math.abs(mealMs - ts) < HALF_STEP;
    });
    const dosesAtTs = normalisedDoses.filter(d => {
      const doseMs = parseUTCMs(d.administrationTime);
      return !isNaN(doseMs) && Math.abs(doseMs - ts) < HALF_STEP;
    });

    const totalCarbs = mealsAtTs.reduce((s, m) => {
      // ✅ FIX: processContextMealsForChart sets m.carbEquiv; also extend the
      // fallback chain to mirror EffectsVisualizationChart exactly.
      const c =
        m.carbEquiv                             ??
        m.calculation_summary?.total_carb_equiv ??
        m.nutrition?.total_carb_equiv           ??
        m.nutrition?.totalCarbEquiv             ??
        m.nutrition?.totalCarbs                 ??
        m.nutrition?.carbs                      ?? 0;
      return s + c;
    }, 0);
    const totalInsulin = dosesAtTs.reduce((s, d) => s + (d.units ?? d.dose ?? 0), 0);

    points.push({
      timestamp:          ts,
      mealImpact,
      insulinImpact,
      cumulativeBaseline,
      netEffect,
      doseMarker:         totalCarbs > 0   ? totalCarbs            : null,
      insulinDoseMarker:  totalInsulin > 0 ? -(totalInsulin * 5)   : null,
      meals:              mealsAtTs,
      insulinDoses:       dosesAtTs,
    });
  }

  return points;
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom view config — derives tick density + step from selected date range
// ─────────────────────────────────────────────────────────────────────────────

function getCustomViewConfig(start: Date, end: Date): typeof VIEW_CONFIGS[string] {
  const durationHours = (end.getTime() - start.getTime()) / 3_600_000;
  const futureHours   = Math.max(0, (end.getTime() - Date.now()) / 3_600_000);
  const pastHours     = Math.max(0, (Date.now() - start.getTime()) / 3_600_000);
  let tickFormat: string;
  let tickInterval: number;
  let stepMins: number;
  if (durationHours <= 6)        { tickFormat = 'HH:mm'; tickInterval = 1;  stepMins = 5;   }
  else if (durationHours <= 24)  { tickFormat = 'HH:mm'; tickInterval = 3;  stepMins = 15;  }
  else if (durationHours <= 72)  { tickFormat = 'DD/MM'; tickInterval = 12; stepMins = 30;  }
  else if (durationHours <= 168) { tickFormat = 'DD/MM'; tickInterval = 24; stepMins = 60;  }
  else                           { tickFormat = 'DD/MM'; tickInterval = 72; stepMins = 120; }
  return { label: 'Custom', pastHours, futureHours, tickInterval, tickFormat, stepMins };
}

// ─────────────────────────────────────────────────────────────────────────────
// 24H range helper — mirrors the patient chart which starts at the daily reset
// (default 7 AM) rather than a rolling 24-hour window.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * For the '24h' view mode, return yesterday's daily-reset time (e.g. yesterday
 * at 07:00 local) as the range start, matching the patient chart's
 * useChartTimeRange('24h') which always shows the previous full reset-period.
 * All other view modes fall through to the standard now - pastHours formula.
 */
function get24hAwareRangeStart(
  viewMode: string,
  now: number,
  pastHours: number,
  constants: PatientConstantsData | null,
): number {
  if (viewMode !== '24h') return now - pastHours * 3_600_000;
  const resetHour = (constants as any)?.daily_reset_hour ?? 7;
  const tzOffset  = (constants as any)?.timezone_offset_minutes ?? 0;
  // getLastResetTimeMs returns TODAY's most recent reset (e.g. today at 07:00).
  // The patient chart's useChartTimeRange('24h') starts from YESTERDAY's reset
  // so the doctor gets the same 24-hour window of history.  Subtract one full
  // day to align with the patient view.
  return getLastResetTimeMs(new Date(now), resetHour, tzOffset) - 24 * 3_600_000;
}



export const DoctorEffectsChart: React.FC<DoctorEffectsChartProps> = ({
  meals,
  insulinDoses,
  constants,
}) => {
  const [viewMode, setViewMode]       = useState<'3h' | '6h' | '12h' | '24h' | 'week' | 'month' | 'custom'>('12h');

  // ── Custom date-range filter ────────────────────────────────────────────
  const [customRangeStart, setCustomRangeStart] = useState<Date>(() => new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000));
  const [customRangeEnd,   setCustomRangeEnd]   = useState<Date>(() => new Date());
  const [customApplied,    setCustomApplied]    = useState(true);

  const [showMealEffect, setMeal]     = useState(true);
  const [showCumulative, setCumul]    = useState(true);
  const [showDoseMarkers, setMarkers]     = useState(true);
  const [showInsulinEffect, setInsulin]   = useState(true);
  const [tooltip, setTooltip]             = useState<TooltipData | null>(null);

  const viewCfg = viewMode === 'custom'
    ? getCustomViewConfig(customRangeStart, customRangeEnd)
    : VIEW_CONFIGS[viewMode];
  // useCurrentMinute() updates at each :00 wall-clock tick (same cadence as the
  // patient charts) so the "now" line and chart window advance automatically.
  const now        = useCurrentMinute();
  const rangeStart = viewMode === 'custom' && customApplied
    ? customRangeStart.getTime()
    : get24hAwareRangeStart(viewMode, now, viewCfg.pastHours, constants);
  const rangeEnd   = viewMode === 'custom' && customApplied ? customRangeEnd.getTime()   : now + viewCfg.futureHours * 3_600_000;

  const normMeals = useMemo(
    // ✅ FIX: Use processContextMealsForChart (same pipeline as patient chart) instead
    // of the local normaliseMeal. This ensures:
    //   1. Identical carbEquiv computation (including foodItems fallback)
    //   2. Numeric timestamps (avoids parseUTCMs string-only issues)
    //   3. 8-hour lookback so meals active at rangeStart are included
    //   4. Patient constants (protein/fat factors) applied correctly
    () => processContextMealsForChart(
      meals,
      { start: rangeStart, end: rangeEnd, now },
      constants as any,   // PatientConstantsData ≈ PatientConstants at runtime
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meals, rangeStart, rangeEnd, now, constants],
  );

  const normDoses = useMemo(
    () => (insulinDoses ?? []).map(normaliseDose),
    [insulinDoses],
  );

  // Defensive fallback: viewCfg.stepMins is set via VIEW_CONFIGS above, but guard
  // against future ChartUtils changes where BASE_VIEW_CONFIGS might drop it again.
  const stepMins = viewCfg.stepMins ?? (viewCfg as any).interpolationInterval ?? 10;

  const chartData = useMemo(
    () => buildChartData(normMeals, normDoses, rangeStart, rangeEnd, stepMins, constants, now),
    [normMeals, normDoses, rangeStart, rangeEnd, stepMins, constants, now],
  );

  // Victory data arrays
  const mealAreaData = chartData.map(p => ({ x: p.timestamp, y: p.mealImpact,  y0: 0 }));
  const cumulData    = chartData.map(p => ({ x: p.timestamp, y: p.cumulativeBaseline }));
  const netData      = chartData.map(p => ({ x: p.timestamp, y: p.netEffect }));
  const doseBarData  = chartData
    .filter(p => p.doseMarker !== null)
    .map(p => ({ x: p.timestamp, y: p.doseMarker! * 0.5 }));   // scale for visibility
  const insulinAreaData = chartData.map(p => ({ x: p.timestamp, y: p.insulinImpact, y0: 0 }));
  const insulinDoseBarData = chartData
    .filter(p => p.insulinDoseMarker !== null)
    .map(p => ({ x: p.timestamp, y: p.insulinDoseMarker! }));

  // Y domain — symmetric around 0, matching EffectsVisualizationChart.
  // Uses the same calculateEffectsAxisDomain logic: take the max absolute value
  // of all series (meal, insulin, cumulative) + 15% padding, then mirror it.
  // The old asymmetric formula [minY*1.2, maxY*1.2] made the chart appear
  // differently scaled vs the patient view when cumulative went very negative.
  const _allAbsValues = [
    30, // minimum floor
    ...chartData.map(p => Math.abs(p.mealImpact)),
    ...chartData.map(p => Math.abs(p.insulinImpact)),
    ...chartData.map(p => Math.abs(p.cumulativeBaseline)),
  ];
  const _maxAbsolute = Math.max(..._allAbsValues);
  const _limit = Math.ceil(_maxAbsolute * 1.15);
  const yDomain: [number, number] = [-_limit, _limit];

  const xTicks = useMemo(() => {
    const ticks: number[] = [];
    const step = viewCfg.tickInterval * 3_600_000;
    let t = Math.ceil(rangeStart / step) * step;
    while (t <= rangeEnd) { ticks.push(t); t += step; }
    return ticks;
  }, [rangeStart, rangeEnd, viewCfg.tickInterval]);

  // Summary stats
  const activeMealsNow = normMeals.filter(m => {
    const mealMs = parseUTCMs(m.timestamp);
    if (isNaN(mealMs)) return false;
    const h = (now - mealMs) / 3_600_000;
    return h >= 0 && h < getMealDurationHours(m);
  });

  const currentEffect = chartData.find(p => Math.abs(p.timestamp - now) < stepMins * 60_000);
  const peakImpact    = Math.max(0, ...chartData.map(p => p.mealImpact));

  if (!meals.length) {
    return (
      <View style={s.empty}>
        <Text style={s.emptyIcon}>🍽️</Text>
        <Text style={s.emptyTitle}>No meal data available</Text>
        <Text style={s.emptySubtitle}>No meals logged for this patient</Text>
      </View>
    );
  }

  return (
    <View style={s.container}>
      {/* Summary bar */}
      <View style={s.summaryBar}>
        <View style={s.summaryItem}>
          <Text style={[s.summaryValue, { color: '#f97316' }]}>{activeMealsNow.length}</Text>
          <Text style={s.summaryLabel}>Active{'\n'}Meals</Text>
        </View>
        <View style={s.summaryDivider} />
        <View style={s.summaryItem}>
          <Text style={[s.summaryValue, { color: currentEffect && currentEffect.netEffect < 0 ? '#9c27b0' : '#f97316' }]}>
            {currentEffect ? `${currentEffect.netEffect >= 0 ? '+' : ''}${Math.round(currentEffect.netEffect)}` : '—'}
          </Text>
          <Text style={s.summaryLabel}>Current{'\n'}Effect mg/dL</Text>
        </View>
        <View style={s.summaryDivider} />
        <View style={s.summaryItem}>
          <Text style={[s.summaryValue, { color: '#22c55e' }]}>
            {currentEffect ? `${currentEffect.cumulativeBaseline > 0 ? '+' : ''}${Math.round(currentEffect.cumulativeBaseline)}` : '—'}
          </Text>
          <Text style={s.summaryLabel}>Cumulative{'\n'}Shift mg/dL</Text>
        </View>
        <View style={s.summaryDivider} />
        <View style={s.summaryItem}>
          <Text style={[s.summaryValue, { color: '#374151' }]}>{Math.round(peakImpact)}</Text>
          <Text style={s.summaryLabel}>Peak{'\n'}Impact</Text>
        </View>
      </View>

      {/* View mode */}
      <View style={s.viewModeRow}>
        {(['3h', '6h', '12h', '24h', 'week', 'month'] as const).map(m => (
          <TouchableOpacity
            key={m}
            style={[s.viewBtn, viewMode === m && s.viewBtnActive]}
            onPress={() => setViewMode(m)}
          >
            <Text style={[s.viewBtnText, viewMode === m && s.viewBtnTextActive]}>
              {VIEW_CONFIGS[m].label}
            </Text>
          </TouchableOpacity>
        ))}
        {/* 📅 Custom date-range button */}
        <TouchableOpacity
          style={[s.viewBtn, s.viewBtnCustom, viewMode === 'custom' && s.viewBtnActive]}
          onPress={() => setViewMode('custom')}
        >
          <Text style={[s.viewBtnText, viewMode === 'custom' && s.viewBtnTextActive]}>
            📅 Range
          </Text>
        </TouchableOpacity>
      </View>

      {/* Custom date-range panel */}
      {viewMode === 'custom' && (
        <View style={s.customRangePanel}>
          <View style={s.customRangeRow}>
            <View style={s.customRangePicker}>
              <UnifiedTimePicker
                label="From"
                value={customRangeStart}
                onChange={(iso) => { setCustomRangeStart(new Date(iso)); setCustomApplied(false); }}
                mode="custom"
                showModeSelector
                displayFormat="datetime"
              />
            </View>
            <View style={s.customRangePicker}>
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
            style={[s.customRangeApplyBtn, customApplied && s.customRangeAppliedBtn]}
            onPress={() => setCustomApplied(true)}
            disabled={customApplied}
          >
            <Text style={s.customRangeApplyText}>
              {customApplied ? '✓ Applied' : 'Apply Range'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Chart */}
      <View style={s.chartWrap}>
        <VictoryChart
          width={CHART_WIDTH}
          height={CHART_HEIGHT}
          domain={{ x: [rangeStart, rangeEnd], y: yDomain }}
          padding={{ top: 16, bottom: 36, left: 52, right: 16 }}
        >
          {/* X axis — pinned to chart floor so ticks always appear at the bottom
               even when insulin pushes the y-domain below zero (mirrors the
               axisValue fix in EffectsVisualizationChart). */}
          <VictoryAxis
            tickValues={xTicks}
            tickFormat={ts => formatXAxis(ts, viewCfg.tickFormat)}
            axisValue={yDomain[0]}
            style={{ axis: { stroke: '#e5e7eb' }, tickLabels: { fontSize: 9, fill: '#9ca3af', angle: -45, textAnchor: 'end' }, grid: { stroke: '#f3f4f6', strokeWidth: 0.5 } }}
          />
          <VictoryAxis
            dependentAxis
            tickFormat={v => `${v > 0 ? '+' : ''}${Math.round(v)}`}
            style={{ axis: { stroke: '#e5e7eb' }, tickLabels: { fontSize: 9, fill: '#9ca3af' }, grid: { stroke: '#f3f4f6', strokeWidth: 0.5 } }}
          />

          {/* Zero reference line — VictoryAxis with axisValue={0} places a
               horizontal dashed line at y=0 (matches patient chart pattern).
               Using a VictoryAxis (not VictoryLine) ensures it is clipped
               correctly to the chart domain. */}
          <VictoryAxis
            axisValue={0}
            tickFormat={() => ''}
            style={{
              axis:  { stroke: '#999', strokeWidth: 1, strokeDasharray: '3 3' },
              ticks: { size: 0 },
              grid:  { stroke: 'none' },
            }}
          />

          {/* Now line */}
          <VictoryAxis
            dependentAxis
            axisValue={now}
            tickFormat={() => ''}
            style={{ axis: { stroke: '#da2a2a', strokeWidth: 1.5, strokeDasharray: '5 4' }, grid: { stroke: 'none' }, ticks: { stroke: 'none', size: 0 }, tickLabels: { fill: 'none', fontSize: 0 } }}
          />

          {/* Meal dose bars */}
          {showDoseMarkers && doseBarData.length > 0 && (
            <VictoryBar
              data={doseBarData}
              barWidth={4}
              style={{ data: { fill: '#f97316', fillOpacity: 0.5 } }}
            />
          )}

          {/* Insulin dose bars */}
          {showDoseMarkers && insulinDoseBarData.length > 0 && (
            <VictoryBar
              data={insulinDoseBarData}
              barWidth={4}
              style={{ data: { fill: '#9c27b0', fillOpacity: 0.5 } }}
            />
          )}

          {/* Insulin effect area (purple, negative) */}
          {showInsulinEffect && (
            <VictoryArea
              data={insulinAreaData}
              interpolation="monotoneX"
              style={{ data: { fill: '#9c27b0', fillOpacity: 0.2, stroke: '#9c27b0', strokeWidth: 2 } }}
            />
          )}

          {/* Meal effect area */}
          {showMealEffect && (
            <VictoryArea
              data={mealAreaData}
              interpolation="monotoneX"
              style={{ data: { fill: '#f97316', fillOpacity: 0.25, stroke: '#f97316', strokeWidth: 2 } }}
            />
          )}

          {/* Cumulative baseline */}
          {showCumulative && (
            <VictoryLine
              data={cumulData}
              interpolation="monotoneX"
              style={{ data: { stroke: '#22c55e', strokeWidth: 2.5 } }}
            />
          )}

          {/* Net effect (dashed blue) */}
          <VictoryLine
            data={netData}
            interpolation="monotoneX"
            style={{ data: { stroke: '#3b82f6', strokeWidth: 1.5, strokeDasharray: '5 3', opacity: 0.7 } }}
          />
        </VictoryChart>
      </View>

      {/* Toggles */}
      <View style={s.toggleRow}>
        {[
          { label: '🍽️ Meal Effect',    value: showMealEffect,     setter: setMeal     },
          { label: '💉 Insulin Effect',   value: showInsulinEffect,  setter: setInsulin  },
          { label: '📈 Cumulative',       value: showCumulative,     setter: setCumul    },
          { label: '📍 Dose Markers',     value: showDoseMarkers,    setter: setMarkers  },
        ].map(({ label, value, setter }) => (
          <View key={label} style={s.toggleItem}>
            <Text style={s.toggleLabel}>{label}</Text>
            <Switch
              value={value}
              onValueChange={setter}
              trackColor={{ false: '#d1d5db', true: '#3b82f620' }}
              thumbColor={value ? '#3b82f6' : '#9ca3af'}
              style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
            />
          </View>
        ))}
      </View>

      {/* Tooltip modal */}
      {tooltip && (
        <Modal transparent animationType="fade" onRequestClose={() => setTooltip(null)}>
          <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={() => setTooltip(null)}>
            <View style={s.tooltipCard}>
              <Text style={s.tooltipTime}>{formatXAxis(tooltip.point.timestamp, 'HH:mm')}</Text>
              <View style={s.tooltipRow}>
                <Text style={s.tooltipKey}>🍽️ Meal effect</Text>
                <Text style={[s.tooltipVal, { color: '#f97316' }]}>+{Math.round(tooltip.point.mealImpact)} mg/dL</Text>
              </View>
              <View style={s.tooltipRow}>
                <Text style={s.tooltipKey}>📈 Cumulative</Text>
                <Text style={[s.tooltipVal, { color: '#22c55e' }]}>
                  {tooltip.point.cumulativeBaseline >= 0 ? '+' : ''}{Math.round(tooltip.point.cumulativeBaseline)} mg/dL
                </Text>
              </View>
              {tooltip.point.meals.length > 0 && (
                <Text style={s.tooltipMeals}>
                  {tooltip.point.meals.map((m: any) => m.mealType ?? 'Meal').join(', ')}
                </Text>
              )}
              <Text style={s.tooltipClose}>Tap to close</Text>
            </View>
          </TouchableOpacity>
        </Modal>
      )}
    </View>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { backgroundColor: '#fff', borderRadius: 12, overflow: 'hidden' },

  summaryBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  summaryItem:    { alignItems: 'center', flex: 1 },
  summaryValue:   { fontSize: 18, fontWeight: '700' },
  summaryLabel:   { fontSize: 9,  color: '#9ca3af', marginTop: 2, textAlign: 'center' },
  summaryDivider: { width: 1, height: 36, backgroundColor: '#e5e7eb' },

  viewModeRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  viewBtn:           { paddingHorizontal: 14, paddingVertical: 5, borderRadius: 20, backgroundColor: '#f5f5f5' },
  viewBtnActive:     { backgroundColor: '#f97316' },
  viewBtnText:       { fontSize: 13, fontWeight: '600', color: '#555' },
  viewBtnTextActive: { color: '#fff' },

  // ── Custom date-range panel ──
  viewBtnCustom:         { borderWidth: 1.5, borderColor: '#f97316', backgroundColor: 'transparent' },
  customRangePanel:      { paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0', backgroundColor: '#fffbf5' },
  customRangeRow:        { flexDirection: 'row' as const, gap: 8, marginBottom: 4 },
  customRangePicker:     { flex: 1 },
  customRangeApplyBtn:   { backgroundColor: '#f97316', borderRadius: 8, paddingVertical: 10, alignItems: 'center' as const },
  customRangeAppliedBtn: { backgroundColor: '#c2410c' },
  customRangeApplyText:  { color: '#fff', fontWeight: '700' as const, fontSize: 14 },

  chartWrap: {},

  toggleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    gap: 4,
  },
  toggleItem:  { flexDirection: 'row', alignItems: 'center', marginRight: 12 },
  toggleLabel: { fontSize: 11, color: '#6b7280', marginRight: 4 },

  empty:        { paddingVertical: 48, alignItems: 'center' },
  emptyIcon:    { fontSize: 40, marginBottom: 12 },
  emptyTitle:   { fontSize: 15, fontWeight: '600', color: '#6b7280' },
  emptySubtitle:{ fontSize: 12, color: '#9ca3af', marginTop: 4 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  tooltipCard:  { backgroundColor: '#fff', borderRadius: 12, padding: 20, minWidth: 200, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 12, elevation: 8 },
  tooltipTime:  { fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 8 },
  tooltipRow:   { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  tooltipKey:   { fontSize: 12, color: '#6b7280' },
  tooltipVal:   { fontSize: 12, fontWeight: '600' },
  tooltipMeals: { fontSize: 11, color: '#9ca3af', marginTop: 6 },
  tooltipClose: { fontSize: 11, color: '#d1d5db', marginTop: 12, textAlign: 'center' },
});

export default DoctorEffectsChart;