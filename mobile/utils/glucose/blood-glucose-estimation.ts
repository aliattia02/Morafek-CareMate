/**
 * Blood Glucose Estimation and Prediction Logic
 * Enhanced with Cumulative Effects, Baseline Calculation, and Net Effect Integration
 *
 * @module utils/glucose/blood-glucose-estimation
 * @version 5.0 - Complete T1D Model with Cumulative Tracking
 */

import type {
  MealNutrition,
  AbsorptionType,
  MealFoodEntry,
  CarbEquivalentsResult,
  Meal
} from '@/types/meal.types';
import type {
  PatientConstants,
} from '@/types/constants.types';
import {
  DEFAULT_PATIENT_CONSTANTS,
} from '@/constants/shared-constants';
import type {
  MealAbsorptionProfile,
} from '@/constants/shared-constants';
import type {
  InsulinDose
} from '@/types/insulin.types';
import type {
  GlucoseReading
} from '@/types/glucose.types';
import type {
  PharmacodynamicProfile
} from '@/types/pharmacodynamics.types';
import type {
  NetEffectResult,
  BaselineResult,
  BGEstimation,
  TimelinePoint
} from '@/types/calculation.types';
import type {
  SafetyStatusLevel as SafetyStatus,
  GlucoseTrend
} from '@/types/safety.types';

// Import from existing pharmacodynamics files
import {
  calculateMealActivity as calcMealActivityFromProfile,
  calculateAbsorbedFraction as calcMealAbsorbedFraction,
  calculateStackedMealEffect,
  getMealAbsorptionProfile,
  getTotalCarbsFromMeal,
  toPharmacodynamicProfile,
  type MealActivityResult,
  type StackedMealResult,
} from './meal-pharmacodynamics';
import {
  calculateInsulinActivity,
  calculateIOB,
  getInsulinProfile as getInsulinPharmacokinetics,
  calculateInsulinBGImpact,
  calculateStackedInsulinEffect,
  type InsulinDoseForStacking,
  type StackedInsulinEffect
} from '../insulin/pharmacodynamics';
import { calculateCarbEquivalents } from './carb-equivalents';
import {
  generateMealImpactCurve,
  getAbsorptionDescription,
  type MealImpactPoint
} from './meal-impact-curves';
import TimeManager from '../time/TimeManager';

/**
 * ============================================================================
 * CONSTANTS & TYPE ALIASES
 * ============================================================================
 */

const DEFAULT_CARB_TO_BG_FACTOR = 4.0;
const DEFAULT_CORRECTION_FACTOR = 40;
const DEFAULT_TARGET_GLUCOSE = 100;
const DEFAULT_DAILY_RESET_HOUR = 7;

/**
 * Absorption profiles can be in either snake_case (MealAbsorptionProfile from constants)
 * or camelCase (PharmacodynamicProfile). This union type covers both.
 */
type AbsorptionProfileMap = Record<string, PharmacodynamicProfile | MealAbsorptionProfile>;

/**
 * ============================================================================
 * 🔧 DATA STRUCTURE COMPATIBILITY HELPERS
 * Handle variations between API response and expected structure
 * ============================================================================
 */

/**
 * Get total carbs from meal (handles calculation_summary, nutrition, and foodItems)
 * Delegates to getTotalCarbsFromMeal for consistent carb extraction
 */
function getMealTotalCarbs(meal: Meal): number {
  return getTotalCarbsFromMeal(meal);
}

/**
 * Get absorption type from meal
 */
function getMealAbsorptionType(meal: Meal): AbsorptionType {
  return (
    meal.calculation_summary?.absorption_type ||
    meal.nutrition?.absorption_type ||
    meal.nutrition?.absorptionType ||
    'medium' as AbsorptionType
  );
}

/**
 * UTC-safe timestamp parser.
 *
 * The backend stores all timestamps in UTC but frequently omits the 'Z' suffix
 * (e.g. "2026-02-13T22:38:00").  `new Date(bareString)` treats those as LOCAL
 * time in most browsers, shifting the parsed value by ±hours equal to the user's
 * UTC offset — the same bug fixed in TimeManager.ts parseTimestampRaw (v4.3).
 *
 * This function appends 'Z' when no timezone indicator is present so the result
 * is always the correct UTC millisecond value.
 */
function parseUTCDate(ts: string | number | null | undefined): Date {
  if (ts === null || ts === undefined) return new Date(NaN);
  if (typeof ts === 'number') return new Date(ts);
  const hasZone = ts.endsWith('Z') || ts.includes('+') || /T.*-\d{2}:\d{2}$/.test(ts);
  return hasZone ? new Date(ts) : new Date(ts.replace(' ', 'T') + 'Z');
}

/**
 * Get timestamp from meal (handles both number and string, UTC-safe)
 */
function getMealTimestamp(meal: Meal): Date {
  // Resolve all backend timestamp aliases in addition to the UTC fix
  const rawTs = (meal as any).timestamp ??
                (meal as any).meal_time ??
                (meal as any).logged_at ??
                (meal as any).created_at ??
                null;
  return parseUTCDate(rawTs);
}

