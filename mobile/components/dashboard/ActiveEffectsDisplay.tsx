/**
 * ActiveEffectDisplay
 * Location: mobile/components/ActiveEffectDisplay.tsx
 *
 * Displays live frontend-calculated active effects:
 *   – Insulin On Board (IOB) and its BG impact
 *   – Meal On Board (MOB) and its BG impact
 *   – Stable T1D baseline derived from the last reading
 *   – Net effect: estimated BG, projected final BG, trend, safety status
 *
 * All values come exclusively from frontend pharmacodynamic calculations.
 * No backend API comparison is performed.
 */

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { usePatientConstants } from '@/hooks/usePatientConstants';

import apiClient from '@/services/api/client';
import API from '@/services/api/endpoints';

import {
  calculateNetEffect,
  calculateStableBaselineFromReading,
} from '@/utils/glucose/blood-glucose-estimation';
import { sanitizeBaseline } from '@/utils/calculations/baseline';
import { calculateTotalCumulativeEffects } from '@/utils/calculations';
import { calculateStackedMealEffect } from '@/utils/glucose/meal-pharmacodynamics';
import {
  calculateStackedInsulinEffect,
  type InsulinDoseForStacking,
} from '@/utils/insulin/pharmacodynamics';
import { MEAL_ABSORPTION_PROFILES, getCircadianBaseline } from '@/constants/shared-constants';

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation helpers
// ─────────────────────────────────────────────────────────────────────────────

function safeArray<T>(value: unknown, ...fallbackKeys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value !== null && typeof value === 'object') {
    for (const key of fallbackKeys) {
      const candidate = (value as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate as T[];
    }
  }
  return [];
}

/**
 * Parse a timestamp string to UTC milliseconds, treating bare ISO strings
 * (no 'Z' or offset) as UTC to match backend behaviour.
 */
function parseUTCMs(ts: string | null | undefined): number {
  if (!ts) return NaN;
  const hasZone = ts.endsWith('Z') || ts.includes('+') || /T.*-\d{2}:\d{2}$/.test(ts);
  return hasZone
    ? new Date(ts).getTime()
    : new Date(ts.replace(' ', 'T') + 'Z').getTime();
}

function normaliseMeal(raw: any): any {
  return {
    ...raw,
    id: raw.id ?? String(raw._id ?? ''),
    calculation_summary: raw.calculation_summary ?? {},
    nutrition: raw.nutrition ?? {},
  };
}

function normaliseDose(raw: any): any {
  const amount = raw?.dose ?? raw?.units ?? raw?.doseAmount ?? raw?.amount ?? raw?.doseUnits ?? 0;
  const takenAt = raw?.taken_at ?? raw?.administrationTime ?? raw?.takenAt ?? raw?.timestamp ?? null;
  const medication = raw?.medication ?? raw?.insulinType ?? raw?.insulin_type ?? raw?.type ?? 'regular_insulin';
  return { ...raw, dose: amount, taken_at: takenAt, medication };
}

function rawDoseToStacking(dose: any, currentTime: Date): InsulinDoseForStacking | null {
  const units: number = dose?.units ?? dose?.dose ?? 0;
  const takenAt: string | null = dose?.administrationTime ?? dose?.taken_at ?? null;
  if (!takenAt || units <= 0) return null;

  const doseMs = parseUTCMs(takenAt);
  if (isNaN(doseMs)) return null;

  const hoursSinceDose = (currentTime.getTime() - doseMs) / (1000 * 60 * 60);
  if (hoursSinceDose < 0) return null;

  return { dose: units, hoursSinceDose, insulinType: dose?.insulinType ?? dose?.medication ?? 'regular_insulin' };
}

function getLastResetTimeMs(currentTime: Date, resetHour: number, tzOffsetMinutes: number): number {
  const offsetMs = tzOffsetMinutes * 60 * 1000;
  const localMs = currentTime.getTime() + offsetMs;
  const resetLocal = new Date(localMs);
  resetLocal.setUTCHours(resetHour, 0, 0, 0);
  if (localMs < resetLocal.getTime()) resetLocal.setUTCDate(resetLocal.getUTCDate() - 1);
  return resetLocal.getTime() - offsetMs;
}

function getNextResetTimeMs(currentTime: Date, resetHour: number, tzOffsetMinutes: number): number {
  return getLastResetTimeMs(currentTime, resetHour, tzOffsetMinutes) + 24 * 60 * 60 * 1000;
}

