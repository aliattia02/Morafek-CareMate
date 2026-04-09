/**
 * Meal impact calculation utilities
 * Ported from frontend/src/utils/BG_Effect.js to TypeScript
 * 
 * @module utils/glucose/meal-impact
 */

import { 
  AbsorptionType, 
  MealImpactCurvePoint,
  MealNutrition
} from '../../types/meal.types';
import { PatientConstants, DEFAULT_PATIENT_CONSTANTS } from '../../types/constants.types';
import { 
  ABSORPTION_PROFILES, 
  ABSORPTION_MODIFIERS,
  ABSORPTION_TYPE_VALUES,
  ABSORPTION_VALUE_TO_TYPE,
  getAbsorptionDescription
} from '../../constants/absorption.constants';
import { calculateCarbEquivalents } from './carb-equivalents';

// Re-export the description function for convenience
export { getAbsorptionDescription };

/**
 * Generate meal impact curve showing blood glucose effect over time
 * 
 * @param totalCarbEquiv - Total carbohydrate equivalents
 * @param absorptionType - Absorption type (very_fast to very_slow)
 * @param startTimestamp - Start time of the meal in milliseconds
 * @param durationHours - Maximum duration to project in hours
 * @param intervalMinutes - Time interval between data points in minutes
 * @param carbToBgFactor - Factor to convert carb units to blood glucose impact
 * @param absorptionFactor - Absorption rate modifier from constants
 * @returns Array of time points with impact values
 */
export function generateMealImpactCurve(
  totalCarbEquiv: number,
  absorptionType: AbsorptionType = 'medium',
  startTimestamp: number = Date.now(),
  durationHours: number = 6,
  intervalMinutes: number = 5,
  carbToBgFactor: number = 4.0,
  absorptionFactor: number = 1.0
): MealImpactCurvePoint[] {
  // Get profile for the specified absorption type
  const profile = ABSORPTION_PROFILES[absorptionType] || ABSORPTION_PROFILES.medium;

  // Apply absorption factor adjustments
  const adjustedOnsetMinutes = profile.onsetMinutes / absorptionFactor;
  const adjustedPeakMinutes = profile.peakMinutes / absorptionFactor;
  const adjustedPlateauMinutes = profile.plateauMinutes / Math.sqrt(absorptionFactor);
  const adjustedDurationHours = Math.min(
    profile.durationHours / Math.sqrt(absorptionFactor),
    durationHours
  );

  // Calculate plateau end time
  const plateauEndMinutes = adjustedPeakMinutes + adjustedPlateauMinutes;

  const results: MealImpactCurvePoint[] = [];

  // Generate points at specified intervals
  for (let minute = 0; minute <= adjustedDurationHours * 60; minute += intervalMinutes) {
    const minutesSinceStart = minute;
    let impactValue = 0;

    // Calculate impact based on absorption profile
    if (minutesSinceStart < adjustedOnsetMinutes) {
      // Pre-onset phase - minimal early absorption
      const preOnsetFraction = minutesSinceStart / adjustedOnsetMinutes;
      impactValue = totalCarbEquiv * 0.02 * preOnsetFraction;
    } else if (minutesSinceStart <= adjustedPeakMinutes) {
      // Rising phase - from onset to peak with smoother curve
      const riseTime = minutesSinceStart - adjustedOnsetMinutes;
      const totalRiseTime = adjustedPeakMinutes - adjustedOnsetMinutes;

      if (totalRiseTime > 0) {
        const normalizedRiseTime = riseTime / totalRiseTime;

        // Use sigmoid-like function for smoother rise
        const sigmoid = (x: number, steepness: number) => 
          1 / (1 + Math.exp(-steepness * (x - 0.5)));
        const sigmoidValue = sigmoid(normalizedRiseTime, profile.riseShape * 4);

        // Apply additional smoothing with cosine function
        const cosineSmoothing = 0.5 * (1 - Math.cos(Math.PI * normalizedRiseTime));

        // Blend sigmoid and cosine for optimal smoothness
        const blendedValue = 0.7 * sigmoidValue + 0.3 * cosineSmoothing;

        impactValue = totalCarbEquiv * blendedValue;
      }
    } else if (minutesSinceStart <= plateauEndMinutes) {
      // Plateau phase - sustained peak level with slight variation
      const plateauTime = minutesSinceStart - adjustedPeakMinutes;
      const plateauFraction = plateauTime / adjustedPlateauMinutes;

      // Add slight natural variation to plateau
      const variation = 1 + 0.05 * Math.sin(plateauFraction * Math.PI * 2);

      // Slight decline during plateau (95% to 90% of peak)
      const plateauLevel = 0.95 - (0.05 * plateauFraction);

      impactValue = totalCarbEquiv * plateauLevel * variation;
    } else if (minutesSinceStart <= adjustedDurationHours * 60) {
      // Falling phase - smooth decline
      const fallTime = minutesSinceStart - plateauEndMinutes;
      const totalFallTime = (adjustedDurationHours * 60) - plateauEndMinutes;

      if (totalFallTime > 0) {
        const normalizedFallTime = fallTime / totalFallTime;

        // Use multiple decay components for realistic fall
        const primaryDecay = Math.exp(-profile.fallShape * normalizedFallTime);
        const secondaryDecay = Math.exp(-profile.fallShape * 0.3 * normalizedFallTime);

        // Combine decays based on absorption type
        let combinedDecay: number;
        if (absorptionType === 'very_fast' || absorptionType === 'fast') {
          combinedDecay = primaryDecay;
        } else {
          combinedDecay = 0.7 * primaryDecay + 0.3 * secondaryDecay;
        }

        // Start from plateau level (90% of peak)
        impactValue = totalCarbEquiv * 0.9 * combinedDecay;
      }
    }

    // Apply absorption factor to final impact
    impactValue *= absorptionFactor;

    // Ensure minimum threshold
    if (impactValue < 0.005 * totalCarbEquiv) {
      impactValue = 0;
    }

    // Calculate BG impact in mg/dL
    const bgImpact = impactValue * carbToBgFactor;

    // Timestamp for this point
    const timestamp = startTimestamp + (minute * 60 * 1000);

    // Add point to results
    results.push({
      timestamp,
      minutesSinceMeal: minutesSinceStart,
      hoursSinceMeal: minutesSinceStart / 60,
      impactValue: Math.max(0, impactValue),
      bgImpact: Math.max(0, bgImpact),
      absorptionType,
      profile: {
        onset: adjustedOnsetMinutes,
        peak: adjustedPeakMinutes,
        plateauEnd: plateauEndMinutes,
        duration: adjustedDurationHours * 60,
        description: profile.description
      }
    });

    // Early termination if impact becomes negligible
    if (minutesSinceStart > plateauEndMinutes && impactValue < 0.01 * totalCarbEquiv) {
      break;
    }
  }

  return results;
}