/**
 * Get timestamp from insulin dose (UTC-safe)
 */
function getDoseTimestamp(dose: InsulinDose): Date {
  const timestamp = (dose as any).administrationTime ??
                    (dose as any).taken_at ??
                    (dose as any).takenAt ??
                    (dose as any).timestamp ??
                    null;
  if (!timestamp) {
    throw new Error(`Insulin dose ${dose.id} missing timestamp`);
  }
  return parseUTCDate(timestamp);
}

/**
 * Get medication name from dose
 */
function getDoseMedication(dose: InsulinDose): string {
  return dose.medication || dose.insulinType || 'insulin_aspart';
}

/**
 * ============================================================================
 * UNIFIED MEAL IMPACT (EXISTING - KEEP AS IS)
 * ============================================================================
 */

export interface UnifiedMealImpact {
  carbEquivalents: CarbEquivalentsResult;
  baseInsulin: number;
  adjustedInsulin: number;
  peakBgImpact: number;
  calculationSummary: {
    base_insulin: number;
    adjustment_factors: {
      absorption_rate: number;
      meal_timing: number;
    };
    meal_only_suggested_insulin: number;
    absorption_type: AbsorptionType;
    absorption_metadata: {
      weighted_type: AbsorptionType;
      patient_modifier: number;
      original_factor: number;
    };
  };
  absorptionProfile: {
    type: AbsorptionType;
    factor: number;
    description: string;
    patientModified: boolean;
  };
  timeCurve?: MealImpactPoint[];
}

export interface MealImpactOptions {
  includeTimeCurve?: boolean;
  durationHours?: number;
  timeInterval?: number;
  currentTime?: Date;
}

export interface MealData {
  id?: string;
  timestamp?: number;
  mealType?: string;
  nutrition?: Partial<MealNutrition>;
  foodItems?: MealFoodEntry[];
  calculation_summary?: {
    absorption_type?: AbsorptionType;
    total_carb_equiv?: number;
    adjustment_factors?: {
      absorption_rate?: number;
    };
    [key: string]: any;
  };
}

export function calculateWeightedAbsorptionType(foodItems: MealFoodEntry[]): AbsorptionType {
  if (!foodItems || foodItems.length === 0) return 'medium';

  const absorptionValues: Record<AbsorptionType, number> = {
    very_fast: 5,
    fast: 4,
    medium: 3,
    slow: 2,
    very_slow: 1,
  };

  const reverseMap: Record<number, AbsorptionType> = {
    5: 'very_fast',
    4: 'fast',
    3: 'medium',
    2: 'slow',
    1: 'very_slow',
  };

  let totalWeight = 0;
  let weightedSum = 0;

  foodItems.forEach((item) => {
    const details = item.details || {};
    const absorptionType = details.absorption_type || 'medium';
    const carbs = details.carbs || 0;

    if (carbs > 0) {
      const absorptionValue = absorptionValues[absorptionType] || 3;
      weightedSum += absorptionValue * carbs;
      totalWeight += carbs;
    }
  });

  if (totalWeight === 0) return 'medium';

  const averageValue = Math.round(weightedSum / totalWeight);
  return reverseMap[averageValue] || 'medium';
}