/** Format a millisecond countdown as "Xh Ym" or "Xm" */
function formatCountdown(msUntil: number): string {
  if (msUntil <= 0) return '0m';
  const totalMin = Math.ceil(msUntil / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

/** Format elapsed ms as "Xm ago", "Xh Ym ago", or "just now" */
function formatRelativeTime(msSince: number): string {
  if (msSince < 60_000) return 'just now';
  const totalMin = Math.floor(msSince / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m ago`;
  if (h > 0) return `${h}h ago`;
  return `${m}m ago`;
}

function getMealDurationHours(meal: any): number {
  const absType =
    meal?.calculation_summary?.absorption_type ||
    meal?.nutrition?.absorption_type ||
    meal?.nutrition?.absorptionType ||
    'medium';
  return (MEAL_ABSORPTION_PROFILES as any)?.[absType]?.duration_hours ?? 4.0;
}

function getDoseDurationHours(dose: any, constants: any): number {
  return constants?.medication_factors?.[dose?.medication]?.duration_hours ?? 4.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ActiveEffectData {
  iob: {
    totalActiveInsulin: number;
    activeDoses: number;
    currentBGReduction: number;
    pendingBGReduction: number;
  };
  mob: {
    totalActiveCarbs: number;
    activeMealCount: number;
    currentBGElevation: number;
    pendingBGRise: number;
  };
  netEffect: {
    estimatedBG: number;
    projectedFinalBG: number;       // PK projection: stableBaseline + cumulativeNet + pendingNet
    simpleProjectedFinalBG: number; // Naive projection: estimatedBG + pendingNet (no baseline math)
    pendingNetEffect: number;
    cumulativeBaseline: number;
    cumulativeMealEffect: number;
    cumulativeInsulinEffect: number;
    safetyStatus: string;
    trend: string;
  };
  baseline?: {
    value: number;
    readingValue: number;
    readingTimestamp: string | null;  // ISO string of the reading that anchors the baseline
    cumulativeMealEffect: number;
    cumulativeInsulinEffect: number;
    cumulativeNetEffect: number;
    mealsCount: number;
    insulinCount: number;
    // ── new ──
    isPreset?: boolean;
    readingDelta?: number | null;    // reading − circadian(now) — kept for compat; not displayed
    hourFloat?: number;              // current-time hour used for circadian lookup
    // ── preset reading-time anchors ──
    circadianAtReading?: number | null;   // circadian profile value at the reading's local hour
    cumulAtReadingNet?: number | null;    // PK net cumulative effect calculated AT reading time
    // ── baseline sanitization ──
    clampStatus?: 'ok' | 'hard_clamped';
    clampWarnings?: string[];
    rawBaselineValue?: number;       // value before clamping (only differs when hard_clamped)
  };
  metadata: {
    calculatedAt: string;
    mealsCount: number;
    dosesCount: number;
    hasRecentReading: boolean;
    nextResetMs: number;          // UTC ms of the next daily reset
    absorbedOnlyDoses: number;    // doses fully absorbed but still in Phase 3 persist window
    absorbedOnlyMeals: number;    // meals fully absorbed but still in Phase 3 persist window
    projectedClearMs: number;     // UTC ms when all active IOB + MOB will be fully cleared
    futureMealsCount: number;     // meals scheduled but not yet started
    futureDosesCount: number;     // doses logged but administrationTime is still in the future
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────────────────────────

export default function ActiveEffectDisplay() {
  const [data, setData] = useState<ActiveEffectData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [netExpanded, setNetExpanded] = useState(false);
  const { constants, isLoading: constantsLoading } = usePatientConstants();

  const fetchAndCalculate = async () => {
    try {
      setError(null);
      const currentTime = new Date();

      // ── 1. Fetch meals, doses, and readings ───────────────────────────────
      // ALL three fetches are time-limited to the last 24 h.
      //
      // Without limits, meals-only returns ALL 46+ meals (~41 KB) and
      // blood-sugar returns ALL 2500+ CGM readings (~490 KB) on every 60-second
      // poll.  With 4+ components polling simultaneously, all 6-8 requests hit
      // the single Render gunicorn worker at once, queue up, and timeout —
      // starving even the /api/health keep-alive endpoint.
      //
      // 24 h covers the full daily reset window (reset hour = 7 AM local) plus
      // any long-acting insulin doses still active from yesterday, so no
      // calculations are affected.
      const windowEnd   = currentTime.toISOString();
      const windowStart = new Date(currentTime.getTime() - 24 * 60 * 60 * 1000).toISOString();

      const [mealsRes, insulinRes, readingsRes] = await Promise.all([
        apiClient.get(API.MEALS.MEALS_ONLY, {
          params: { start: windowStart, end: windowEnd },
        }),
        apiClient.get(API.INSULIN.DATA, {
          params: { start: windowStart, end: windowEnd },
        }),
        apiClient.get(API.BLOOD_SUGAR.LIST, {
          params: { start_time: windowStart, end_time: windowEnd, filter_by: 'reading_time' },
        }).catch(() => null),
      ]);

      // ── 2. Extract and normalise ──────────────────────────────────────────
      const rawMeals: any[] = safeArray(mealsRes?.data, 'meals', 'data');
      const rawDoses: any[] = safeArray(insulinRes?.data, 'insulin_logs', 'insulinDoses', 'doses', 'data');

      const allMeals = rawMeals.map(normaliseMeal);
      const allRawDoses = rawDoses.map(normaliseDose);

      const allDosesForCalc = allRawDoses.map((d: any) => ({
        ...d,
        id: String(d._id ?? d.id ?? ''),
        units: d.dose ?? d.units ?? 0,
        administrationTime: d.taken_at ?? d.administrationTime ?? d.takenAt ?? null,
        insulinType: d.medication ?? d.insulinType ?? d.insulin_type ?? 'regular_insulin',
      }));

      // ── 3. Reset window ───────────────────────────────────────────────────
      const resetHour: number = constants?.daily_reset_hour ?? 7;
      const tzOffset: number = (constants as any)?.timezone_offset_minutes ?? 0;
      const lastResetMs = getLastResetTimeMs(currentTime, resetHour, tzOffset);

      // ── 3b. Baseline mode ──────────────────────────────────────────────────
      const resolvedMode: 'dynamic' | 'preset' =
        ((constants as any)?.baseline_mode === 'preset') ? 'preset' : 'dynamic';

      // ── 4. Filter to active window ────────────────────────────────────────
      const activeMeals = allMeals.filter((meal: any) => {
        const mealMs = parseUTCMs(meal?.timestamp);
        if (isNaN(mealMs) || mealMs <= lastResetMs) return false;
        const hoursSince = (currentTime.getTime() - mealMs) / (1000 * 60 * 60);
        if (hoursSince < 0) return false;
        return hoursSince < getMealDurationHours(meal);
      });

      // All meals after reset (including fully-absorbed AND future) for correct cumulative baseline
      const allMealsInWindow = allMeals.filter((meal: any) => {
        const mealMs = parseUTCMs(meal?.timestamp);
        return !isNaN(mealMs) && mealMs > lastResetMs; // ✅ includes future meals
      });

      const activeDosesRaw = allDosesForCalc.filter((dose: any) => {
        const doseMs = parseUTCMs(dose?.administrationTime);
        if (isNaN(doseMs) || doseMs <= lastResetMs) return false;
        const hoursSince = (currentTime.getTime() - doseMs) / (1000 * 60 * 60);
        if (hoursSince < 0) return false;
        return hoursSince < getDoseDurationHours(dose, constants);
      });

      const allDosesInWindow = allDosesForCalc.filter((d: any) => {
        const doseMs = parseUTCMs(d.administrationTime);
        return !isNaN(doseMs) && doseMs > lastResetMs;
      });

      // ── 4b. Doses/meals that are fully absorbed but still in Phase 3 persist ─
      const nextResetMs = getNextResetTimeMs(currentTime, resetHour, tzOffset);
      const absorbedOnlyDoses = allDosesInWindow.filter((d: any) => {
        const doseMs = parseUTCMs(d.administrationTime);
        const hoursSince = (currentTime.getTime() - doseMs) / (1000 * 60 * 60);
        return hoursSince >= getDoseDurationHours(d, constants);
      }).length;
      const absorbedOnlyMeals = allMealsInWindow.filter((meal: any) => {
        const mealMs = parseUTCMs(meal?.timestamp);
        const hoursSince = (currentTime.getTime() - mealMs) / (1000 * 60 * 60);
        return hoursSince >= getMealDurationHours(meal);
      }).length;

      // Meals whose timestamp is still in the future (pre-meal insulin snap pattern)
      const futureMealsCount = allMealsInWindow.filter((meal: any) => {
        const mealMs = parseUTCMs(meal?.timestamp);
        return (currentTime.getTime() - mealMs) / (1000 * 60 * 60) < 0;
      }).length;

      // Doses whose administrationTime is still in the future (pre-bolus pattern)
      const futureDosesCount = allDosesInWindow.filter((d: any) => {
        const doseMs = parseUTCMs(d.administrationTime);
        return (currentTime.getTime() - doseMs) / (1000 * 60 * 60) < 0;
      }).length;

      // ── 4c. Projected clear time — when the last active dose/meal finishes ──
      const doseEndTimes = activeDosesRaw.map((d: any) => {
        const doseMs = parseUTCMs(d.administrationTime);
        return isNaN(doseMs) ? 0 : doseMs + getDoseDurationHours(d, constants) * 3_600_000;
      });
      const mealEndTimes = allMealsInWindow.map((meal: any) => {
        const mealMs = parseUTCMs(meal?.timestamp);
        return isNaN(mealMs) ? 0 : mealMs + getMealDurationHours(meal) * 3_600_000;
      });
      const projectedClearMs = Math.max(0, ...doseEndTimes, ...mealEndTimes);

      // ── 5. Map doses → stacking shape ─────────────────────────────────────
      const dosesForStacking: InsulinDoseForStacking[] = activeDosesRaw
        .map((d) => rawDoseToStacking(d, currentTime))
        .filter((d): d is InsulinDoseForStacking => d !== null);

      // ── 6. Frontend IOB / MOB ─────────────────────────────────────────────
      const correctionFactor = constants?.correction_factor ?? 40;
      const carbToBgRatio = (constants as any)?.carb_to_bg_ratio ?? (constants as any)?.carb_to_bg_factor ?? 4.0;

      // ✅ Use allMealsInWindow so future meals contribute to pendingBgRise / totalPendingRise.
      // calculateStackedMealEffect's internal isActive check gates currentBGElevation to
      // meals that are actively digesting; future meals only add to totalPendingRise / totalMOB.
      const frontendMOB = calculateStackedMealEffect(allMealsInWindow, currentTime, constants);
      const frontendIOB = calculateStackedInsulinEffect(dosesForStacking, correctionFactor);

      // Current BG reduction from ACTIVE doses only (absorbed fraction of still-absorbing doses).
      // Each contribution has: dose (total units), iob (remaining units).
      // Absorbed units = dose − iob  →  BG reduction = absorbedUnits × CF
      // This is intentionally 0 when no doses are currently active.
      const activeAbsorbedIOBReduction = (frontendIOB?.contributions ?? []).reduce(
        (sum: number, c: any) => sum + Math.max(0, ((c.dose ?? 0) - (c.iob ?? 0))) * correctionFactor,
        0
      );

      // Current BG elevation from ACTIVE meals only (absorbed fraction of still-digesting meals).
      // frontendMOB.totalBGElevation is already computed on activeMeals only — this is correct.
      // It is 0 when no meals are currently digesting.

      // ── 7. Most recent glucose reading ────────────────────────────────────
      const readingRaw = readingsRes?.data;
      const readingArray: any[] = Array.isArray(readingRaw)
        ? readingRaw
        : readingRaw?.readings ?? readingRaw?.data ?? [];

      // ✅ FIX: Only use readings from the CURRENT DAILY PERIOD (after lastResetMs).
      //
      // ROOT CAUSE of the 14.4 mg/dL baseline bug:
      //   Picking the most recent reading regardless of when it was taken means a
      //   pre-reset reading (e.g. 450 mg/dL from 14h ago) gets used as the anchor.
      //   calculateStableBaselineFromReading then computes:
      //     baseline = 450 − cumulative_effects_at_reading_time
      //   Those effects include meals eaten AFTER the reading (still in allMeals),
      //   producing an absurd result like 450 − 435.6 = 14.4 mg/dL.
      //
      // The backend (cumulative_effects_routes.py) only queries blood sugar readings
      // WHERE bloodSugarTimestamp >= reset_time. We mirror that exactly:
      //   - readings in current period → use the most recent one as anchor
      //   - no readings today → null → stableBaseline falls back to target_glucose
      const readingsInCurrentPeriod = readingArray.filter((r: any) => {
        const ts = parseUTCMs(r?.bloodSugarTimestamp ?? r?.timestamp);
        return !isNaN(ts) && ts >= lastResetMs;
      });

      const recentReading = readingsInCurrentPeriod.length > 0
        ? [...readingsInCurrentPeriod].sort((a: any, b: any) =>
            parseUTCMs(b.bloodSugarTimestamp ?? b.timestamp) -
            parseUTCMs(a.bloodSugarTimestamp ?? a.timestamp)
          )[0]
        : null;  // No reading in current period → target_glucose fallback

      // ── 8. Stable baseline ────────────────────────────────────────────────────
      const targetGlucose = constants?.target_glucose ?? 100;
      let frontendBaseline: any = null;

      if (resolvedMode === 'preset') {
        // Preset mode: use the circadian profile value at the current local hour.
        // Does NOT require a recent reading — works from day one.
        const offsetMs = tzOffset * 60_000;
        const localDate = new Date(currentTime.getTime() + offsetMs);
        const hourFloat = localDate.getUTCHours() + localDate.getUTCMinutes() / 60;

        const circadianProfile = (constants as any)?.circadian_profile;
        const presetValue = getCircadianBaseline(hourFloat, circadianProfile ?? undefined);

        // reading − circadian(now): kept for backwards compat; Card 1 now uses reading-time anchor instead
        const readingDelta = recentReading?.bloodSugar != null
          ? recentReading.bloodSugar - presetValue
          : null;

        // ── Reading-time anchor (Card 1) ──────────────────────────────────────
        // Circadian baseline at the reading's local hour (may differ from current hour).
        let circadianAtReading: number | null = null;
        let cumulAtReadingNet: number | null = null;
        if (recentReading?.bloodSugar) {
          const readingTs = recentReading.bloodSugarTimestamp ?? recentReading.timestamp;
          const readingMs = parseUTCMs(readingTs);
          if (!isNaN(readingMs)) {
            const localReadingDate = new Date(readingMs + offsetMs);
            const readingHourFloat =
              localReadingDate.getUTCHours() + localReadingDate.getUTCMinutes() / 60;
            circadianAtReading = getCircadianBaseline(readingHourFloat, circadianProfile ?? undefined);

            // PK cumulative net effect calculated AT reading time, not at currentTime.
            // This lets Card 1 show whether the model explains the observed reading delta.
            const cumulAtReading = calculateTotalCumulativeEffects(
              allMealsInWindow,
              allDosesInWindow,
              new Date(readingMs),
              constants,
              MEAL_ABSORPTION_PROFILES,
              resetHour,
              tzOffset,
            );
            cumulAtReadingNet = cumulAtReading.cumulativeNetBaseline;
          }
        }

        frontendBaseline = {
          stableBaseline:           presetValue,
          readingValue:             recentReading?.bloodSugar ?? presetValue,
          cumulativeMealEffect:     0,   // not back-calculated in preset mode
          cumulativeInsulinEffect:  0,
          cumulativeNetEffect:      readingDelta ?? 0,
          mealsCount:               allMealsInWindow.length,
          insulinCount:             allDosesInWindow.length,
          // extra fields for display
          _isPreset:                true,
          _hourFloat:               hourFloat,
          _readingDelta:            readingDelta,
          // reading-time anchors for Card 1
          _circadianAtReading:      circadianAtReading,
          _cumulAtReadingNet:       cumulAtReadingNet,
        };
      } else {
        // Dynamic mode: back-calculate baseline from the last reading (original logic).
        if (recentReading?.bloodSugar) {
          frontendBaseline = calculateStableBaselineFromReading(
            {
              id: String(recentReading._id ?? recentReading.id ?? ''),
              value: recentReading.bloodSugar,
              timestamp: recentReading.bloodSugarTimestamp ?? recentReading.timestamp,
              userId: 'current',
              status: recentReading.status,
              source: 'manual',
            },
            // ✅ FIX Bug 2: use allMealsInWindow (meals since daily reset) instead of
            // allMeals (full 24h API window).  Pre-reset meals inflate the cumulative
            // effect at reading time → back-calculated baseline = 144 − 814 = −670
            // → hard-clamped to 55, which is wrong.  allMealsInWindow excludes them.
            allMealsInWindow,
            allDosesInWindow,
            currentTime,
            constants,
            MEAL_ABSORPTION_PROFILES,
            resetHour,
            tzOffset,
          );

          // ── Hard-clamp baseline to physiological limits ────────────────────
          if (frontendBaseline) {
            const sanitized = sanitizeBaseline(frontendBaseline.stableBaseline);
            if (sanitized.status !== 'ok') {
              frontendBaseline = {
                ...frontendBaseline,
                stableBaseline: sanitized.value,
                warnings: [...(frontendBaseline.warnings ?? []), ...sanitized.warnings],
              };
            }
            // Attach clamp metadata for the warning banner
            (frontendBaseline as any)._clampStatus = sanitized.status;
            (frontendBaseline as any)._clampWarnings = sanitized.warnings;
            (frontendBaseline as any)._rawBaselineValue = sanitized.rawValue;
          }
        }
      }

      // ── 9. Net effect (for safetyStatus / trend) ──────────────────────────
      const frontendNetEffect = calculateNetEffect(
        frontendBaseline,
        activeMeals,
        allDosesInWindow,
        currentTime,
        constants,
        MEAL_ABSORPTION_PROFILES,
      );

      // ── 10. Corrected cumulative & estimated BG ───────────────────────────
      const correctedCumulative = calculateTotalCumulativeEffects(
        allMealsInWindow,
        allDosesInWindow,
        currentTime,
        constants,
        MEAL_ABSORPTION_PROFILES,
        resetHour,
        tzOffset,
      );

      const stableBaseline = frontendBaseline?.stableBaseline ?? targetGlucose;
      const correctedEstimatedBG_raw = stableBaseline + correctedCumulative.cumulativeNetBaseline;

      // ── Reading-residual correction (preset mode only) ──────────────────────
      // In preset mode the PK model can be far off at the reading time — e.g. the
      // model predicts +807 mg/dL but the observed delta is only +56 mg/dL (gap of
      // 751).  Without anchoring to the actual reading, Card 2 just continues with
      // +818 and shows 910 mg/dL.
      //
      // Fix: compute how wrong the model was at the reading moment, then shift the
      // current estimate by that same residual.
      //   readingResidual = actual_reading − (circadian_at_reading + pk_net_at_reading)
      //   e.g. 144 − (88 + 807) = −751
      //   corrected = 910 + (−751) = 159 mg/dL
      //
      // This makes the "→ PK adj." arrow between Card 1 and Card 2 a genuine
      // model-vs-reality correction rather than a cosmetic label.
      let correctedEstimatedBG = correctedEstimatedBG_raw;
      let readingResidual: number | null = null;

      if (
        resolvedMode === 'preset' &&
        recentReading?.bloodSugar != null &&
        frontendBaseline?._circadianAtReading != null &&
        frontendBaseline?._cumulAtReadingNet != null
      ) {
        readingResidual =
          recentReading.bloodSugar
          - frontendBaseline._circadianAtReading
          - frontendBaseline._cumulAtReadingNet;
        correctedEstimatedBG = correctedEstimatedBG_raw + readingResidual;
      }

      // ✅ totalPendingRise is already in mg/dL and includes future-meal contributions.
      // The old formula (totalMOB × carbToBgRatio) used activeMeals only — now redundant.
      const frontendPendingMOBRise   = frontendMOB?.totalPendingRise ?? 0;
      const frontendPendingIOBRedux  = (frontendIOB?.totalIOB ?? 0) * correctionFactor;
      const frontendPendingNetEffect = frontendPendingMOBRise - frontendPendingIOBRedux;
      const frontendProjectedFinalBG = correctedEstimatedBG + frontendPendingNetEffect;

      // Naive/simple projection: estimatedBG + pending net, no stable-baseline re-anchor.
      // Useful as a quick sanity-check displayed alongside the full PK projection.
      const simpleProjectedFinalBG = correctedEstimatedBG + frontendPendingNetEffect;

      // ── 11. Assemble ──────────────────────────────────────────────────────
      setData({
        iob: {
          totalActiveInsulin: frontendIOB?.totalIOB ?? 0,
          activeDoses: dosesForStacking.length,
          // Active doses only: absorbed fraction × CF for each still-absorbing dose.
          // This is 0 when no doses are currently in their absorption window.
          // Fully-absorbed doses contribute to the net effect (cumulative BG) only.
          currentBGReduction: activeAbsorbedIOBReduction,
          pendingBGReduction: frontendPendingIOBRedux,
        },
        mob: {
          totalActiveCarbs: frontendMOB?.totalMOB ?? 0,        // ✅ includes future-meal carbs
          activeMealCount: activeMeals.length,                  // ✅ only currently-absorbing meals
          // Active meals only: absorbed carb fraction × carbToBgFactor for still-digesting meals.
          // This is 0 when no meals are currently in their absorption window.
          // Fully-digested meals contribute to the net effect (cumulative BG) only.
          currentBGElevation: frontendMOB?.totalBGElevation ?? 0,
          pendingBGRise: frontendMOB?.totalPendingRise ?? 0,    // ✅ includes future meals
        },
        netEffect: {
          estimatedBG: correctedEstimatedBG,
          projectedFinalBG: frontendProjectedFinalBG,
          simpleProjectedFinalBG,
          pendingNetEffect: frontendPendingNetEffect,
          cumulativeBaseline: correctedCumulative.cumulativeNetBaseline,
          cumulativeMealEffect: correctedCumulative.cumulativeMealEffect,
          cumulativeInsulinEffect: correctedCumulative.cumulativeInsulinEffect,
          safetyStatus: bgToSafetyStatus(correctedEstimatedBG),
          trend: frontendNetEffect?.trend ?? 'stable',
        },
        baseline: frontendBaseline ? {
          value: frontendBaseline.stableBaseline,
          readingValue: frontendBaseline.readingValue,
          readingTimestamp: recentReading?.bloodSugarTimestamp ?? recentReading?.timestamp ?? null,
          cumulativeMealEffect: frontendBaseline.cumulativeMealEffect,
          cumulativeInsulinEffect: frontendBaseline.cumulativeInsulinEffect,
          cumulativeNetEffect: frontendBaseline.cumulativeNetEffect,
          mealsCount: frontendBaseline.mealsCount,
          insulinCount: frontendBaseline.insulinCount,
          // ── new ──
          isPreset: frontendBaseline._isPreset ?? false,
          readingDelta: frontendBaseline._readingDelta ?? null,
          hourFloat: frontendBaseline._hourFloat ?? null,
          circadianAtReading: frontendBaseline._circadianAtReading ?? null,
          cumulAtReadingNet: frontendBaseline._cumulAtReadingNet ?? null,
          // ── baseline sanitization ──
          clampStatus: (frontendBaseline as any)._clampStatus ?? 'ok',
          clampWarnings: (frontendBaseline as any)._clampWarnings ?? [],
          rawBaselineValue: (frontendBaseline as any)._rawBaselineValue ?? frontendBaseline.stableBaseline,
        } : undefined,
        metadata: {
          calculatedAt: currentTime.toISOString(),
          mealsCount: allMeals.length,
          dosesCount: allRawDoses.length,
          hasRecentReading: readingsInCurrentPeriod.length > 0 && !!(recentReading?.bloodSugar),
          nextResetMs,
          absorbedOnlyDoses,
          absorbedOnlyMeals,
          projectedClearMs,
          futureMealsCount,
          futureDosesCount,
        },
      });
    } catch (err) {
      console.error('[ActiveEffectDisplay] Error:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    // Wait for server constants to resolve — do NOT start with DEFAULT_PATIENT_CONSTANTS.
    // Firing before constants are ready causes a first render with CF=40/carb=4,
    // then a second render with the real CF=70/carb=10, producing the
    // "normal then extreme" flicker.
    if (constantsLoading || !constants) return;

    // Initial fetch
    fetchAndCalculate();

    // Schedule the first tick at the next minute boundary (:00 seconds),
    // then keep a 60-second interval from there — matching chart refresh cadence.
    const msUntilNextMinute = 60_000 - (Date.now() % 60_000);
    let intervalId: ReturnType<typeof setInterval>;

    const timeoutId = setTimeout(() => {
      fetchAndCalculate();
      intervalId = setInterval(fetchAndCalculate, 60_000);
    }, msUntilNextMinute);

    return () => {
      clearTimeout(timeoutId);
      clearInterval(intervalId);
    };
  }, [constants, constantsLoading]);

  const onRefresh = () => { setRefreshing(true); fetchAndCalculate(); };

  // ── Loading ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Calculating active effects…</Text>
      </View>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Error: {error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={fetchAndCalculate}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!data) return null;

  const bgHighlight = getHighlight(data.netEffect.estimatedBG);

  /**
   * Unreliable estimate guard.
   *
   * An estimatedBG below 10 mg/dL is physiologically impossible and signals
   * a data integrity problem — typically an unlogged meal, an unlogged insulin
   * dose, or a correction-factor constant that is far too high.
   *
   * When this flag is true the three BG cards are hidden and replaced by an
   * actionable alert that instructs the patient to verify today's logs.
   */
  const ESTIMATE_UNRELIABLE_THRESHOLD = 10; // mg/dL
  const estimateIsUnreliable = data.netEffect.estimatedBG < ESTIMATE_UNRELIABLE_THRESHOLD;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>⚡ Active Effects</Text>
        <Text style={styles.subtitle}>Live pharmacodynamic summary</Text>
        {/* Baseline mode badge */}
        <View style={styles.modeBadgeRow}>
          <View style={[
            styles.modeBadge,
            data.baseline?.isPreset ? styles.modeBadgePreset : styles.modeBadgeDynamic,
          ]}>
            <Text style={[
              styles.modeBadgeText,
              data.baseline?.isPreset ? styles.modeBadgeTextPreset : styles.modeBadgeTextDynamic,
            ]}>
              {data.baseline?.isPreset ? '🌙 Circadian baseline' : '📍 Dynamic baseline'}
            </Text>
          </View>
          <Text style={styles.modeBadgeHint}>
            {data.baseline?.isPreset
              ? `Profile value at ${data.baseline?.hourFloat != null ? (data.baseline.hourFloat | 0) + ':' + String(Math.round((data.baseline.hourFloat % 1) * 60)).padStart(2,'0') : '—'}`
              : 'From last reading'}
          </Text>
        </View>
        <Text style={styles.timestamp}>
          Updated: {new Date(data.metadata.calculatedAt).toLocaleTimeString()}
        </Text>
      </View>

      {/* ── Baseline clamp warning banner ─────────────────────────────────── */}
      {data.baseline?.clampStatus === 'hard_clamped' && (
        <View style={styles.clampBanner}>
          <View style={styles.clampBannerRow}>
            <Text style={styles.clampBannerIcon}>⚠️</Text>
            <View style={styles.clampBannerTextCol}>
              <Text style={styles.clampBannerTitle}>Baseline Capped</Text>
              <Text style={styles.clampBannerBody}>
                Raw baseline was{' '}
                <Text style={styles.clampBannerHighlight}>
                  {data.baseline.rawBaselineValue?.toFixed(0)} mg/dL
                </Text>
                {' '}— outside the physiological range.{' '}
                Capped at{' '}
                <Text style={styles.clampBannerHighlight}>
                  {data.baseline.value.toFixed(0)} mg/dL
                </Text>
                .
              </Text>
              <Text style={styles.clampBannerReason}>
                {(data.baseline.rawBaselineValue ?? 0) < 55
                  ? '💉 Likely cause: unlogged insulin dose or unexpected physical activity.'
                  : '🍽️ Likely cause: unlogged meal or snack.'}
              </Text>
            </View>
          </View>
        </View>
      )}

      {/* ── Unreliable estimate alert (replaces three BG cards) ──────────────── */}
      {estimateIsUnreliable && (
        <View style={styles.unreliableBanner}>
          <View style={styles.unreliableBannerHeader}>
            <Text style={styles.unreliableBannerIcon}>⚠️</Text>
            <Text style={styles.unreliableBannerTitle}>Estimation Unreliable</Text>
          </View>
          <Text style={styles.unreliableBannerBody}>
            The calculated BG estimate ({data.netEffect.estimatedBG.toFixed(0)} mg/dL) is
            below the physiologically possible range. This almost always means today's
            logs are incomplete or contain an error.
          </Text>
          <Text style={styles.unreliableBannerSubtitle}>
            Check that all of today's entries are logged correctly:
          </Text>
          <View style={styles.unreliableChecklist}>

            {/* ── Meals ── */}
            <View style={styles.unreliableCheckRow}>
              <Text style={styles.unreliableCheckIcon}>🍽️</Text>
              <View style={styles.unreliableCheckText}>
                <Text style={styles.unreliableCheckLabel}>Meals logged today</Text>
                <Text style={styles.unreliableCheckHint}>
                  {data.metadata.mealsCount > 0
                    ? `${data.metadata.mealsCount} meal${data.metadata.mealsCount !== 1 ? 's' : ''} found — verify portion sizes, carb counts, and timestamps`
                    : 'No meals logged — log any meals or snacks eaten since your daily reset'}
                </Text>
              </View>
              <Text style={[
                styles.unreliableCheckStatus,
                data.metadata.mealsCount > 0 ? styles.unreliableCheckOk : styles.unreliableCheckWarn,
              ]}>
                {data.metadata.mealsCount > 0 ? `${data.metadata.mealsCount} ✓` : '0 ✗'}
              </Text>
            </View>

            <View style={styles.unreliableCheckDivider} />

            {/* ── Insulin doses ── */}
            <View style={styles.unreliableCheckRow}>
              <Text style={styles.unreliableCheckIcon}>💉</Text>
              <View style={styles.unreliableCheckText}>
                <Text style={styles.unreliableCheckLabel}>Insulin doses logged today</Text>
                <Text style={styles.unreliableCheckHint}>
                  {data.metadata.dosesCount > 0
                    ? `${data.metadata.dosesCount} dose${data.metadata.dosesCount !== 1 ? 's' : ''} found — verify units and times, especially basal or correction doses`
                    : 'No doses logged — if you took insulin today, log each dose with the correct time and units'}
                </Text>
              </View>
              <Text style={[
                styles.unreliableCheckStatus,
                data.metadata.dosesCount > 0 ? styles.unreliableCheckOk : styles.unreliableCheckWarn,
              ]}>
                {data.metadata.dosesCount > 0 ? `${data.metadata.dosesCount} ✓` : '0 ✗'}
              </Text>
            </View>

            <View style={styles.unreliableCheckDivider} />

            {/* ── BG reading ── */}
            <View style={styles.unreliableCheckRow}>
              <Text style={styles.unreliableCheckIcon}>🩸</Text>
              <View style={styles.unreliableCheckText}>
                <Text style={styles.unreliableCheckLabel}>Blood glucose reading today</Text>
                <Text style={styles.unreliableCheckHint}>
                  {data.metadata.hasRecentReading
                    ? 'Reading found — confirm the value and time are correct'
                    : 'No reading from today — log a manual reading or sync your CGM to anchor the estimate'}
                </Text>
              </View>
              <Text style={[
                styles.unreliableCheckStatus,
                data.metadata.hasRecentReading ? styles.unreliableCheckOk : styles.unreliableCheckWarn,
              ]}>
                {data.metadata.hasRecentReading ? '✓' : '✗'}
              </Text>
            </View>

          </View>

          <Text style={styles.unreliableBannerFooter}>
            Once your logs are corrected, pull down to refresh — the estimate will
            recalculate automatically.
          </Text>
        </View>
      )}

      {/* ── Three-card row: Last Reading → Estimated Now → Projected ─── */}
      {!estimateIsUnreliable && <View style={styles.bgTriRow}>

        {/* CARD 1 — Last measured reading */}
        <View style={[styles.bgTriCard, styles.bgTriCardLeft]}>
          <Text style={styles.bgCardEyebrow}>LAST READING</Text>
          {data.baseline ? (
            <>
              <Text style={[styles.bgTriValue, styles[getHighlight(data.baseline.readingValue)]]}>
                {data.baseline.readingValue.toFixed(0)}
              </Text>
              <Text style={styles.bgCardUnit}>mg/dL</Text>

              {/* Timestamp line */}
              {data.baseline.readingTimestamp ? (
                <Text style={styles.bgReadingAge}>
                  {new Date(parseUTCMs(data.baseline.readingTimestamp)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {'  ·  '}
                  {formatRelativeTime(Date.now() - parseUTCMs(data.baseline.readingTimestamp))}
                </Text>
              ) : data.baseline.isPreset ? (
                <Text style={styles.bgReadingAge}>No reading today — using circadian</Text>
              ) : null}

              <Text style={styles.bgAnchorMeta}>
                {data.baseline.mealsCount}🍽️ · {data.baseline.insulinCount}💉 since reset
              </Text>

              {data.baseline.isPreset ? (
                /* ── PRESET: reading − circadian_at_reading = Δ_observed ─────────
                 *
                 * Card 1 is anchored to the READING MOMENT, not to current time.
                 *
                 * Formula:
                 *   reading − circadian_at_reading_time = Δ_observed
                 *
                 * Then, as informational context only (not an input to estimatedBG),
                 * we show the PK-calculated cumulative net effect at that same moment
                 * so the user can see whether the model explains the divergence:
                 *   • Δ_observed ≈ PK_at_reading → model is consistent with reality
                 *   • Δ_observed >> PK_at_reading → unlogged meal / faster absorption
                 *   • Δ_observed << PK_at_reading → unlogged insulin / more activity
                 *
                 * Cards 2 and 3 then use circadian(NOW) + PK_Δ(now/projected),
                 * making the three-card chain genuinely distinct:
                 *   Card 1 → what happened at the reading moment
                 *   Card 2 → what the model says right now
                 *   Card 3 → where things are headed
                 */
                data.baseline.circadianAtReading != null && data.baseline.readingTimestamp ? (
                  <>
                    {/* Primary: reading − circadian_at_reading = Δ_observed */}
                    <View style={styles.bgFormulaStrip}>
                      <Text style={styles.bgFormulaText}>
                        {data.baseline.readingValue.toFixed(0)}
                      </Text>
                      <Text style={styles.bgFormulaMuted}> − </Text>
                      <Text style={[styles.bgFormulaText, styles.good]}>
                        {data.baseline.circadianAtReading.toFixed(0)}
                      </Text>
                      <Text style={styles.bgFormulaMuted}> = </Text>
                      <Text style={[
                        styles.bgFormulaResult,
                        (data.baseline.readingValue - data.baseline.circadianAtReading) >= 0
                          ? styles.warning : styles.good,
                      ]}>
                        {(data.baseline.readingValue - data.baseline.circadianAtReading) >= 0 ? '+' : ''}
                        {(data.baseline.readingValue - data.baseline.circadianAtReading).toFixed(0)}
                      </Text>
                    </View>
                    <Text style={styles.bgFormulaLabel}>reading − circadian = Δ observed</Text>

                    {/* Informational: PK model's predicted effect at reading time */}
                    {data.baseline.cumulAtReadingNet != null && (
                      <Text style={[styles.bgAnchorMeta, { marginTop: 3 }]}>
                        PK model at reading:{' '}
                        <Text style={{ fontWeight: '700' }}>
                          {data.baseline.cumulAtReadingNet >= 0 ? '+' : ''}
                          {data.baseline.cumulAtReadingNet.toFixed(0)} mg/dL
                        </Text>
                        {' '}(
                        {Math.abs((data.baseline.readingValue - data.baseline.circadianAtReading) - data.baseline.cumulAtReadingNet) <= 10
                          ? '✓ consistent'
                          : (data.baseline.readingValue - data.baseline.circadianAtReading) > data.baseline.cumulAtReadingNet
                            ? '↑ reading > model'
                            : '↓ reading < model'
                        })
                      </Text>
                    )}
                  </>
                ) : (
                  /* No reading today — show circadian(now) + PK_Δ(now) as fallback */
                  <>
                    <View style={styles.bgFormulaStrip}>
                      <Text style={styles.bgFormulaText}>
                        {data.baseline.value.toFixed(0)}
                      </Text>
                      <Text style={styles.bgFormulaMuted}> + </Text>
                      <Text style={[
                        styles.bgFormulaText,
                        data.netEffect.cumulativeBaseline >= 0 ? styles.warning : styles.good,
                      ]}>
                        ({data.netEffect.cumulativeBaseline >= 0 ? '+' : ''}{data.netEffect.cumulativeBaseline.toFixed(0)})
                      </Text>
                      <Text style={styles.bgFormulaMuted}> = </Text>
                      <Text style={styles.bgFormulaResult}>
                        {data.netEffect.estimatedBG.toFixed(0)}
                      </Text>
                    </View>
                    <Text style={styles.bgFormulaLabel}>circadian + PK Δ = est. BG</Text>
                    <Text style={[styles.bgAnchorMeta, { marginTop: 2 }]}>No reading today</Text>
                  </>
                )
              ) : (
                /* ── DYNAMIC: show reading − effects = baseline (existing) ── */
                <>
                  <View style={styles.bgFormulaStrip}>
                    <Text style={styles.bgFormulaText}>
                      {data.baseline.readingValue.toFixed(0)}
                    </Text>
                    <Text style={styles.bgFormulaMuted}> − </Text>
                    <Text style={[
                      styles.bgFormulaText,
                      data.baseline.cumulativeNetEffect >= 0 ? styles.warning : styles.good,
                    ]}>
                      ({data.baseline.cumulativeNetEffect >= 0 ? '+' : ''}{data.baseline.cumulativeNetEffect.toFixed(0)})
                    </Text>
                    <Text style={styles.bgFormulaMuted}> = </Text>
                    <Text style={styles.bgFormulaResult}>
                      {data.baseline.value.toFixed(0)}
                    </Text>
                  </View>
                  <Text style={styles.bgFormulaLabel}>reading − effects = baseline</Text>
                </>
              )}
            </>
          ) : (
            <>
              <Text style={[styles.bgTriValue, styles.good]}>—</Text>
              <Text style={styles.bgCardUnit}>mg/dL</Text>
              <Text style={styles.bgAnchorMeta}>No reading today</Text>
              <Text style={styles.bgAnchorBaseline}>Using target fallback</Text>
            </>
          )}
        </View>

        {/* Arrow 1 */}
        <View style={styles.bgArrowCol}>
          <Text style={styles.bgArrow}>→</Text>
          <Text style={styles.bgArrowLabel}>PK adj.</Text>
        </View>

        {/* CARD 2 — Current PK estimate */}
        <View style={[styles.bgTriCard, styles.bgTriCardMid]}>
          <Text style={styles.bgCardEyebrow}>ESTIMATED NOW</Text>
          <Text style={[styles.bgTriValue, styles[bgHighlight]]}>
            {data.netEffect.estimatedBG.toFixed(0)}
          </Text>
          <Text style={styles.bgCardUnit}>mg/dL</Text>
          <Text style={styles.bgReadingAge}>
            {new Date(data.metadata.calculatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {'  ·  now'}
          </Text>
          <Text style={[styles.bgEstStatus, styles[bgHighlight]]}>
            {data.netEffect.safetyStatus.replace(/_/g, ' ')}
          </Text>
          {/* Formula: baseline + net effects now = estimated BG */}
          {data.baseline && (
            <>
              <View style={styles.bgFormulaStrip}>
                <Text style={styles.bgFormulaText}>
                  {data.baseline.value.toFixed(0)}
                </Text>
                <Text style={styles.bgFormulaMuted}> + </Text>
                <Text style={[
                  styles.bgFormulaText,
                  data.netEffect.cumulativeBaseline >= 0 ? styles.warning : styles.good,
                ]}>
                  ({data.netEffect.cumulativeBaseline >= 0 ? '+' : ''}{data.netEffect.cumulativeBaseline.toFixed(0)})
                </Text>
                <Text style={styles.bgFormulaMuted}> = </Text>
                <Text style={styles.bgFormulaResult}>
                  {data.netEffect.estimatedBG.toFixed(0)}
                </Text>
              </View>
              <Text style={styles.bgFormulaLabel}>
                {data.baseline?.isPreset ? 'circadian + Δnow = est.' : 'baseline + Δnow = est.'}
              </Text>
            </>
          )}
        </View>

        {/* Arrow 2 */}
        <View style={styles.bgArrowCol}>
          <Text style={styles.bgArrow}>→</Text>
          <Text style={styles.bgArrowLabel}>pending</Text>
        </View>

        {/* CARD 3 — Projected final */}
        <View style={[styles.bgTriCard, styles.bgTriCardRight]}>
          <Text style={styles.bgCardEyebrow}>PROJECTED</Text>
          <Text style={[
            styles.bgTriValue,
            data.netEffect.pendingNetEffect >= 0 ? styles.warning : styles.good,
          ]}>
            {data.netEffect.simpleProjectedFinalBG.toFixed(0)}
          </Text>
          <Text style={styles.bgCardUnit}>mg/dL</Text>
          {data.metadata.projectedClearMs > Date.now() ? (
            <Text style={styles.bgReadingAge}>
              clears in {formatCountdown(data.metadata.projectedClearMs - Date.now())}
            </Text>
          ) : (
            <Text style={styles.bgReadingAge}>effects cleared</Text>
          )}
          <Text style={[
            styles.bgEstStatus,
            data.netEffect.pendingNetEffect >= 0 ? styles.warning : styles.good,
          ]}>
            {data.netEffect.pendingNetEffect >= 0 ? '+' : ''}{data.netEffect.pendingNetEffect.toFixed(0)} pending
          </Text>

          {/* Formula row 1 — PK model: baseline + Δcumul+pend */}
          {data.baseline && (
            <>
              <View style={styles.bgFormulaStrip}>
                <Text style={styles.bgFormulaText}>{data.baseline.value.toFixed(0)}</Text>
                <Text style={styles.bgFormulaMuted}> + </Text>
                <Text style={[
                  styles.bgFormulaText,
                  (data.netEffect.cumulativeBaseline + data.netEffect.pendingNetEffect) >= 0
                    ? styles.warning : styles.good,
                ]}>
                  ({(data.netEffect.cumulativeBaseline + data.netEffect.pendingNetEffect) >= 0 ? '+' : ''}
                  {(data.netEffect.cumulativeBaseline + data.netEffect.pendingNetEffect).toFixed(0)})
                </Text>
                <Text style={styles.bgFormulaMuted}> = </Text>
                <Text style={styles.bgFormulaResult}>{data.netEffect.projectedFinalBG.toFixed(0)}</Text>
              </View>
              <Text style={styles.bgFormulaLabel}>baseline + Δcumul+pend = proj.</Text>
            </>
          )}

          {/* Formula row 2 — simple: est. + Δpending */}
          <View style={[styles.bgFormulaStrip, { marginTop: 4 }]}>
            <Text style={styles.bgFormulaText}>{data.netEffect.estimatedBG.toFixed(0)}</Text>
            <Text style={styles.bgFormulaMuted}> + </Text>
            <Text style={[
              styles.bgFormulaText,
              data.netEffect.pendingNetEffect >= 0 ? styles.warning : styles.good,
            ]}>
              ({data.netEffect.pendingNetEffect >= 0 ? '+' : ''}{data.netEffect.pendingNetEffect.toFixed(0)})
            </Text>
            <Text style={styles.bgFormulaMuted}> = </Text>
            <Text style={styles.bgFormulaResult}>{data.netEffect.simpleProjectedFinalBG.toFixed(0)}</Text>
          </View>
          <Text style={styles.bgFormulaLabel}>est. + Δpending = proj.</Text>
        </View>

      </View>}

      {/* ── Two-column: IOB + MOB ──────────────────────────────────────── */}
      <View style={styles.columns}>

        {/* LEFT — IOB */}
        <View style={[styles.column, styles.columnLeft]}>
          <Text style={styles.colTitle}>💉 Insulin On Board</Text>
          <Text style={styles.colMainValue}>
            {data.iob.totalActiveInsulin.toFixed(2)} units
          </Text>
          <Text style={styles.colSubValue}>
            {data.iob.activeDoses} active dose{data.iob.activeDoses !== 1 ? 's' : ''}
          </Text>

          {/* Currently absorbed effect — active doses only */}
          <View style={styles.impactBlock}>
            {data.iob.activeDoses > 0 && data.iob.currentBGReduction > 0 ? (
              <>
                <Text style={styles.impactAbsorbed}>
                  ✅ -{data.iob.currentBGReduction.toFixed(0)} mg/dL absorbed
                </Text>
                <Text style={styles.impactNote}>
                  From active dose(s) so far{'\n'}(PAST→PRESENT)
                </Text>
              </>
            ) : data.metadata.futureDosesCount > 0 ? (
              <>
                <Text style={styles.impactAbsorbed}>
                  ⏳ {data.metadata.futureDosesCount} dose{data.metadata.futureDosesCount !== 1 ? 's' : ''} starting soon
                </Text>
                <Text style={styles.impactNote}>
                  Logged — effect not yet started{'\n'}
                  Reduction pending — not yet absorbed{'\n'}
                </Text>
              </>
            ) : data.metadata.absorbedOnlyDoses > 0 ? (
              <>
                <Text style={styles.impactAbsorbed}>✅ No active insulin</Text>
                <Text style={styles.impactNote}>
                  {data.metadata.absorbedOnlyDoses} dose{data.metadata.absorbedOnlyDoses !== 1 ? 's' : ''} fully absorbed today{'\n'}
                  Effect counted in estimated BG ↓{'\n'}
                </Text>
                <Text style={styles.resetCountdown}>
                  ↻ Clears at reset ({formatCountdown(data.metadata.nextResetMs - Date.now())})
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.impactAbsorbed}>✅ No insulin today</Text>
                <Text style={styles.impactNote}>(PAST→PRESENT)</Text>
              </>
            )}
          </View>

          {/* Pending effect from remaining IOB */}
          <View style={[styles.impactBlock, styles.impactBlockPending]}>
            <Text style={styles.impactPending}>
              ⏳ -{data.iob.pendingBGReduction.toFixed(0)} mg/dL pending
            </Text>
            <Text style={styles.impactNote}>
              From IOB ({data.iob.totalActiveInsulin.toFixed(1)}u){'\n'}PRESENT→FUTURE
            </Text>
            {data.metadata.futureDosesCount > 0 && data.iob.totalActiveInsulin === 0 && (
              <Text style={[styles.impactNote, { color: '#ab47bc', marginTop: 3 }]}>
                +{data.metadata.futureDosesCount} coming dose{data.metadata.futureDosesCount !== 1 ? 's' : ''} not yet counted
              </Text>
            )}
          </View>
        </View>

        {/* RIGHT — MOB */}
        <View style={[styles.column, styles.columnRight]}>
          <Text style={styles.colTitle}>🍽️ Meal On Board (MOB)</Text>
          <Text style={styles.colMainValue}>
            {data.mob.totalActiveCarbs.toFixed(1)}g
          </Text>
          <Text style={styles.colSubValue}>
            {data.mob.activeMealCount} active meal{data.mob.activeMealCount !== 1 ? 's' : ''}
            {data.mob.activeMealCount > 0 ? ' · Still digesting' : ''}
          </Text>

          {/* Currently absorbed effect — active meals only */}
          <View style={styles.impactBlock}>
            {data.mob.activeMealCount > 0 && data.mob.currentBGElevation > 0 ? (
              <>
                <Text style={styles.impactMealAbsorbed}>
                  ✅ +{data.mob.currentBGElevation.toFixed(0)} mg/dL absorbed
                </Text>
                <Text style={styles.impactNote}>
                  From active meal(s) so far{'\n'}(PAST→PRESENT)
                </Text>
              </>
            ) : data.metadata.futureMealsCount > 0 ? (
              <>
                <Text style={styles.impactMealAbsorbed}>⏳ {data.metadata.futureMealsCount} meal(s) starting soon</Text>
                <Text style={styles.impactNote}>
                  Logged with pre-meal insulin offset{'\n'}
                  Effect pending — not yet absorbed{'\n'}
                </Text>
              </>
            ) : data.metadata.absorbedOnlyMeals > 0 ? (
              <>
                <Text style={styles.impactMealAbsorbed}>✅ No active meals</Text>
                <Text style={styles.impactNote}>
                  {data.metadata.absorbedOnlyMeals} meal{data.metadata.absorbedOnlyMeals !== 1 ? 's' : ''} fully digested today{'\n'}
                  Effect counted in estimated BG ↓{'\n'}
                </Text>
                <Text style={styles.resetCountdown}>
                  ↻ Clears at reset ({formatCountdown(data.metadata.nextResetMs - Date.now())})
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.impactMealAbsorbed}>✅ No meals today</Text>
                <Text style={styles.impactNote}>(PAST→PRESENT)</Text>
              </>
            )}
          </View>

          {/* Pending effect from remaining MOB */}
          <View style={[styles.impactBlock, styles.impactBlockPendingMeal]}>
            <Text style={styles.impactMealPending}>
              ⏳ +{data.mob.pendingBGRise.toFixed(0)} mg/dL pending
            </Text>
            <Text style={styles.impactNote}>
              From MOB ({data.mob.totalActiveCarbs.toFixed(1)}g){'\n'}PRESENT→FUTURE
            </Text>
          </View>
        </View>
      </View>

      {/* ── Status assessment ─────────────────────────────────────────── */}
      {(() => {
        const assessment            = getProjectedAssessment(data.iob, data.mob, data.netEffect);
        const pendingMealRise       = data.mob.pendingBGRise;
        const pendingInsulinRedux   = data.iob.pendingBGReduction;
        const netPending            = data.netEffect.pendingNetEffect;
        const bothActive            = data.iob.totalActiveInsulin > 0.5 && data.mob.totalActiveCarbs > 5;

        const baselineBG            = data.baseline?.value ?? null;
        const nowBG                 = data.netEffect.estimatedBG;
        const projBG                = data.netEffect.projectedFinalBG;

        // Colour helpers
        const isRising              = netPending > 5;
        const isFalling             = netPending < -5;
        const trendColor            = isRising ? '#FF9800' : isFalling ? '#9C27B0' : '#4CAF50';
        const trendArrow            = isRising ? '↗' : isFalling ? '↘' : '→';
        const deltaSign             = netPending >= 0 ? '+' : '';

        // Tug-of-war proportions
        const totalForce            = pendingMealRise + pendingInsulinRedux;
        const mealPct               = totalForce > 0 ? (pendingMealRise / totalForce) * 100 : 50;
        const insulinPct            = 100 - mealPct;

        // Baseline-to-now delta (how much effects have moved BG so far today)
        const baselineToNowDelta    = baselineBG != null ? nowBG - baselineBG : null;

        return (
          <View style={[styles.assessmentCard, styles[assessment.bgStyle as keyof typeof styles]]}>

            {/* ── Title + chips ─────────────────────────────────────────── */}
            <View style={styles.assHeaderRow}>
              <Text style={[styles.assessmentTitle, { color: assessment.titleColor }]}>
                {assessment.icon}{'  '}{assessment.title}
              </Text>
              <View style={styles.assChipsInline}>
                {data.iob.totalActiveInsulin > 0 && (
                  <View style={styles.chipIOB}>
                    <Text style={styles.chipIOBText}>💉 {data.iob.totalActiveInsulin.toFixed(1)}u</Text>
                  </View>
                )}
                {data.mob.totalActiveCarbs > 0 && (
                  <View style={styles.chipMOB}>
                    <Text style={styles.chipMOBText}>🍽️ {data.mob.totalActiveCarbs.toFixed(0)}g</Text>
                  </View>
                )}
              </View>
            </View>

            {/* ── Plain-English recommendation ──────────────────────────── */}
            <Text style={styles.assessmentBody}>{assessment.recommendation}</Text>

            {/* ── 3-step BG journey: Before → Now → Projected ───────────── */}
            <View style={styles.assJourneyRow}>

              {/* Step 1 — Baseline (BG before today's food & insulin) */}
              {baselineBG != null && (
                <>
                  <View style={styles.assJourneyBox}>
                    <Text style={styles.assJourneyEyebrow}>BEFORE EFFECTS</Text>
                    <Text style={[styles.assJourneyValue, { color: '#888' }]}>
                      {baselineBG.toFixed(0)}
                    </Text>
                    <Text style={styles.assJourneyUnit}>mg/dL</Text>
                    <Text style={styles.assJourneyHint}>stable baseline</Text>
                  </View>
                  <View style={styles.assJourneyArrowBox}>
                    <Text style={styles.assJourneyArrowGrey}>→</Text>
                    {baselineToNowDelta != null && (
                      <Text style={[styles.assJourneyArrowDelta, {
                        color: baselineToNowDelta > 5 ? '#FF9800'
                             : baselineToNowDelta < -5 ? '#9C27B0' : '#4CAF50',
                      }]}>
                        {baselineToNowDelta > 0 ? '+' : ''}{baselineToNowDelta.toFixed(0)}
                      </Text>
                    )}
                  </View>
                </>
              )}

              {/* Step 2 — Estimated now */}
              <View style={[styles.assJourneyBox, styles.assJourneyBoxNow]}>
                <Text style={styles.assJourneyEyebrow}>RIGHT NOW</Text>
                <Text style={[styles.assJourneyValue, styles[getHighlight(nowBG)]]}>
                  {nowBG.toFixed(0)}
                </Text>
                <Text style={styles.assJourneyUnit}>mg/dL</Text>
                <Text style={styles.assJourneyHint}>estimated</Text>
              </View>

              {/* Arrow with pending delta */}
              <View style={styles.assJourneyArrowBox}>
                <Text style={[styles.assJourneyArrowGrey, { color: trendColor, fontSize: 20 }]}>
                  {trendArrow}
                </Text>
                <Text style={[styles.assJourneyArrowDelta, { color: trendColor }]}>
                  {deltaSign}{netPending.toFixed(0)}
                </Text>
              </View>

              {/* Step 3 — Projected final */}
              <View style={styles.assJourneyBox}>
                <Text style={styles.assJourneyEyebrow}>PROJECTED</Text>
                <Text style={[styles.assJourneyValue, styles[getHighlight(projBG)]]}>
                  {projBG.toFixed(0)}
                </Text>
                <Text style={styles.assJourneyUnit}>mg/dL</Text>
                <Text style={styles.assJourneyHint}>when effects clear</Text>
              </View>
            </View>

            {/* ── Tug-of-war — only when insulin & carbs are both active ── */}
            {bothActive && totalForce > 0 && (
              <View style={styles.tugSection}>
                {/* Label row */}
                <View style={styles.tugLabelRow}>
                  <Text style={styles.tugLabelMeal}>🍽️ Carbs pushing up</Text>
                  <Text style={styles.tugLabelInsulin}>Insulin pulling down 💉</Text>
                </View>

                {/* Bar */}
                <View style={styles.tugBarTrack}>
                  <View style={[styles.tugBarMeal,    { flex: mealPct }]} />
                  <View style={[styles.tugBarInsulin, { flex: insulinPct }]} />
                </View>

                {/* Values */}
                <View style={styles.tugValueRow}>
                  <Text style={styles.tugValueMeal}>+{pendingMealRise.toFixed(0)}</Text>
                  <Text style={[styles.tugNetBadge, {
                    backgroundColor: trendColor + '22', color: trendColor,
                  }]}>
                    net {deltaSign}{Math.abs(netPending).toFixed(0)}
                  </Text>
                  <Text style={styles.tugValueInsulin}>−{pendingInsulinRedux.toFixed(0)}</Text>
                </View>

                {/* Plain-English outcome */}
                <Text style={styles.tugCaption}>
                  {isRising
                    ? 'Food is raising BG faster than insulin is lowering it'
                    : isFalling
                    ? 'Insulin is lowering BG faster than food is raising it'
                    : 'Food and insulin are roughly cancelling each other out'}
                </Text>
              </View>
            )}
          </View>
        );
      })()}

      {/* ── Net Effect Analysis (collapsible) ────────────────────────── */}
      <TouchableOpacity
        style={styles.netCard}
        onPress={() => setNetExpanded(prev => !prev)}
        activeOpacity={0.85}
      >
        <View style={styles.netCardHeader}>
          <Text style={styles.netCardTitle}>⚖️ T1D Net Effect Analysis</Text>
          <Text style={styles.netCardChevron}>{netExpanded ? '▲' : '▼'}</Text>
        </View>

        {!netExpanded && (
          <Text style={styles.netCardCollapsedHint}>Tap to expand breakdown</Text>
        )}

        {netExpanded && (
          <>
            {/* Daily cumulative — feeds into estimatedBG */}
            <View style={styles.cumulBlock}>
              <View style={styles.cumulBlockHeader}>
                <Text style={styles.cumulBlockTitle}>📊 Today's Cumulative BG Effect till now </Text>
                <Text style={[
                  styles.cumulBlockValue,
                  data.netEffect.cumulativeBaseline >= 0 ? styles.positive : styles.negative,
                ]}>
                  {data.netEffect.cumulativeBaseline >= 0 ? '+' : ''}{data.netEffect.cumulativeBaseline.toFixed(0)} mg/dL
                </Text>
              </View>
              <Text style={styles.cumulBlockSub}>
                All meals & insulin since daily reset (incl. fully absorbed)
              </Text>
            </View>
            <EffectRow
              label="🍽️ Daily meal effect"
              sublabel={`${data.metadata.absorbedOnlyMeals + data.mob.activeMealCount + data.metadata.futureMealsCount} meal(s) since reset`}
              value={`+${data.netEffect.cumulativeMealEffect.toFixed(1)} mg/dL`}
              valueStyle="positive"
            />
            <EffectRow
              label="💉 Daily insulin effect"
              sublabel={`${data.metadata.absorbedOnlyDoses + data.iob.activeDoses} dose(s) since reset`}
              value={`${data.netEffect.cumulativeInsulinEffect.toFixed(1)} mg/dL`}
              valueStyle="negative"
            />

            <View style={styles.netDivider} />

            {/* Active-only: what's still happening RIGHT NOW */}
            <View style={styles.cumulBlock}>
              <View style={styles.cumulBlockHeader}>
                <Text style={styles.cumulBlockTitle}>⚡ Currently Active</Text>
                <Text style={styles.cumulBlockValue}>
                  {data.iob.activeDoses} dose{data.iob.activeDoses !== 1 ? 's' : ''} · {data.mob.activeMealCount} meal{data.mob.activeMealCount !== 1 ? 's' : ''}
                </Text>
              </View>
              <Text style={styles.cumulBlockSub}>
                Still absorbing right now
              </Text>
            </View>
            <EffectRow
              label="✅ Active meal absorbed so far"
              sublabel="PAST→PRESENT: Absorbed carbs in bloodstream"
              value={`+${data.mob.currentBGElevation.toFixed(1)} mg/dL`}
              valueStyle="positive"
            />
            <EffectRow
              label="⏳ Active meal pending"
              sublabel={`PRESENT→FUTURE: MOB (${data.mob.totalActiveCarbs.toFixed(1)}g still digesting)`}
              value={`+${data.mob.pendingBGRise.toFixed(1)} mg/dL`}
              valueStyle="warning"
            />
            <EffectRow
              label="✅ Active insulin absorbed so far"
              sublabel="PAST→PRESENT: From currently-absorbing dose(s)"
              value={`-${data.iob.currentBGReduction.toFixed(1)} mg/dL`}
              valueStyle="negative"
            />
            <EffectRow
              label="⏳ Active insulin pending (IOB)"
              sublabel={`From IOB (${data.iob.totalActiveInsulin.toFixed(2)}u still active)`}
              value={`-${data.iob.pendingBGReduction.toFixed(1)} mg/dL`}
              valueStyle="negative"
            />

            {/* Projected final */}
            <View style={styles.projectedRow}>
              <View>
                <Text style={styles.projectedLabel}>Projected Final BG</Text>
                <Text style={styles.projectedSub}>After IOB acts completely</Text>
              </View>
              <Text style={[styles.projectedValue, styles[getHighlight(data.netEffect.projectedFinalBG)]]}>
                {data.netEffect.projectedFinalBG.toFixed(0)} mg/dL
              </Text>
            </View>
          </>
        )}
      </TouchableOpacity>

      {/* Footer metadata */}
      <View style={styles.meta}>
        <Text style={styles.metaText}>📊 {data.metadata.mealsCount} meals</Text>
        <Text style={styles.metaText}>💉 {data.metadata.dosesCount} doses</Text>
        <Text style={styles.metaText}>
          📱 {data.metadata.hasRecentReading ? 'Reading ✓' : 'No reading today'}
        </Text>
      </View>

      <TouchableOpacity style={styles.refreshButton} onPress={fetchAndCalculate}>
        <Text style={styles.refreshButtonText}>🔄 Refresh</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function EffectRow({
  label, sublabel, value, valueStyle,
}: {
  label: string;
  sublabel: string;
  value: string;
  valueStyle: 'positive' | 'negative' | 'warning';
}) {
  return (
    <View style={styles.effectRow}>
      <View style={styles.effectLeft}>
        <Text style={styles.effectLabel}>{label}</Text>
        <Text style={styles.effectSublabel}>{sublabel}</Text>
      </View>
      <Text style={[styles.effectValue, styles[valueStyle]]}>{value}</Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getHighlight(bg: number): 'positive' | 'negative' | 'warning' | 'good' {
  if (bg < 70) return 'negative';
  if (bg > 180) return 'warning';
  if (bg >= 70 && bg <= 140) return 'good';
  return 'positive';
}

/** Derive safetyStatus string from an actual BG value, matching backend thresholds. */
function bgToSafetyStatus(bg: number): string {
  if (bg < 54)  return 'critical_low';
  if (bg < 70)  return 'hypoglycemia_risk';
  if (bg > 250) return 'critical_high';
  if (bg > 180) return 'hyperglycemia_risk';
  return 'optimal';
}

function getSafetyHighlight(s: string): 'positive' | 'negative' | 'warning' | 'good' {
  if (s === 'critical_low' || s === 'critical_high') return 'negative';
  if (s === 'hypoglycemia_risk' || s === 'hyperglycemia_risk') return 'warning';
  if (s === 'optimal') return 'good';
  return 'positive';
}

function getRecommendation(status: string): string {
  switch (status) {
    case 'optimal':             return 'Blood sugar is in a good range.';
    case 'hypoglycemia_risk':   return 'Risk of low blood sugar. Monitor closely.';
    case 'hyperglycemia_risk':  return 'Risk of high blood sugar. Consider correction.';
    case 'critical_low':        return 'Critically low blood sugar. Take action immediately.';
    case 'critical_high':       return 'Critically high blood sugar. Take action immediately.';
    default:                    return 'Insulin and carbs are both active. Monitor closely.';
  }
}

/** Threshold (mg/dL) above which one pending force is meaningfully "winning". */
const NET_PENDING_THRESHOLD = 20;

/**
 * Derive a richer assessment from the already-computed IOB, MOB, and net effect
 * values.  All inputs come from `data` which is available at render time —
 * no extra calculations are needed.
 *
 * projectedOutcome:
 *   'hypo_risk'  – insulin pending reduction outpaces remaining carb rise
 *   'hyper_risk' – remaining carb rise outpaces insulin pending reduction
 *   'balanced'   – both active but net swing is within ±20 mg/dL
 *   'iob_only'   – only insulin is meaningfully active
 *   'mob_only'   – only meal carbs are meaningfully active
 *   'stable'     – neither force is significant
 */
function getProjectedAssessment(
  iob: ActiveEffectData['iob'],
  mob: ActiveEffectData['mob'],
  netEffect: ActiveEffectData['netEffect'],
): {
  icon: string;
  title: string;
  titleColor: string;
  recommendation: string;
  projectedOutcome: string;
  bgStyle: string;
} {
  const pendingMealRise         = mob.pendingBGRise;
  const pendingInsulinReduction = iob.pendingBGReduction;
  const netPending              = pendingMealRise - pendingInsulinReduction;

  const hasMeaningfulIOB = iob.totalActiveInsulin > 0.5;
  const hasMeaningfulMOB = mob.totalActiveCarbs    > 5;
  const bothActive       = hasMeaningfulIOB && hasMeaningfulMOB;

  if (netEffect.safetyStatus === 'critical_low') {
    return { icon: '🚨', title: 'CRITICAL LOW', titleColor: '#F44336',
             recommendation: 'Critically low blood sugar — take action immediately.',
             projectedOutcome: 'critical_low', bgStyle: 'assessment_negative' };
  }
  if (netEffect.safetyStatus === 'critical_high') {
    return { icon: '🚨', title: 'CRITICAL HIGH', titleColor: '#F44336',
             recommendation: 'Critically high blood sugar — take action immediately.',
             projectedOutcome: 'critical_high', bgStyle: 'assessment_negative' };
  }

  if (bothActive) {
    if (netPending < -NET_PENDING_THRESHOLD) {
      return {
        icon: '⬇️', title: 'BOTH ACTIVE — FALLING RISK', titleColor: '#9C27B0',
        recommendation:
          'Insulin is outpacing meal absorption — BG is likely to fall. ' +
          'Consider a small snack if not eating again soon.',
        projectedOutcome: 'hypo_risk', bgStyle: 'assessment_good',
      };
    }
    if (netPending > NET_PENDING_THRESHOLD) {
      return {
        icon: '⬆️', title: 'BOTH ACTIVE — RISING RISK', titleColor: '#FF9800',
        recommendation:
          'Meal carbs are outpacing active insulin — BG is likely to rise. ' +
          'Monitor closely and consider a correction dose if needed.',
        projectedOutcome: 'hyper_risk', bgStyle: 'assessment_warning',
      };
    }
    return {
      icon: '⚖️', title: 'BOTH ACTIVE — BALANCED', titleColor: '#2196F3',
      recommendation:
        'Insulin and carbs are closely matched. Monitor BG closely over the next hour.',
      projectedOutcome: 'balanced', bgStyle: 'assessment_good',
    };
  }

  if (hasMeaningfulIOB) {
    return {
      icon: pendingInsulinReduction > NET_PENDING_THRESHOLD ? '⬇️' : '💉',
      title: 'HIGH IOB',
      titleColor: '#9C27B0',
      recommendation: pendingInsulinReduction > NET_PENDING_THRESHOLD
        ? 'Active insulin may lower your BG significantly. Consider a snack if not eating soon.'
        : 'Insulin is active. Monitor BG before your next meal.',
      projectedOutcome: 'iob_only', bgStyle: 'assessment_good',
    };
  }

  if (hasMeaningfulMOB) {
    return {
      icon: pendingMealRise > NET_PENDING_THRESHOLD ? '⬆️' : '🍽️',
      title: 'HIGH MOB',
      titleColor: '#FF9800',
      recommendation:
        'Carbs still absorbing — account for them before dosing again.',
      projectedOutcome: 'mob_only', bgStyle: 'assessment_warning',
    };
  }

  return {
    icon: netEffect.safetyStatus.includes('risk') ? '⚠️' : '✅',
    title: netEffect.safetyStatus.replace(/_/g, ' ').toUpperCase(),
    titleColor: netEffect.safetyStatus.includes('risk') ? '#FF9800'
               : netEffect.safetyStatus === 'optimal' ? '#4CAF50' : '#666',
    recommendation: getRecommendation(netEffect.safetyStatus),
    projectedOutcome: 'stable',
    bgStyle: `assessment_${getSafetyHighlight(netEffect.safetyStatus)}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f2f5' },
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },

  // ── Header ────────────────────────────────────────────────────────────────
  header: {
    backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#e8e8e8',
  },
  title:     { fontSize: 20, fontWeight: '700', color: '#1a1a1a' },
  subtitle:  { fontSize: 12, color: '#999', marginTop: 2 },
  timestamp: { fontSize: 11, color: '#bbb', marginTop: 2 },

  // ── Hero card ────────────────────────────────────────────────────────────
  // ── BG three-card row: Last Reading → Estimated Now → Projected ──────────
  bgTriRow: {
    flexDirection: 'row',
    marginHorizontal: 12,
    marginTop: 10,
    marginBottom: 6,
    alignItems: 'stretch',
  },
  bgTriCard: {
    flex: 1,
    backgroundColor: '#fff',
    paddingVertical: 10,
    paddingHorizontal: 5,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e8e8e8',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  bgTriCardLeft: {
    borderTopLeftRadius: 14,
    borderBottomLeftRadius: 14,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    borderRightWidth: 0,
  },
  bgTriCardMid: {
    borderRadius: 0,
    borderRightWidth: 0,
    backgroundColor: '#fafafa',
  },
  bgTriCardRight: {
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 14,
  },
  bgTriValue: {
    fontSize: 36,
    fontWeight: '800',
    lineHeight: 42,
    marginTop: 2,
  },
  bgAnchorMeta: {
    fontSize: 10,
    color: '#999',
    marginTop: 4,
    textAlign: 'center',
  },
  bgReadingAge: {
    fontSize: 10,
    fontWeight: '600',
    color: '#777',
    marginTop: 3,
    textAlign: 'center',
  },
  bgAnchorBaseline: {
    fontSize: 9,
    color: '#bbb',
    marginTop: 2,
    textAlign: 'center',
  },
  bgArrowCol: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f5f5f5',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#e8e8e8',
    gap: 2,
  },
  bgArrow: {
    fontSize: 13,
    color: '#c0c0c0',
    fontWeight: '700',
  },
  bgArrowLabel: {
    fontSize: 7,
    color: '#ccc',
    fontWeight: '600',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  bgEstStatus: {
    fontSize: 10,
    fontWeight: '700',
    marginTop: 4,
    textAlign: 'center',
    textTransform: 'capitalize',
  },
  bgProjectedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  bgProjectedLabel: {
    fontSize: 10,
    color: '#aaa',
  },
  bgProjectedValue: {
    fontSize: 11,
    fontWeight: '700',
  },
  bgProjectedDelta: {
    fontSize: 10,
    fontWeight: '600',
  },
  bgClearTime: {
    fontSize: 10,
    fontWeight: '600',
    color: '#aaa',
    marginTop: 4,
    textAlign: 'center',
  },
  // ── Baseline formula strip ─────────────────────────────────────────────────
  bgFormulaStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'nowrap',
    marginTop: 4,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  bgFormulaText: {
    fontSize: 8,
    fontWeight: '700',
    color: '#555',
  },
  bgFormulaMuted: {
    fontSize: 8,
    color: '#ccc',
  },
  bgFormulaResult: {
    fontSize: 8,
    fontWeight: '800',
    color: '#333',
  },
  bgFormulaLabel: {
    fontSize: 7,
    color: '#bbb',
    fontWeight: '500',
    marginTop: 1,
    textAlign: 'center',
    letterSpacing: 0.1,
  },
  bgCardEyebrow: {
    fontSize: 8,
    fontWeight: '700',
    color: '#bbb',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  bgCardUnit: {
    fontSize: 10,
    color: '#aaa',
    fontWeight: '500',
    marginTop: -2,
  },

  // ── Projected card — dual display (PK model vs simple) ──────────────────────
  projDualBlock: {
    alignItems: 'center',
    width: '100%',
  },
  projMethodLabel: {
    fontSize: 7,
    fontWeight: '800',
    color: '#7b68ee',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 1,
  },
  projMethodLabelSimple: {
    fontSize: 7,
    fontWeight: '800',
    color: '#aaa',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 1,
  },
  projMethodSub: {
    fontSize: 8,
    color: '#ccc',
    textAlign: 'center',
    marginTop: 1,
  },
  projSimpleValue: {
    fontSize: 26,
    fontWeight: '700',
    lineHeight: 32,
    opacity: 0.75,
  },
  projDualDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    marginVertical: 6,
    gap: 4,
  },
  projDualDividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#e8e8e8',
  },
  projDualDividerLabel: {
    fontSize: 9,
    color: '#ccc',
    fontWeight: '600',
    letterSpacing: 0.5,
  },

  // ── Two-column layout ─────────────────────────────────────────────────────
  columns: {
    flexDirection: 'row', marginHorizontal: 12, gap: 8,
  },
  column: {
    flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 4, elevation: 2,
  },
  columnLeft:  { borderTopWidth: 3, borderTopColor: '#9c27b0' },
  columnRight: { borderTopWidth: 3, borderTopColor: '#4caf50' },

  colTitle:     { fontSize: 12, fontWeight: '700', color: '#333', marginBottom: 6 },
  colMainValue: { fontSize: 22, fontWeight: '800', color: '#1a1a1a', marginBottom: 2 },
  colSubValue:  { fontSize: 11, color: '#888', marginBottom: 4 },

  impactBlock: {
    marginTop: 8, padding: 8, borderRadius: 8,
    backgroundColor: '#f9f9f9',
  },
  impactBlockPending:     { backgroundColor: '#faf5ff' },
  impactBlockPendingMeal: { backgroundColor: '#fffbf0' },

  impactAbsorbed:     { fontSize: 12, fontWeight: '700', color: '#7b1fa2' },
  impactPending:      { fontSize: 12, fontWeight: '700', color: '#ab47bc' },
  impactMealAbsorbed: { fontSize: 12, fontWeight: '700', color: '#2e7d32' },
  impactMealPending:  { fontSize: 12, fontWeight: '700', color: '#f57f17' },
  impactNote:         { fontSize: 10, color: '#aaa', marginTop: 2, lineHeight: 14 },
  resetCountdown:     { fontSize: 10, color: '#888', marginTop: 4, fontStyle: 'italic' },
  netDivider:         { height: 1, backgroundColor: 'rgba(0,0,0,0.08)', marginVertical: 10 },

  // ── Assessment card ───────────────────────────────────────────────────────
  assessmentCard: {
    marginHorizontal: 12, marginTop: 8, borderRadius: 12,
    padding: 14, borderLeftWidth: 4,
    backgroundColor: '#f5f5f5', borderLeftColor: '#9e9e9e',
  },
  assessment_positive: { backgroundColor: '#e8f5e9', borderLeftColor: '#4caf50' },
  assessment_negative: { backgroundColor: '#ffebee', borderLeftColor: '#f44336' },
  assessment_warning:  { backgroundColor: '#fff3e0', borderLeftColor: '#ff9800' },
  assessment_good:     { backgroundColor: '#e3f2fd', borderLeftColor: '#2196f3' },

  // Title + chips inline
  assHeaderRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap', gap: 6,
  },
  assessmentTitle: { fontSize: 14, fontWeight: '700', flexShrink: 1 },
  assChipsInline:  { flexDirection: 'row', gap: 5, flexWrap: 'wrap' },

  assessmentBody: { fontSize: 13, color: '#444', lineHeight: 18, marginBottom: 10 },
  assessmentMeta: { fontSize: 11, color: '#888', marginTop: 4 },

  // ── IOB / MOB chips ───────────────────────────────────────────────────────
  assessmentChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  chipIOB: {
    backgroundColor: '#f3e5f5', borderWidth: 1, borderColor: '#9c27b0',
    borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3,
  },
  chipIOBText: { fontSize: 11, fontWeight: '600', color: '#9c27b0' },
  chipMOB: {
    backgroundColor: '#fff3e0', borderWidth: 1, borderColor: '#ff9800',
    borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3,
  },
  chipMOBText: { fontSize: 11, fontWeight: '600', color: '#ff9800' },

  // ── 3-step BG journey row ─────────────────────────────────────────────────
  assJourneyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  assJourneyBox: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 2,
  },
  assJourneyBoxNow: {
    // slightly elevated to signal "you are here"
    backgroundColor: 'rgba(255,255,255,0.85)',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08, shadowRadius: 3, elevation: 2,
  },
  assJourneyEyebrow: {
    fontSize: 7, fontWeight: '700', color: '#aaa',
    letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 2,
  },
  assJourneyValue: {
    fontSize: 26, fontWeight: '800', lineHeight: 30,
  },
  assJourneyUnit: {
    fontSize: 9, color: '#999', marginTop: 1,
  },
  assJourneyHint: {
    fontSize: 9, color: '#bbb', marginTop: 2, textAlign: 'center',
  },
  assJourneyArrowBox: {
    alignItems: 'center',
    paddingHorizontal: 4,
    gap: 2,
  },
  assJourneyArrowGrey: {
    fontSize: 16, color: '#bbb', fontWeight: '600',
  },
  assJourneyArrowDelta: {
    fontSize: 10, fontWeight: '700',
  },

  // ── Tug-of-war section ────────────────────────────────────────────────────
  tugSection: {
    marginTop: 12, paddingTop: 10,
    borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.07)',
  },
  tugLabelRow: {
    flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5,
  },
  tugLabelMeal:    { fontSize: 11, fontWeight: '600', color: '#FF9800' },
  tugLabelInsulin: { fontSize: 11, fontWeight: '600', color: '#9C27B0' },
  tugBarTrack: {
    flexDirection: 'row', height: 10, borderRadius: 5,
    overflow: 'hidden', backgroundColor: '#eee',
  },
  tugBarMeal:    { backgroundColor: '#FF9800', height: '100%' },
  tugBarInsulin: { backgroundColor: '#9C27B0', height: '100%' },
  tugValueRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginTop: 5,
  },
  tugValueMeal:    { fontSize: 12, fontWeight: '700', color: '#FF9800' },
  tugValueInsulin: { fontSize: 12, fontWeight: '700', color: '#9C27B0' },
  tugNetBadge: {
    fontSize: 12, fontWeight: '800', borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden',
  },
  tugCaption: {
    fontSize: 11, color: '#666', textAlign: 'center',
    marginTop: 7, fontStyle: 'italic',
  },

  // (kept for net-effect card compatibility — no longer used in assessment card)
  assessmentHeaderRow:       { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  assessmentChipsOld:        { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  assessmentPendingRow:      { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.06)' },
  assessmentPendingLabel:    { fontSize: 11, color: '#999', marginBottom: 4 },
  assessmentPendingValues:   { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  pendingMeal:               { fontSize: 12, fontWeight: '600', color: '#FF9800' },
  pendingVs:                 { fontSize: 12, color: '#999' },
  pendingInsulin:            { fontSize: 12, fontWeight: '600', color: '#9C27B0' },
  pendingNet:                { fontSize: 12, fontWeight: '700' },
  pendingNetHigh:            { color: '#FF9800' },
  pendingNetLow:             { color: '#9C27B0' },
  pendingNetNeutral:         { color: '#4CAF50' },
  assessmentProjectedRow:    { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.06)' },
  assessmentProjectedBGLabel: { fontSize: 12, color: '#888' },
  assessmentProjectedBGArrow: { fontSize: 12, color: '#ccc' },
  assessmentProjectedBGValue: { fontSize: 13, fontWeight: '800' },
  assessmentProjectedBGDelta: { fontSize: 12, fontWeight: '700' },

  // ── Net effect card ───────────────────────────────────────────────────────
  netCard: {
    backgroundColor: '#fff', marginHorizontal: 12, marginTop: 8,
    borderRadius: 12, padding: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 4, elevation: 2,
  },
  netCardHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  netCardTitle: { fontSize: 15, fontWeight: '700', color: '#333' },
  netCardChevron: { fontSize: 13, color: '#aaa', marginLeft: 8 },
  netCardCollapsedHint: { fontSize: 11, color: '#bbb', marginTop: 4 },

  effectRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: '#f4f4f4',
  },
  effectLeft:     { flex: 1, paddingRight: 8 },
  effectLabel:    { fontSize: 13, fontWeight: '600', color: '#333' },
  effectSublabel: { fontSize: 10, color: '#aaa', marginTop: 2 },
  effectValue:    { fontSize: 14, fontWeight: '700', textAlign: 'right' },

  netRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10, marginTop: 4,
    borderTopWidth: 2, borderTopColor: '#eeeeee',
  },
  netRowLabel: { fontSize: 13, fontWeight: '700', color: '#333' },
  netRowValue: { fontSize: 15, fontWeight: '800' },

  cumulBlock: {
    marginTop: 10, padding: 10, borderRadius: 8,
    backgroundColor: '#f0f9ff', borderLeftWidth: 4, borderLeftColor: '#2196f3',
  },
  cumulBlockNet: { backgroundColor: '#e8f5e9', borderLeftColor: '#4caf50', marginTop: 6 },
  cumulBlockHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cumulBlockTitle:  { fontSize: 12, fontWeight: '700', color: '#333', flex: 1 },
  cumulBlockValue:  { fontSize: 15, fontWeight: '700' },
  cumulNetValue:    { fontSize: 17, fontWeight: '800' },
  cumulBlockSub:    { fontSize: 10, color: '#888', marginTop: 3 },

  projectedRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 10, paddingTop: 10,
    borderTopWidth: 2, borderTopColor: '#eeeeee',
  },
  projectedLabel: { fontSize: 13, fontWeight: '700', color: '#333' },
  projectedSub:   { fontSize: 10, color: '#aaa', marginTop: 2 },
  projectedValue: { fontSize: 22, fontWeight: '800' },

  // ── Shared highlight colours ──────────────────────────────────────────────
  positive: { color: '#4CAF50' },
  negative: { color: '#F44336' },
  warning:  { color: '#FF9800' },
  good:     { color: '#2196F3' },

  // ── Footer ────────────────────────────────────────────────────────────────
  meta: {
    flexDirection: 'row', justifyContent: 'space-around',
    backgroundColor: '#fff', marginHorizontal: 12, marginTop: 8,
    padding: 12, borderRadius: 12,
  },
  metaText: { fontSize: 12, color: '#aaa' },

  refreshButton: {
    backgroundColor: '#007AFF', margin: 12, padding: 14,
    borderRadius: 12, alignItems: 'center',
  },
  refreshButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  // ── Loading / error ───────────────────────────────────────────────────────
  loadingText: { fontSize: 15, color: '#666', marginTop: 16 },
  errorText:   { fontSize: 15, color: '#F44336', textAlign: 'center', marginBottom: 16 },
  retryButton: {
    backgroundColor: '#007AFF', padding: 14, borderRadius: 12,
    alignItems: 'center', marginHorizontal: 32,
  },
  retryText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  // ── Mode badge ──────────────────────────────────────────────────────────────
  modeBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 6,
    marginBottom: 2,
  },
  modeBadge: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderWidth: 1,
  },
  modeBadgeDynamic: {
    backgroundColor: '#e3f2fd',
    borderColor: '#2196f3',
  },
  modeBadgePreset: {
    backgroundColor: '#e8f5e9',
    borderColor: '#4caf50',
  },
  modeBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  modeBadgeTextDynamic: {
    color: '#1565c0',
  },
  modeBadgeTextPreset: {
    color: '#2e7d32',
  },
  modeBadgeHint: {
    fontSize: 11,
    color: '#aaa',
  },

  // ── Baseline clamp warning banner ─────────────────────────────────────────
  clampBanner: {
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 2,
    backgroundColor: '#fff3e0',
    borderRadius: 10,
    borderLeftWidth: 4,
    borderLeftColor: '#e65100',
    padding: 12,
    shadowColor: '#e65100',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.12,
    shadowRadius: 4,
    elevation: 2,
  },
  clampBannerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  clampBannerIcon: {
    fontSize: 20,
    marginTop: 1,
  },
  clampBannerTextCol: {
    flex: 1,
    gap: 3,
  },
  clampBannerTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#bf360c',
    letterSpacing: 0.2,
  },
  clampBannerBody: {
    fontSize: 12,
    color: '#5d4037',
    lineHeight: 17,
  },
  clampBannerHighlight: {
    fontWeight: '700',
    color: '#bf360c',
  },
  clampBannerReason: {
    fontSize: 11,
    color: '#8d6e63',
    marginTop: 2,
    fontStyle: 'italic',
  },

  // ── Unreliable estimate alert ─────────────────────────────────────────────
  unreliableBanner: {
    marginHorizontal: 12,
    marginTop: 10,
    marginBottom: 4,
    backgroundColor: '#fff8e1',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#f9a825',
    padding: 16,
    shadowColor: '#f57f17',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.14,
    shadowRadius: 6,
    elevation: 3,
  },
  unreliableBannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  unreliableBannerIcon: {
    fontSize: 22,
  },
  unreliableBannerTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#e65100',
    letterSpacing: 0.1,
    flex: 1,
  },
  unreliableBannerBody: {
    fontSize: 13,
    color: '#5d4037',
    lineHeight: 19,
    marginBottom: 14,
  },
  unreliableBannerSubtitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6d4c41',
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  unreliableChecklist: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ffe0b2',
    overflow: 'hidden',
    marginBottom: 14,
  },
  unreliableCheckRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 11,
    gap: 10,
  },
  unreliableCheckDivider: {
    height: 1,
    backgroundColor: '#fff3e0',
    marginHorizontal: 12,
  },
  unreliableCheckIcon: {
    fontSize: 18,
    marginTop: 1,
  },
  unreliableCheckText: {
    flex: 1,
    gap: 3,
  },
  unreliableCheckLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#4e342e',
  },
  unreliableCheckHint: {
    fontSize: 11,
    color: '#795548',
    lineHeight: 16,
  },
  unreliableCheckStatus: {
    fontSize: 13,
    fontWeight: '800',
    marginTop: 2,
  },
  unreliableCheckOk: {
    color: '#2e7d32',
  },
  unreliableCheckWarn: {
    color: '#c62828',
  },
  unreliableBannerFooter: {
    fontSize: 11,
    color: '#8d6e63',
    textAlign: 'center',
    fontStyle: 'italic',
    lineHeight: 16,
  },
});