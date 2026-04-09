/**
 * Cumulative Effects Calculation
 * Daily accumulated meal and insulin effects with timezone-aware reset
 *
 * ─── v4.4 FIX: PERSIST-AT-100% (matches backend Phase 3 behaviour) ────────────
 *
 * ROOT CAUSE of frontend/backend mismatch in estimatedBG / cumulativeNetBaseline:
 *
 *   Backend `calculate_meal_cumulative_effect` (pharmacodynamics.py line 709):
 *     if current_time >= end_time:
 *       return total_carbs * carb_to_bg_factor   # ← PERSISTS at full value
 *
 *   Backend `calculate_insulin_cumulative_effect` (pharmacodynamics.py line 780):
 *     if current_time >= end_time:
 *       return -(dose_amount * correction_factor) # ← PERSISTS at full value
 *
 *   The previous frontend implementation delegated to blood-glucose-estimation.ts
 *   which did NOT implement this Phase 3 persist behaviour, returning 0 (or the
 *   last partial value) once absorption duration elapsed.
 *
 * FIX SUMMARY:
 *   - `calculateMealCumulativeEffect` now detects Phase 3 (hours-since >= duration)
 *     and returns the FULL carb×factor effect, delegating only Phase 1/2 to the
 *     underlying blood-glucose-estimation implementation.
 *   - `calculateInsulinCumulativeEffect` similarly returns -(dose×CF) for Phase 3.
 *   - `calculateTotalCumulativeEffects` is rewritten to call the FIXED sub-functions
 *     directly so that every meal/dose benefits from persist-at-100%.
 *
 * IMPORTANT — caller responsibility:
 *   Pass ALL meals/doses from the current daily window (not just still-absorbing
 *   ones). Fully-absorbed meals must be included so their persisted effect is
 *   counted. See ActiveEffectsDisplay.tsx `allMealsInWindow` for the pattern.
 *
 * Re-exports and wraps logic from blood-glucose-estimation.ts so that
 * the rest of the codebase imports from a single, well-named location.
 *
 * Ports: backend/utils/pharmacodynamics.py::calculate_total_cumulative_effects()
 *
 * @module utils/calculations/cumulative-effects
 * @version 1.1
 */

import type { Meal } from '@/types/meal.types';
import type { InsulinDose } from '@/types/insulin.types';
import type { PatientConstants } from '@/types/constants.types';
import type { PharmacodynamicProfile } from '@/types/pharmacodynamics.types';
import type { AbsorptionType } from '@/types/meal.types';
import type { MealAbsorptionProfile } from '@/constants/shared-constants';

import {
  getDailyResetTime as _getDailyResetTime,
  getLastResetTime as _getLastResetTime,
  calculateMealCumulativeEffect as _calculateMealCumulativeEffect,
  calculateInsulinCumulativeEffect as _calculateInsulinCumulativeEffect,
  type CumulativeEffectsResult,
} from '@/utils/glucose/blood-glucose-estimation';

// ─── Re-export the result type so callers don't need to reach into BG estimation ───
export type { CumulativeEffectsResult };

// ─── Internal UTC timestamp parser ───────────────────────────────────────────
// Handles three input types:
//   1. number  — already UTC milliseconds (from processContextMealsForChart)
//   2. numeric string — e.g. "1742274240000" (number coerced to string)
//   3. ISO string — bare (no Z) or with timezone indicator
//
// ✅ FIX: processContextMealsForChart converts meal.timestamp to a number before
// passing meals to buildChartData, which then calls calculateTotalCumulativeEffects.
// The previous implementation only accepted strings, so calling .endsWith() on a
// number crashed with "ts.endsWith is not a function".
function parseUTCMs(ts: string | number | null | undefined): number {
  if (ts === null || ts === undefined || ts === '') return NaN;
  // Fast-path: already a number (UTC ms)
  if (typeof ts === 'number') return ts;
  // Numeric string fast-path: all digits → treat as ms timestamp
  if (/^\d+$/.test(ts)) return parseInt(ts, 10);
  // ISO string: append 'Z' for bare strings that have no timezone indicator
  const hasZone =
    ts.endsWith('Z') ||
    ts.includes('+') ||
    /T.*-\d{2}:\d{2}$/.test(ts);
  return hasZone
    ? new Date(ts).getTime()
    : new Date(ts.replace(' ', 'T') + 'Z').getTime();
}

/**
 * Get the daily reset timestamp for a patient in their local timezone.
 */