export function calculateUnifiedMealImpact(
  mealData: MealData | null | undefined,
  patientConstants: Partial<PatientConstants> | undefined,
  options: MealImpactOptions = {}
): UnifiedMealImpact {
  const {
    includeTimeCurve = false,
    durationHours = 6,
    timeInterval = 5,
    currentTime = new Date(),
  } = options;

  if (!mealData || !patientConstants) {
    return createEmptyMealImpact();
  }

  try {
    const nutrition = mealData.nutrition || {};
    const mealType = mealData.mealType || 'normal';

    let absorptionType: AbsorptionType = 'medium';

    if (mealData.calculation_summary?.absorption_type) {
      absorptionType = mealData.calculation_summary.absorption_type;
    } else if (nutrition.absorptionType || (nutrition as any).absorption_type) {
      absorptionType = (nutrition.absorptionType || (nutrition as any).absorption_type) as AbsorptionType;
    } else if (mealData.foodItems && Array.isArray(mealData.foodItems) && mealData.foodItems.length > 1) {
      absorptionType = calculateWeightedAbsorptionType(mealData.foodItems);
    }

    const constants = { ...(DEFAULT_PATIENT_CONSTANTS as any), ...patientConstants };
    const absorptionModifiers = constants.absorption_modifiers || {
      very_fast: 1.4,
      fast: 1.2,
      medium: 1.0,
      slow: 0.8,
      very_slow: 0.6,
    };

    const patientAbsorptionFactor = absorptionModifiers[absorptionType] || 1.0;
    const carbEquivalents = calculateCarbEquivalents(nutrition, constants);

    const mealTimingFactors = constants.meal_timing_factors || {
      breakfast: 1.0,
      lunch: 1.0,
      dinner: 1.0,
      snack: 1.0,
    };
    const mealTimingFactor = mealTimingFactors[mealType as keyof typeof mealTimingFactors] || 1.0;

    const insulinToCarbRatio = constants.insulin_to_carb_ratio || 10;
    const baseInsulin = carbEquivalents.totalCarbEquiv / insulinToCarbRatio;
    const adjustedInsulin = baseInsulin * patientAbsorptionFactor * mealTimingFactor;

    const carbToBgFactor = constants.carb_to_bg_factor || 4.0;
    const peakBgImpact = carbEquivalents.totalCarbEquiv * carbToBgFactor * patientAbsorptionFactor;

    const calculationSummary = {
      base_insulin: baseInsulin,
      adjustment_factors: {
        absorption_rate: patientAbsorptionFactor,
        meal_timing: mealTimingFactor,
      },
      meal_only_suggested_insulin: adjustedInsulin,
      absorption_type: absorptionType,
      absorption_metadata: {
        weighted_type: absorptionType,
        patient_modifier: patientAbsorptionFactor,
        original_factor: absorptionModifiers[absorptionType] || 1.0,
      },
    };

    const absorptionProfile = {
      type: absorptionType,
      factor: patientAbsorptionFactor,
      description: getAbsorptionDescription(absorptionType),
      patientModified: patientAbsorptionFactor !== 1.0,
    };

    let timeCurve: MealImpactPoint[] | undefined;
    if (includeTimeCurve) {
      timeCurve = generateMealImpactCurve(
        carbEquivalents.totalCarbEquiv,
        absorptionType,
        mealData.timestamp || currentTime.getTime(),
        durationHours,
        timeInterval,
        carbToBgFactor,
        patientAbsorptionFactor,
        constants as any
      );
    }

    return {
      carbEquivalents,
      baseInsulin,
      adjustedInsulin,
      peakBgImpact,
      calculationSummary,
      absorptionProfile,
      timeCurve,
    };
  } catch (error) {
    return createEmptyMealImpact();
  }
}

function createEmptyMealImpact(): UnifiedMealImpact {
  return {
    carbEquivalents: {
      totalCarbEquiv: 0,
      carbsActual: 0,
      proteinCarbEquiv: 0,
      fatCarbEquiv: 0,
      fiberReduction: 0,
    },
    baseInsulin: 0,
    adjustedInsulin: 0,
    peakBgImpact: 0,
    calculationSummary: {
      base_insulin: 0,
      adjustment_factors: {
        absorption_rate: 1.0,
        meal_timing: 1.0,
      },
      meal_only_suggested_insulin: 0,
      absorption_type: 'medium',
      absorption_metadata: {
        weighted_type: 'medium',
        patient_modifier: 1.0,
        original_factor: 1.0,
      },
    },
    absorptionProfile: {
      type: 'medium',
      factor: 1.0,
      description: 'Mixed meals, whole grains',
      patientModified: false,
    },
  };
}

/**
 * ============================================================================
 * CUMULATIVE EFFECTS CALCULATION (NEW - T1D MODEL)
 * ============================================================================
 */

export interface CumulativeEffectsResult {
  cumulativeMealEffect: number;
  cumulativeInsulinEffect: number;
  cumulativeNetBaseline: number;
  mealContributions: Array<{
    mealId: string;
    mealTime: string;
    mealType: string;
    totalCarbs: number;
    cumulativeBgEffect: number;
  }>;
  insulinContributions: Array<{
    doseId: string;
    doseTime: string;
    medication: string;
    dose: number;
    cumulativeBgEffect: number;
  }>;
  resetHour: number;
  calculationTime: string;
  nextReset: string;
}

/**
 * Get daily reset time in patient's timezone
 */
export function getDailyResetTime(
  date: Date,
  resetHour: number,
  timezoneOffsetMinutes: number
): Date {
  const utcMidnight = new Date(date);
  utcMidnight.setUTCHours(0, 0, 0, 0);

  const patientMidnight = new Date(utcMidnight.getTime() - timezoneOffsetMinutes * 60 * 1000);
  const resetTime = new Date(patientMidnight.getTime() + resetHour * 60 * 60 * 1000);

  return resetTime;
}

/**
 * Get the most recent past reset time
 * If current time is before reset hour, returns yesterday's reset
 * If current time is after reset hour, returns today's reset
 *
 * Example with reset at 7 AM:
 * - Current: 12:40 AM Feb 14 → Returns: 7:00 AM Feb 13 (yesterday)
 * - Current: 8:00 AM Feb 14  → Returns: 7:00 AM Feb 14 (today)
 */
export function getLastResetTime(
  date: Date,
  resetHour: number,
  timezoneOffsetMinutes: number
): Date {
  // Get today's reset time
  const todayReset = getDailyResetTime(date, resetHour, timezoneOffsetMinutes);

  // If current time is before today's reset, use yesterday's reset
  if (date < todayReset) {
    const yesterday = new Date(date.getTime() - 24 * 60 * 60 * 1000);
    return getDailyResetTime(yesterday, resetHour, timezoneOffsetMinutes);
  }

  // Otherwise use today's reset
  return todayReset;
}