/**
 * Calculate weighted absorption type for meals with multiple food items
 * 
 * @param foodItems - Array of food items with carbs and absorption type
 * @returns Weighted absorption type based on carb content
 */
export function calculateWeightedAbsorptionType(
  foodItems: Array<{
    carbs: number;
    absorptionType: AbsorptionType;
  }>
): AbsorptionType {
  if (!foodItems || foodItems.length === 0) {
    return 'medium';
  }

  let totalWeight = 0;
  let weightedSum = 0;

  for (const item of foodItems) {
    const carbs = item.carbs || 0;
    if (carbs > 0) {
      const absorptionValue = ABSORPTION_TYPE_VALUES[item.absorptionType] ?? 3;
      weightedSum += absorptionValue * carbs;
      totalWeight += carbs;
    }
  }

  if (totalWeight === 0) {
    return 'medium';
  }

  const averageValue = Math.round(weightedSum / totalWeight);
  return ABSORPTION_VALUE_TO_TYPE[averageValue] || 'medium';
}

/**
 * Full meal impact calculation result
 */
export interface MealImpactResult {
  carbEquivalents: {
    totalCarbEquiv: number;
    carbsActual: number;
    proteinCarbEquiv: number;
    fatCarbEquiv: number;
    fiberReduction: number;
  };
  baseInsulin: number;
  adjustedInsulin: number;
  peakBgImpact: number;
  absorptionProfile: {
    type: AbsorptionType;
    factor: number;
    description: string;
  };
  timeCurve?: MealImpactCurvePoint[];
}

/**
 * Calculate complete meal impact including carb equivalents and optional time curve
 * 
 * @param nutrition - Meal nutrition data
 * @param absorptionType - Absorption type for the meal
 * @param patientConstants - Patient-specific constants
 * @param options - Additional calculation options
 * @returns Complete meal impact result
 */
export function calculateMealImpact(
  nutrition: Partial<MealNutrition>,
  absorptionType: AbsorptionType = 'medium',
  patientConstants?: Partial<PatientConstants>,
  options?: {
    includeTimeCurve?: boolean;
    mealTimestamp?: number;
    durationHours?: number;
    intervalMinutes?: number;
  }
): MealImpactResult {
  const constants = patientConstants || DEFAULT_PATIENT_CONSTANTS;
  const {
    includeTimeCurve = false,
    mealTimestamp = Date.now(),
    durationHours = 6,
    intervalMinutes = 5
  } = options || {};

  // Calculate carb equivalents
  const carbEquivalents = calculateCarbEquivalents(nutrition, constants);

  // Get absorption factor
  const absorptionFactor = ABSORPTION_MODIFIERS[absorptionType] ?? 1.0;

  // Calculate base insulin dose
  const baseInsulin = carbEquivalents.totalCarbEquiv / (constants.insulin_to_carb_ratio ?? 10);
  const adjustedInsulin = baseInsulin * absorptionFactor;

  // Calculate peak BG impact
  const carbToBgFactor = constants.carb_to_bg_factor ?? 4.0;
  const peakBgImpact = carbEquivalents.totalCarbEquiv * carbToBgFactor * absorptionFactor;

  // Build result
  const result: MealImpactResult = {
    carbEquivalents,
    baseInsulin,
    adjustedInsulin,
    peakBgImpact,
    absorptionProfile: {
      type: absorptionType,
      factor: absorptionFactor,
      description: getAbsorptionDescription(absorptionType)
    }
  };

  // Generate time curve if requested
  if (includeTimeCurve) {
    result.timeCurve = generateMealImpactCurve(
      carbEquivalents.totalCarbEquiv,
      absorptionType,
      mealTimestamp,
      durationHours,
      intervalMinutes,
      carbToBgFactor,
      absorptionFactor
    );
  }

  return result;
}

export default {
  generateMealImpactCurve,
  calculateWeightedAbsorptionType,
  getAbsorptionDescription,
  calculateMealImpact
};