export function getDailyResetTime(
  date: Date,
  resetHour: number,
  timezoneOffsetMinutes: number
): Date {
  return _getDailyResetTime(date, resetHour, timezoneOffsetMinutes);
}

/**
 * Get the most recent past reset time (yesterday's reset if before today's reset hour).
 * Re-exported so callers can compute the same daily boundary used here.
 */
export function getLastResetTime(
  date: Date,
  resetHour: number,
  timezoneOffsetMinutes: number
): Date {
  return _getLastResetTime(date, resetHour, timezoneOffsetMinutes);
}

/**
 * Get the NEXT upcoming reset time — used to cap Phase 3 persist-at-100%
 * so that events from the current window don't bleed into the next day.
 */
function getNextResetTimeMs(currentTime: Date, resetHour: number, tzOffsetMinutes: number): number {
  const lastResetMs = _getLastResetTime(currentTime, resetHour, tzOffsetMinutes).getTime();
  return lastResetMs + 24 * 60 * 60 * 1000;
}

/**
 * Calculate the cumulative BG elevation from a single meal since today's reset.
 *
 * ─── Phase 3 (persist-at-100%) FIX ───────────────────────────────────────────
 * When a meal has fully absorbed (hours-since >= duration) its effect is held at
 * `totalCarbs × carb_to_bg_factor` until the daily reset — matching backend
 * pharmacodynamics.py lines 707-710 ("THIS IS THE CRITICAL FIX").
 *
 * Returns 0 if the meal was eaten before today's reset.
 *
 * @returns Cumulative BG elevation in mg/dL (>= 0)
 */
export function calculateMealCumulativeEffect(
  meal: Meal,
  currentTime: Date,
  patientConstants: PatientConstants,
  absorptionProfiles: Record<string, PharmacodynamicProfile | MealAbsorptionProfile>,
  resetHour: number = 7,
  timezoneOffsetMinutes: number = 0
): number {
  // Parse meal timestamp as UTC
  const mealMs = parseUTCMs((meal as any).timestamp);
  if (isNaN(mealMs)) return 0;

  // Skip future meals
  if (mealMs > currentTime.getTime()) return 0;

  // ── CRITICAL: Check daily reset BEFORE Phase 3 ────────────────────────────
  // Phase 3 (persist-at-100%) must NOT apply to meals from before today's reset.
  // The base _calculateMealCumulativeEffect performs this check in Phases 1 & 2,
  // but we short-circuit to Phase 3 before calling it. Without this guard, a meal
  // eaten before the daily reset hour that has fully absorbed would be included
  // in the current day's cumulative effect — the bank balance would never reset.
  const lastResetMs = _getLastResetTime(currentTime, resetHour, timezoneOffsetMinutes).getTime();
  if (mealMs < lastResetMs) return 0;

  // Determine absorption duration for this meal
  const absType: string =
    (meal as any).calculation_summary?.absorption_type ??
    (meal as any).nutrition?.absorption_type ??
    (meal as any).nutrition?.absorptionType ??
    'medium';
  const profile: any =
    (absorptionProfiles as any)[absType] ??
    (absorptionProfiles as any)['medium'];
  const durationHours: number =
    profile?.durationHours ?? profile?.duration_hours ?? 4.0;

  const hoursSince = (currentTime.getTime() - mealMs) / (1000 * 60 * 60);

  // ── Phase 3: After absorption completes — PERSIST at full effect ─────────
  // Matches backend pharmacodynamics.py:
  //   if current_time >= end_time:
  //     return total_carbs * carb_to_bg_factor  # PERSISTS until next reset
  // CRITICAL: also cap at the next reset so meals from the current window
  // don't persist into the following day.
  if (hoursSince >= durationHours) {
    const nextResetMs = getNextResetTimeMs(currentTime, resetHour, timezoneOffsetMinutes);
    if (mealMs >= lastResetMs && mealMs < nextResetMs) {
      // ✅ FIX: Extended carb-field fallback chain covering all meal shapes:
      //   • meal.carbEquiv         — set by processContextMealsForChart (doctor chart path)
      //   • calculation_summary    — set by backend for patient chart path
      //   • nutrition.*            — various field name variants
      // Without meal.carbEquiv, processed meals (doctor chart) returned 0 for
      // Phase 3, keeping the green cumulative line flat at 0 for fully-absorbed
      // meals even though the orange meal-effect area was correct.
      const rawNutrition: any = (meal as any).nutrition ?? {};
      const totalCarbs: number =
        (meal as any).carbEquiv                              ??  // processContextMealsForChart
        (meal as any).calculation_summary?.total_carb_equiv  ??
        rawNutrition.total_carb_equiv                        ??
        rawNutrition.totalCarbEquiv                          ??
        rawNutrition.totalCarbs                              ??
        rawNutrition.carbs                                   ??
        0;
      const carbToBGFactor: number =
        (patientConstants as any).carb_to_bg_factor ??
        (patientConstants as any).carb_to_bg_ratio ??
        4.0;
      if (totalCarbs <= 0) return 0;
      return totalCarbs * carbToBGFactor;
    }
    return 0;
  }

  // ── Phase 1 & 2: Delegate to original (handles reset-window check + partial absorption)
  return _calculateMealCumulativeEffect(
    meal,
    currentTime,
    patientConstants,
    absorptionProfiles,
    resetHour,
    timezoneOffsetMinutes
  );
}