/**
 * Get the NEXT upcoming reset time.
 * Used to cap Phase 3 persist-at-100% so that fully-absorbed doses/meals
 * from a previous window are not carried into the current window.
 */
function getNextResetTime(
  date: Date,
  resetHour: number,
  timezoneOffsetMinutes: number
): Date {
  const lastReset = getLastResetTime(date, resetHour, timezoneOffsetMinutes);
  return new Date(lastReset.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Calculate meal cumulative effect (absorbed carbs → BG elevation)
 * Direct port of: pharmacodynamics.py::calculate_meal_cumulative_effect()
 */
export function calculateMealCumulativeEffect(
  meal: Meal,
  currentTime: Date,
  patientConstants: PatientConstants,
  absorptionProfiles: AbsorptionProfileMap,
  resetHour: number,
  timezoneOffsetMinutes: number
): number {
  const mealTime = getMealTimestamp(meal);
  const lastReset = getLastResetTime(currentTime, resetHour, timezoneOffsetMinutes);

  // Only include meals AFTER the most recent reset
  if (mealTime < lastReset) {
    return 0;
  }

  // Before meal starts
  if (currentTime < mealTime) {
    return 0;
  }

  const hoursSinceMeal = (currentTime.getTime() - mealTime.getTime()) / (1000 * 60 * 60);

  const absorptionType = getMealAbsorptionType(meal);
  const rawProfile = absorptionProfiles[absorptionType];

  if (!rawProfile) {
    // Fallback: full absorption
    const totalCarbs = getMealTotalCarbs(meal);
    const carbToBgFactor = patientConstants.carb_to_bg_factor || DEFAULT_CARB_TO_BG_FACTOR;
    return totalCarbs * carbToBgFactor;
  }

  // Convert snake_case profile to camelCase PharmacodynamicProfile
  const profile = toPharmacodynamicProfile(rawProfile);

  // Get total carbs (with foodItems fallback)
  const totalCarbs = getMealTotalCarbs(meal);
  if (totalCarbs <= 0) {
    return 0;
  }

  const carbToBgFactor = patientConstants.carb_to_bg_factor || DEFAULT_CARB_TO_BG_FACTOR;

  // After absorption completes: PERSIST at 100% until the NEXT daily reset (matches backend).
  // CRITICAL: cap at next reset so meals from a previous window don't bleed into the
  // current one. Also fix boundary: backend uses >= (not >).
  if (hoursSinceMeal >= profile.durationHours) {
    const nextResetMs = getNextResetTime(currentTime, resetHour, timezoneOffsetMinutes).getTime();
    const mealTimeMs  = mealTime.getTime();
    if (mealTimeMs >= lastReset.getTime() && mealTimeMs < nextResetMs) {
      return totalCarbs * carbToBgFactor;
    }
    return 0;
  }

  // During absorption
  const absorbedFraction = calcMealAbsorbedFraction(hoursSinceMeal, profile);
  const absorbedCarbs = totalCarbs * Math.min(absorbedFraction, 1.0);

  return absorbedCarbs * carbToBgFactor;
}

/**
 * Calculate insulin cumulative effect (absorbed insulin → BG reduction)
 * Direct port of: pharmacodynamics.py::calculate_insulin_cumulative_effect()
 *
 * Uses absorption fraction = 1.0 - IOB_fraction, matching backend logic.
 */
export function calculateInsulinCumulativeEffect(
  dose: InsulinDose,
  currentTime: Date,
  patientConstants: PatientConstants,
  resetHour: number,
  timezoneOffsetMinutes: number
): number {
  const doseTime = getDoseTimestamp(dose);
  const lastReset = getLastResetTime(currentTime, resetHour, timezoneOffsetMinutes);

  // Only include doses AFTER the most recent reset
  if (doseTime < lastReset) {
    return 0;
  }

  // Before dose starts
  if (currentTime < doseTime) {
    return 0;
  }

  const hoursSinceDose = (currentTime.getTime() - doseTime.getTime()) / (1000 * 60 * 60);

  const medication = getDoseMedication(dose);
  const profile = getInsulinPharmacokinetics(medication);

  if (!profile) {
    console.warn(`[calculateInsulinCumulativeEffect] No profile found for ${medication}`);
    return 0;
  }

  const doseAmount = dose.dose || 0;
  if (doseAmount <= 0) {
    return 0;
  }

  const correctionFactor = patientConstants.correction_factor || DEFAULT_CORRECTION_FACTOR;

  // After duration: PERSIST at 100% absorption until the NEXT daily reset (matches backend).
  // CRITICAL: Without this cap a fully-absorbed dose from the current window keeps
  // contributing -(dose × CF) even after the reset, producing the observed ghost
  // -200 mg/dL effect. Also fix boundary: backend uses >= (not >).
  if (hoursSinceDose >= profile.duration_hours) {
    const nextResetMs = getNextResetTime(currentTime, resetHour, timezoneOffsetMinutes).getTime();
    const doseTimeMs  = doseTime.getTime();
    if (doseTimeMs >= lastReset.getTime() && doseTimeMs < nextResetMs) {
      return -(doseAmount * correctionFactor);
    }
    return 0;
  }

  // During absorption: use absorption fraction = 1.0 - IOB_fraction
  const iobFraction = calculateIOB(hoursSinceDose, 1.0, profile);
  const absorptionFraction = 1.0 - iobFraction;
  const effect = -(doseAmount * absorptionFraction * correctionFactor);

  return effect;
}

/**
 * Calculate total cumulative effects from all meals and insulin doses
 * Direct port of: pharmacodynamics.py::calculate_total_cumulative_effects()
 */
export function calculateTotalCumulativeEffects(
  meals: Meal[],
  insulinDoses: InsulinDose[],
  currentTime: Date,
  patientConstants: PatientConstants,
  absorptionProfiles: AbsorptionProfileMap,
  resetHour: number = DEFAULT_DAILY_RESET_HOUR,
  timezoneOffsetMinutes: number = 0
): CumulativeEffectsResult {
  // 🔍 DEBUG: Log cumulative calculation start
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔍 [calculateTotalCumulativeEffects] START');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('[calculateTotalCumulativeEffects] Parameters:', {
    mealsCount: meals.length,
    insulinDosesCount: insulinDoses.length,
    currentTime: currentTime.toISOString(),
    resetHour,
    timezoneOffsetMinutes,
    correctionFactor: patientConstants.correction_factor,
  });

  const lastReset = getLastResetTime(currentTime, resetHour, timezoneOffsetMinutes);
  console.log('[calculateTotalCumulativeEffects] Last reset time:', lastReset.toISOString());

  let cumulativeMealEffect = 0;
  let cumulativeInsulinEffect = 0;
  const mealContributions: any[] = [];
  const insulinContributions: any[] = [];

  for (const meal of meals) {
    const totalCarbs = getMealTotalCarbs(meal);

    const mealEffect = calculateMealCumulativeEffect(
      meal,
      currentTime,
      patientConstants,
      absorptionProfiles,
      resetHour,
      timezoneOffsetMinutes
    );

    if (mealEffect > 0) {
      cumulativeMealEffect += mealEffect;

      const mealTime = getMealTimestamp(meal);
      // totalCarbs already calculated above

      mealContributions.push({
        mealId: meal.id || String((meal as any)._id),
        mealTime: mealTime.toISOString(),
        mealType: meal.mealType || 'unknown',
        totalCarbs: Math.round(totalCarbs * 10) / 10,
        cumulativeBgEffect: Math.round(mealEffect * 10) / 10,
      });
    }
  }

  for (const dose of insulinDoses) {
    const insulinEffect = calculateInsulinCumulativeEffect(
      dose,
      currentTime,
      patientConstants,
      resetHour,
      timezoneOffsetMinutes
    );

    if (insulinEffect < 0) {
      cumulativeInsulinEffect += insulinEffect;

      const doseTime = getDoseTimestamp(dose);

      insulinContributions.push({
        doseId: dose.id || String((dose as any)._id),
        doseTime: doseTime.toISOString(),
        medication: getDoseMedication(dose),
        dose: Math.round(dose.dose * 100) / 100,
        cumulativeBgEffect: Math.round(insulinEffect * 10) / 10,
      });
    }
  }

  const cumulativeNetBaseline = cumulativeMealEffect + cumulativeInsulinEffect;

  const nextResetDate = new Date(currentTime.getTime() + 24 * 60 * 60 * 1000);

  // 🔍 DEBUG: Enhanced final results logging
  console.log('[calculateTotalCumulativeEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('[calculateTotalCumulativeEffects] FINAL RESULTS:');
  console.log('[calculateTotalCumulativeEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('[calculateTotalCumulativeEffects]   Meal Contributions:', mealContributions.length);
  console.log('[calculateTotalCumulativeEffects]   Total Meal Effect:', cumulativeMealEffect.toFixed(1), 'mg/dL');
  console.log('[calculateTotalCumulativeEffects]   Insulin Contributions:', insulinContributions.length);
  console.log('[calculateTotalCumulativeEffects]   Total Insulin Effect:', cumulativeInsulinEffect.toFixed(1), 'mg/dL');
  console.log('[calculateTotalCumulativeEffects]   Net Baseline:', cumulativeNetBaseline.toFixed(1), 'mg/dL');

  if (insulinContributions.length > 0) {
    console.log('[calculateTotalCumulativeEffects]   Insulin Details:',
      insulinContributions.map(c => `${c.doseId}: ${c.dose}u → ${c.cumulativeBgEffect} mg/dL`).join(', ')
    );
  } else {
    console.warn('[calculateTotalCumulativeEffects]   ⚠️ NO insulin contributions! (All doses filtered out or zero effect)');
  }
  console.log('[calculateTotalCumulativeEffects] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔍 [calculateTotalCumulativeEffects] END');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  return {
    cumulativeMealEffect: Math.round(cumulativeMealEffect * 10) / 10,
    cumulativeInsulinEffect: Math.round(cumulativeInsulinEffect * 10) / 10,
    cumulativeNetBaseline: Math.round(cumulativeNetBaseline * 10) / 10,
    mealContributions,
    insulinContributions,
    resetHour,
    calculationTime: currentTime.toISOString(),
    nextReset: getDailyResetTime(nextResetDate, resetHour, timezoneOffsetMinutes).toISOString(),
  };
}

/**
 * ============================================================================
 * BASELINE CALCULATION FROM READING (NEW)
 * ============================================================================
 */

/**
 * Calculate stable baseline from blood glucose reading
 * Direct port of: pharmacodynamics.py::calculate_stable_baseline_from_reading()
 *
 * Formula: Baseline = Reading - (Cumulative Meal Effect - Cumulative Insulin Effect)
 *
 * CRITICAL: Only includes meals/insulin that occurred BEFORE reading time
 */
export function calculateStableBaselineFromReading(
  reading: GlucoseReading,
  meals: Meal[],
  insulinDoses: InsulinDose[],
  currentTime: Date,
  patientConstants: PatientConstants,
  absorptionProfiles: AbsorptionProfileMap,
  resetHour: number = DEFAULT_DAILY_RESET_HOUR,
  timezoneOffsetMinutes: number = 0
): BaselineResult {
  const readingValue = reading.value ?? (reading as any).bloodSugar ?? NaN;
  const readingTimestamp = parseUTCDate(reading.timestamp as any);

  const mealsBeforeReading = meals.filter(m => getMealTimestamp(m) <= readingTimestamp);
  const dosesBeforeReading = insulinDoses.filter(d => getDoseTimestamp(d) <= readingTimestamp);

  let cumulativeMealEffect = 0;
  let cumulativeInsulinEffect = 0;
  const mealsAtReading: any[] = [];
  const insulinAtReading: any[] = [];

  const lastReset = getLastResetTime(readingTimestamp, resetHour, timezoneOffsetMinutes);

  for (const meal of mealsBeforeReading) {
    const mealTime = getMealTimestamp(meal);

    // Only include meals AFTER the most recent reset
    if (mealTime < lastReset) continue;

    const hoursSinceMeal = (readingTimestamp.getTime() - mealTime.getTime()) / (1000 * 60 * 60);

    // Skip meals that occurred AFTER the reading (matches backend)
    if (hoursSinceMeal < 0) continue;

    const absorptionType = getMealAbsorptionType(meal);
    const rawProfile = absorptionProfiles[absorptionType];

    if (!rawProfile) continue;

    // Convert profile to camelCase
    const profile = toPharmacodynamicProfile(rawProfile);

    // Get total carbs with foodItems fallback
    const totalCarbEquiv = getTotalCarbsFromMeal(
      meal,
      patientConstants.protein_factor,
      patientConstants.fat_factor
    );

    if (totalCarbEquiv <= 0) continue;

    let absorbedFraction: number;
    let absorbedCarbs: number;

    if (hoursSinceMeal > profile.durationHours) {
      absorbedFraction = 1.0;
      absorbedCarbs = totalCarbEquiv;
    } else {
      absorbedFraction = calcMealAbsorbedFraction(hoursSinceMeal, profile);
      absorbedCarbs = totalCarbEquiv * absorbedFraction;
    }

    const carbToBgFactor = patientConstants.carb_to_bg_factor || DEFAULT_CARB_TO_BG_FACTOR;
    const bgEffect = absorbedCarbs * carbToBgFactor;

    cumulativeMealEffect += bgEffect;
    mealsAtReading.push({
      mealId: meal.id || String((meal as any)._id),
      mealType: meal.mealType || 'unknown',
      totalCarbs: Math.round(totalCarbEquiv * 10) / 10,
      absorbedCarbs: Math.round(absorbedCarbs * 10) / 10,
      bgEffect: Math.round(bgEffect * 10) / 10,
      absorbedFraction: Math.round(absorbedFraction * 1000) / 1000,
    });
  }

  for (const dose of dosesBeforeReading) {
    const doseTime = getDoseTimestamp(dose);

    // Only include doses AFTER the most recent reset
    if (doseTime < lastReset) continue;

    const hoursSinceDose = (readingTimestamp.getTime() - doseTime.getTime()) / (1000 * 60 * 60);

    // Skip doses that occurred AFTER the reading (matches backend)
    if (hoursSinceDose < 0) continue;

    const medication = dose.medication || 'insulin_aspart';
    const profile = getInsulinPharmacokinetics(medication);

    if (!profile) continue;

    const doseAmount = dose.dose || 0;
    if (doseAmount <= 0) continue;

    let absorbedFraction: number;
    let absorbedInsulin: number;

    if (hoursSinceDose > profile.duration_hours) {
      absorbedFraction = 1.0;
      absorbedInsulin = doseAmount;
    } else {
      // Use absorption fraction = 1.0 - IOB_fraction (matches backend)
      const iobFraction = calculateIOB(hoursSinceDose, 1.0, profile);
      absorbedFraction = 1.0 - iobFraction;
      absorbedInsulin = doseAmount * absorbedFraction;
    }

    const correctionFactor = patientConstants.correction_factor || DEFAULT_CORRECTION_FACTOR;
    const bgEffect = absorbedInsulin * correctionFactor;

    cumulativeInsulinEffect += bgEffect;
    insulinAtReading.push({
      doseId: dose.id || String((dose as any)._id),
      medication,
      dose: Math.round(doseAmount * 100) / 100,
      absorbedInsulin: Math.round(absorbedInsulin * 100) / 100,
      bgEffect: Math.round(bgEffect * 10) / 10,
      absorbedFraction: Math.round(absorbedFraction * 1000) / 1000,
    });
  }

  const cumulativeNetEffect = cumulativeMealEffect - cumulativeInsulinEffect;
  const stableBaseline = readingValue - cumulativeNetEffect;

  const warnings: string[] = [];
  if (stableBaseline < 40) {
    warnings.push('Calculated baseline is very low - may indicate reading taken before daily reset period');
  }

  return {
    stableBaseline: Math.round(stableBaseline * 10) / 10,
    readingValue: Math.round(readingValue * 10) / 10,
    readingTimestamp: readingTimestamp.toISOString(),
    cumulativeMealEffect: Math.round(cumulativeMealEffect * 10) / 10,
    cumulativeInsulinEffect: Math.round(cumulativeInsulinEffect * 10) / 10,
    cumulativeNetEffect: Math.round(cumulativeNetEffect * 10) / 10,
    mealsAtReading,
    insulinAtReading,
    mealsCount: mealsAtReading.length,
    insulinCount: insulinAtReading.length,
  };
}

/**
 * ============================================================================
 * NET EFFECT INTEGRATION (NEW)
 * ============================================================================
 */

/**
 * Calculate complete net effect and BG estimation
 * Direct port of cumulative model from backend
 */
export function calculateNetEffect(
  baseline: BaselineResult | null,
  meals: Meal[],
  insulinDoses: InsulinDose[],
  currentTime: Date,
  patientConstants: PatientConstants,
  absorptionProfiles: AbsorptionProfileMap
): NetEffectResult {
  const baselineValue = baseline?.stableBaseline || patientConstants.target_glucose || DEFAULT_TARGET_GLUCOSE;
  const carbToBgFactor = patientConstants.carb_to_bg_factor || DEFAULT_CARB_TO_BG_FACTOR;
  const correctionFactor = patientConstants.correction_factor || DEFAULT_CORRECTION_FACTOR;

  // 🔍 DEBUG: Log input parameters
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔍 [calculateNetEffect] START');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('[calculateNetEffect] Input parameters:', {
    mealsCount: meals.length,
    insulinDosesCount: insulinDoses.length,
    currentTime: currentTime.toISOString(),
    baselineValue,
    carbToBgFactor,
    correctionFactor,
    resetHour: patientConstants.daily_reset_hour || DEFAULT_DAILY_RESET_HOUR,
    timezoneOffset: patientConstants.timezone_offset_minutes || 0,
  });

  // Calculate current MOB effects using the correct API
  const mealEffects = calculateStackedMealEffect(
    meals,
    currentTime,
    patientConstants
  );

  console.log('[calculateNetEffect] Meal effects (MOB):', {
    totalMOB: mealEffects.totalMOB,
    totalBGElevation: mealEffects.totalBGElevation,
    totalPendingRise: mealEffects.totalPendingRise,
  });

  // 🔍 DEBUG: Log insulin doses BEFORE mapping
  console.log('[calculateNetEffect] 💉 Insulin doses BEFORE mapping:', {
    count: insulinDoses.length,
    doses: insulinDoses.map(dose => ({
      id: dose.id,
      dose: dose.dose,
      taken_at: dose.taken_at,
      administrationTime: dose.administrationTime,
      medication: dose.medication,
      insulinType: dose.insulinType,
    }))
  });

  // Map doses for stacking calculation
  const mappedDoses = insulinDoses.map(dose => {
    const timestamp = dose.taken_at || dose.administrationTime;
    const hoursSince = timestamp
      ? (currentTime.getTime() - new Date(timestamp).getTime()) / (1000 * 60 * 60)
      : NaN;

    return {
      dose: dose.dose,
      hoursSinceDose: hoursSince,
      insulinType: dose.medication || dose.insulinType || 'insulin_aspart',
    };
  });

  // 🔍 DEBUG: Log mapped doses
  console.log('[calculateNetEffect] 💉 Mapped doses for stacking:', {
    count: mappedDoses.length,
    doses: mappedDoses.map((d, idx) => ({
      index: idx,
      dose: d.dose,
      hoursSinceDose: d.hoursSinceDose,
      insulinType: d.insulinType,
      isValid: !isNaN(d.hoursSinceDose) && d.dose > 0,
    })),
    correctionFactor,
  });

  // Calculate current IOB effects
  const insulinEffects = calculateStackedInsulinEffect(
    mappedDoses,
    correctionFactor
  );

  // 🔍 DEBUG: Log insulin effects result
  console.log('[calculateNetEffect] 💉 Stacked insulin result (IOB):', {
    totalIOB: insulinEffects.totalIOB,
    totalBGImpact: insulinEffects.totalBGImpact,
    activeDoses: insulinEffects.activeDoses,
    contributions: insulinEffects.contributions?.map(c => ({
      dose: c.dose,
      hoursSinceDose: c.hoursSinceDose,
      iob: c.iob,
      bgImpact: c.bgImpact,
    })),
  });

  // Calculate cumulative effects
  const cumulativeResult = calculateTotalCumulativeEffects(
    meals,
    insulinDoses,
    currentTime,
    patientConstants,
    absorptionProfiles,
    patientConstants.daily_reset_hour || DEFAULT_DAILY_RESET_HOUR,
    patientConstants.timezone_offset_minutes || 0
  );

  const activeMealEffect = mealEffects.totalBGElevation;
  const activeInsulinEffect = insulinEffects.totalBGImpact;
  const currentNetEffect = activeMealEffect - activeInsulinEffect;

  const estimatedBG = baselineValue + cumulativeResult.cumulativeNetBaseline;
  const projectedFinalBG = baselineValue +
                           cumulativeResult.cumulativeNetBaseline +
                           mealEffects.totalPendingRise -
                           insulinEffects.totalBGImpact;

  const safetyStatus = determineSafetyStatus(
    estimatedBG,
    currentNetEffect,
    mealEffects.totalMOB,
    insulinEffects.totalIOB,
    patientConstants.target_glucose || DEFAULT_TARGET_GLUCOSE
  );

  const trend = determineTrend(currentNetEffect);

  // 🔍 DEBUG: Log final result
  console.log('[calculateNetEffect] Final calculation:', {
    estimatedBG,
    projectedFinalBG,
    currentNetEffect,
    activeMealEffect,
    activeInsulinEffect,
    totalIOB: insulinEffects.totalIOB,
    totalMOB: mealEffects.totalMOB,
    cumulativeMealEffect: cumulativeResult.cumulativeMealEffect,
    cumulativeInsulinEffect: cumulativeResult.cumulativeInsulinEffect,
    cumulativeBaseline: cumulativeResult.cumulativeNetBaseline,
    safetyStatus,
    trend,
  });
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔍 [calculateNetEffect] END');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  return {
    currentNetEffect: Math.round(currentNetEffect * 10) / 10,
    cumulativeBaseline: cumulativeResult.cumulativeNetBaseline,
    estimatedBG: Math.round(estimatedBG * 10) / 10,
    projectedFinalBG: Math.round(projectedFinalBG * 10) / 10,
    activeInsulinEffect: Math.round(activeInsulinEffect * 10) / 10,
    activeMealEffect: Math.round(activeMealEffect * 10) / 10,
    totalIOB: Math.round(insulinEffects.totalIOB * 100) / 100,
    totalMOB: Math.round(mealEffects.totalMOB * 100) / 100,
    safetyStatus,
    timestamp: currentTime.getTime(),
    trend,

    // ✅ CRITICAL FIX: These two lines were MISSING in the original code
    cumulativeMealEffect: cumulativeResult.cumulativeMealEffect,
    cumulativeInsulinEffect: cumulativeResult.cumulativeInsulinEffect,
  };
}