/**
 * Calculate the cumulative BG reduction from a single insulin dose since today's reset.
 *
 * ─── Phase 3 (persist-at-100%) FIX ───────────────────────────────────────────
 * When a dose has fully absorbed (hours-since >= duration) its effect is held at
 * `-(dose × correction_factor)` until the daily reset — matching backend
 * pharmacodynamics.py lines 778-781.
 *
 * Returns 0 if the dose was administered before today's reset.
 * The returned value is <= 0 (negative = glucose-lowering).
 *
 * @returns Cumulative BG reduction in mg/dL (<= 0)
 */
export function calculateInsulinCumulativeEffect(
  dose: InsulinDose,
  currentTime: Date,
  patientConstants: PatientConstants,
  resetHour: number = 7,
  timezoneOffsetMinutes: number = 0
): number {
  // Parse dose timestamp as UTC
  const rawTs: string | undefined =
    (dose as any).administrationTime ??
    (dose as any).taken_at ??
    (dose as any).takenAt;
  const doseMs = parseUTCMs(rawTs);
  if (isNaN(doseMs)) return 0;

  // Skip future doses
  if (doseMs > currentTime.getTime()) return 0;

  // ── CRITICAL: Check daily reset BEFORE Phase 3 ────────────────────────────
  // Phase 3 (persist-at-100%) must NOT apply to doses from before today's reset.
  // The base _calculateInsulinCumulativeEffect performs this check in Phases 1 & 2,
  // but we short-circuit to Phase 3 before calling it. Without this guard, a dose
  // given before the daily reset hour that has fully absorbed would be included
  // in the current day's cumulative insulin effect — the bank balance would
  // never reset and yesterday's insulin would keep suppressing today's BG estimate.
  const lastResetMs = _getLastResetTime(currentTime, resetHour, timezoneOffsetMinutes).getTime();
  if (doseMs < lastResetMs) return 0;

  // Determine PK duration for this insulin type
  const insulinType: string =
    (dose as any).insulinType ??
    (dose as any).medication ??
    'regular_insulin';
  const medicationFactors: Record<string, any> =
    (patientConstants as any).medication_factors ?? {};
  const profile: any = medicationFactors[insulinType] ?? {};
  const durationHours: number =
    profile?.durationHours ?? profile?.duration_hours ?? 4.0;

  const hoursSince = (currentTime.getTime() - doseMs) / (1000 * 60 * 60);

  // ── Phase 3: After absorption completes — PERSIST at full BG reduction ───
  // Matches backend pharmacodynamics.py:
  //   if current_time >= end_time:
  //     return -(dose_amount * correction_factor)  # PERSISTS until next reset
  // CRITICAL: also cap at the next reset so doses from the current window
  // don't persist into the following day.
  if (hoursSince >= durationHours) {
    const nextResetMs = getNextResetTimeMs(currentTime, resetHour, timezoneOffsetMinutes);
    if (doseMs >= lastResetMs && doseMs < nextResetMs) {
      const doseAmount: number =
        (dose as any).units ?? (dose as any).dose ?? 0;
      const correctionFactor: number =
        (patientConstants as any).correction_factor ?? 50;
      if (doseAmount <= 0) return 0;
      return -(doseAmount * correctionFactor); // negative = BG reduction
    }
    return 0;
  }

  // ── Phase 1 & 2: Delegate to original (handles reset-window check + partial absorption)
  return _calculateInsulinCumulativeEffect(
    dose,
    currentTime,
    patientConstants,
    resetHour,
    timezoneOffsetMinutes
  );
}