/**
 * Determine safety status based on BG and trends
 */
function determineSafetyStatus(
  estimatedBG: number,
  netEffect: number,
  mob: number,
  iob: number,
  targetGlucose: number
): SafetyStatus {
  const LOW_THRESHOLD = 70;
  const HIGH_THRESHOLD = 180;
  const CRITICAL_LOW = 54;
  const CRITICAL_HIGH = 250;

  if (estimatedBG < CRITICAL_LOW) return 'critical_low';
  if (estimatedBG > CRITICAL_HIGH) return 'critical_high';

  if (estimatedBG < LOW_THRESHOLD || (estimatedBG < 90 && netEffect < -20)) {
    return 'hypoglycemia_risk';
  }

  if (estimatedBG > HIGH_THRESHOLD || (estimatedBG > 150 && netEffect > 20)) {
    return 'hyperglycemia_risk';
  }

  if (Math.abs(estimatedBG - targetGlucose) < 30 && Math.abs(netEffect) < 10) {
    return 'optimal';
  }

  return 'acceptable';
}

/**
 * Determine glucose trend
 */
function determineTrend(netEffect: number): GlucoseTrend {
  if (netEffect > 20) return 'rising_rapidly';
  if (netEffect > 10) return 'rising';
  if (netEffect > 2) return 'rising_slightly';
  if (netEffect < -20) return 'falling_rapidly';
  if (netEffect < -10) return 'falling';
  if (netEffect < -2) return 'falling_slightly';
  return 'stable';
}


    export default {
  calculateUnifiedMealImpact,
  calculateWeightedAbsorptionType,

  // New - Cumulative Effects
  getDailyResetTime,
  getLastResetTime,
  calculateMealCumulativeEffect,
  calculateInsulinCumulativeEffect,
  calculateTotalCumulativeEffects,

  // New - Baseline
  calculateStableBaselineFromReading,

  // New - Net Effect
  calculateNetEffect,
};