/**
 * Calculate total cumulative effects from all meals and insulin doses.
 *
 * ─── v4.4 FIX ────────────────────────────────────────────────────────────────
 * Rewrites the previous delegate-to-`_calculateTotalCumulativeEffects` pattern
 * to call the FIXED `calculateMealCumulativeEffect` and
 * `calculateInsulinCumulativeEffect` above, so all Phase 3 (persist-at-100%)
 * behaviour is applied correctly.
 *
 * This is the "bank balance" model:
 *   cumulativeNetBaseline = cumulativeMealEffect + cumulativeInsulinEffect
 *   (insulin effect is negative, so this is meals − |insulin|)
 *
 * Only events AFTER today's reset are counted (enforced inside the per-item functions).
 *
 * Direct port of:
 *   backend/utils/pharmacodynamics.py::calculate_total_cumulative_effects()
 *
 * @param meals                 - ALL meals in current daily window (including fully absorbed)
 * @param insulinDoses          - ALL doses in current daily window (including fully absorbed)
 * @param currentTime           - Current timestamp
 * @param patientConstants      - Patient constants (carb_to_bg_factor, correction_factor …)
 * @param absorptionProfiles    - Absorption profile map keyed by AbsorptionType
 * @param resetHour             - Daily reset hour 0–23 (default 7)
 * @param timezoneOffsetMinutes - Patient UTC offset in minutes (default 0)
 * @returns Full cumulative effects breakdown
 *
 * @example
 * const cumulative = calculateTotalCumulativeEffects(
 *   allMealsInWindow,  // ALL meals after reset — not just activeMeals!
 *   allDosesInWindow,
 *   new Date(), constants, MEAL_ABSORPTION_PROFILES, 7, -300
 * );
 * console.log(cumulative.cumulativeNetBaseline); // e.g. +180.0 mg/dL
 */
export function calculateTotalCumulativeEffects(
  meals: Meal[],
  insulinDoses: InsulinDose[],
  currentTime: Date,
  patientConstants: PatientConstants,
  absorptionProfiles: Record<string, PharmacodynamicProfile | MealAbsorptionProfile>,
  resetHour: number = 7,
  timezoneOffsetMinutes: number = 0
): CumulativeEffectsResult {
  let cumulativeMealEffect = 0;
  let cumulativeInsulinEffect = 0;
  const mealContributions: any[] = [];
  const insulinContributions: any[] = [];

  for (const meal of meals) {
    const effect = calculateMealCumulativeEffect(
      meal, currentTime, patientConstants, absorptionProfiles, resetHour, timezoneOffsetMinutes
    );
    if (effect > 0) {
      cumulativeMealEffect += effect;
      mealContributions.push({
        mealId: String((meal as any)._id ?? (meal as any).id ?? ''),
        mealTime: (meal as any).timestamp ?? '',
        carbs: (() => {
          const rn: any = (meal as any).nutrition ?? {};
          return (meal as any).carbEquiv ??
            (meal as any).calculation_summary?.total_carb_equiv ??
            rn.total_carb_equiv ?? rn.totalCarbEquiv ?? rn.totalCarbs ?? rn.carbs ?? 0;
        })(),
        bgElevation: Math.round(effect * 10) / 10,
      });
    }
  }

  for (const dose of insulinDoses) {
    const effect = calculateInsulinCumulativeEffect(
      dose, currentTime, patientConstants, resetHour, timezoneOffsetMinutes
    );
    if (effect < 0) {
      cumulativeInsulinEffect += effect;
      insulinContributions.push({
        doseId: String((dose as any)._id ?? (dose as any).id ?? ''),
        takenAt: (dose as any).administrationTime ?? (dose as any).taken_at ?? '',
        dose: (dose as any).units ?? (dose as any).dose ?? 0,
        bgReduction: Math.round(effect * 10) / 10,
      });
    }
  }

  // insulin effect is already negative → addition gives: meals − |insulin|
  const cumulativeNetBaseline = cumulativeMealEffect + cumulativeInsulinEffect;

  const nextReset = getDailyResetTime(
    new Date(currentTime.getTime() + 24 * 60 * 60 * 1000),
    resetHour,
    timezoneOffsetMinutes
  );

  return {
    cumulativeMealEffect: Math.round(cumulativeMealEffect * 10) / 10,
    cumulativeInsulinEffect: Math.round(cumulativeInsulinEffect * 10) / 10,
    cumulativeNetBaseline: Math.round(cumulativeNetBaseline * 10) / 10,
    mealContributions,
    insulinContributions,
    resetHour,
    calculationTime: currentTime.toISOString(),
    nextReset: nextReset.toISOString(),
  } as CumulativeEffectsResult;
}