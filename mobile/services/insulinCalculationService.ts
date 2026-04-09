/**
 * Insulin Calculation Service
 * Location: mobile/services/insulinCalculationService.ts
 *
 * Ports the full insulin calculation pipeline from EnhancedPatientConstantsCalc.js
 * to TypeScript so all calculations run on-device (no backend call needed).
 *
 * Mirrors exactly the logic in MealInput.jsx → calculateInsulinNeeds()
 * which calls calculateInsulinDose() from EnhancedPatientConstantsCalc.js.
 *
 * Calculation pipeline (same order as JS):
 *   1. calculateTotalNutrients()   – carbs/protein/fat + weighted absorption type
 *   2. calculateCarbEquivalents()  – protein & fat → carb-equivalent grams
 *   3. calculateUnifiedMealImpact()– base insulin from carb equivalents / ICR
 *   4. calculateActivityImpact()   – scale insulin by activity level & duration
 *   5. correctionInsulin           – (BG − target) / correction_factor
 *   6. IOB/MOB deduction           – subtract active insulin, add MOB equivalent
 *   7. peakOverlapAdjustment       – predictive overlap of existing MOB/IOB
 *   8. calculateHealthFactors()    – disease + medication multipliers
 *   9. Round to 0.1u, apply 0.5u safety floor
 *
 * Author: DiaTwin Team (TS port)
 * Version: 1.0
 */

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type AbsorptionType = 'very_fast' | 'fast' | 'medium' | 'slow' | 'very_slow';

export interface FoodItem {
  name?: string;
  details?: {
    carbs?: number;
    protein?: number;
    fat?: number;
    absorption_type?: AbsorptionType;
    serving_size?: {
      w_amount?: number;
      w_unit?: string;
      amount?: number;
      unit?: string;
    };
  };
  portion?: {
    activeMeasurement?: 'weight' | 'volume';
    w_amount?: number;
    w_unit?: string;
    amount?: number;
    unit?: string;
  };
}

export interface TotalNutrition {
  carbs: number;
  protein: number;
  fat: number;
  absorptionType: AbsorptionType;
  absorptionMetadata?: {
    weightedType: AbsorptionType;
    foodTypes: Array<{ food: string; type: AbsorptionType; carbs: number }>;
    totalCarbWeight: number;
  };
}

export interface CarbEquivalents {
  carbsActual: number;
  proteinCarbEquiv: number;
  fatCarbEquiv: number;
  totalCarbEquiv: number;
}

export interface ActivityEntry {
  level: number | string;   // −2..+2 or string key
  startTime?: string;       // ISO UTC
  endTime?: string;         // ISO UTC
  duration?: number | string; // hours or "H:MM"
}

export interface PatientConstants {
  insulin_to_carb_ratio?: number;
  correction_factor?: number;
  target_glucose?: number;
  protein_factor?: number;
  fat_factor?: number;
  carb_to_bg_factor?: number;
  activity_coefficients?: Record<string, number>;
  absorption_modifiers?: Record<string, number>;
  active_conditions?: string[];
  active_medications?: string[];
  disease_factors?: Record<string, { factor?: number; description?: string }>;
  medication_factors?: Record<string, MedicationFactor>;
  medication_schedules?: Record<string, MedicationSchedule>;
}

export interface MedicationFactor {
  factor?: number;
  duration_based?: boolean;
  peak_hours?: number;
  duration_hours?: number;
  description?: string;
}

export interface MedicationSchedule {
  last_taken?: string;
  daily_times?: string[];
}

export interface AbsorptionProfile {
  onset_hours: number;
  peak_hours: number;
  duration_hours: number;
  shape_param?: number;
  scale_param?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// ABSORPTION PROFILES  (mirrors shared_constants.py / SHARED_CONSTANTS)
// ─────────────────────────────────────────────────────────────────────────────

const ABSORPTION_PROFILES: Record<AbsorptionType, AbsorptionProfile> = {
  very_fast:  { onset_hours: 0.17, peak_hours: 0.75, duration_hours: 2.0,  shape_param: 2.0, scale_param: 0.35 },
  fast:       { onset_hours: 0.25, peak_hours: 1.0,  duration_hours: 3.0,  shape_param: 2.0, scale_param: 0.45 },
  medium:     { onset_hours: 0.42, peak_hours: 1.5,  duration_hours: 4.0,  shape_param: 2.0, scale_param: 0.50 },
  slow:       { onset_hours: 0.75, peak_hours: 2.5,  duration_hours: 6.0,  shape_param: 2.0, scale_param: 0.60 },
  very_slow:  { onset_hours: 1.0,  peak_hours: 3.5,  duration_hours: 8.0,  shape_param: 2.0, scale_param: 0.70 },
};

/** Return absorption profile for a given type (falls back to 'medium'). */
export function getAbsorptionProfile(type: AbsorptionType): AbsorptionProfile {
  return ABSORPTION_PROFILES[type] ?? ABSORPTION_PROFILES.medium;
}

// ─────────────────────────────────────────────────────────────────────────────
// NUTRIENT HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Use the canonical conversion functions from shared constants so that all
// household/custom units (palm, handful, fist, bowl, half_cup, etc.) are
// resolved correctly — matching exactly what SelectedFoodsList displays.
import { convertToGrams, convertToMl } from '@/constants';

/**
 * Calculate the scaled nutrients for a single food item based on portion size.
 * Mirrors calculateNutrients() in EnhancedPatientConstantsCalc.js.
 */
export function calculateNutrients(food: FoodItem): {
  carbs: number; protein: number; fat: number; absorptionType: AbsorptionType;
} {
  if (!food.details) return { carbs: 0, protein: 0, fat: 0, absorptionType: 'medium' };

  let conversionRatio = 1;
  const portion = food.portion ?? {};
  const serving = food.details.serving_size ?? {};

  if (portion.activeMeasurement === 'weight') {
    const portionGrams = convertToGrams(portion.w_amount ?? 100, portion.w_unit ?? 'g');
    const servingGrams = convertToGrams(serving.w_amount ?? 100, serving.w_unit ?? 'g');
    conversionRatio = servingGrams > 0 ? portionGrams / servingGrams : 1;
  } else {
    const portionMl = convertToMl(portion.amount ?? 1, portion.unit ?? 'serving');
    const servingMl  = convertToMl(serving.amount ?? 1, serving.unit ?? 'serving');
    conversionRatio = servingMl > 0 ? portionMl / servingMl : 1;
  }

  return {
    carbs:  (food.details.carbs   ?? 0) * conversionRatio,
    protein:(food.details.protein ?? 0) * conversionRatio,
    fat:    (food.details.fat     ?? 0) * conversionRatio,
    absorptionType: (food.details.absorption_type ?? 'medium') as AbsorptionType,
  };
}

// Absorption type numeric values for weighted average
const ABSORPTION_VALUES: Record<AbsorptionType, number> = {
  very_fast: 5, fast: 4, medium: 3, slow: 2, very_slow: 1,
};
const ABSORPTION_REVERSE: Record<number, AbsorptionType> = {
  5: 'very_fast', 4: 'fast', 3: 'medium', 2: 'slow', 1: 'very_slow',
};

/**
 * Sum nutrients across all selected food items and compute weighted absorption type.
 * Mirrors calculateTotalNutrients() in EnhancedPatientConstantsCalc.js.
 */
export function calculateTotalNutrients(selectedFoods: FoodItem[]): TotalNutrition {
  const total: TotalNutrition = { carbs: 0, protein: 0, fat: 0, absorptionType: 'medium' };
  if (!selectedFoods?.length) return total;

  let totalWeight = 0;
  let weightedSum = 0;
  const foodTypes: TotalNutrition['absorptionMetadata'] extends undefined ? never : NonNullable<TotalNutrition['absorptionMetadata']>['foodTypes'] = [];

  for (const food of selectedFoods) {
    const n = calculateNutrients(food);
    total.carbs   += n.carbs;
    total.protein += n.protein;
    total.fat     += n.fat;

    if (n.carbs > 0) {
      const val = ABSORPTION_VALUES[n.absorptionType] ?? 3;
      weightedSum += val * n.carbs;
      totalWeight += n.carbs;
      foodTypes.push({ food: food.name ?? 'Unknown', type: n.absorptionType, carbs: n.carbs });
    }
  }

  if (totalWeight > 0) {
    const avg = Math.round(weightedSum / totalWeight);
    total.absorptionType = ABSORPTION_REVERSE[avg] ?? 'medium';
  }

  total.absorptionMetadata = {
    weightedType: total.absorptionType,
    foodTypes,
    totalCarbWeight: totalWeight,
  };
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// CARB EQUIVALENTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert protein & fat grams into their carbohydrate-equivalent impact
 * using patient-specific protein_factor and fat_factor.
 * Mirrors calculateCarbEquivalents() in EnhancedPatientConstantsCalc.js.
 */
export function calculateCarbEquivalents(
  carbs: number,
  protein: number,
  fat: number,
  constants: PatientConstants,
): CarbEquivalents {
  const proteinFactor = constants.protein_factor ?? 0.5;
  const fatFactor     = constants.fat_factor     ?? 0.2;

  const carbsActual      = carbs   ?? 0;
  const proteinCarbEquiv = (protein ?? 0) * proteinFactor;
  const fatCarbEquiv     = (fat    ?? 0) * fatFactor;
  const totalCarbEquiv   = carbsActual + proteinCarbEquiv + fatCarbEquiv;

  return { carbsActual, proteinCarbEquiv, fatCarbEquiv, totalCarbEquiv };
}

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH FACTORS  (disease conditions + medications)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the pharmacokinetic effect of a duration-based medication.
 * Mirrors calculateMedicationEffect() in EnhancedPatientConstantsCalc.js.
 */
function calculateMedicationEffect(
  medData: MedicationFactor,
  schedule: MedicationSchedule | undefined,
  currentDate: Date,
): { factor: number } {
  const baseFactor = medData.factor ?? 1.0;
  if (!medData.duration_based) return { factor: baseFactor };
  if (!schedule) return { factor: baseFactor };

  let lastDoseTime: Date | null = null;

  if (schedule.last_taken) {
    lastDoseTime = new Date(schedule.last_taken);
  } else if (schedule.daily_times?.length) {
    const today = new Date(currentDate);
    for (const timeStr of [...schedule.daily_times].sort().reverse()) {
      const [h, m] = timeStr.split(':').map(Number);
      const t = new Date(today);
      t.setHours(h, m, 0, 0);
      if (t <= currentDate) { lastDoseTime = t; break; }
    }
    if (!lastDoseTime) {
      const lastStr = [...schedule.daily_times].sort().reverse()[0];
      const [h, m] = lastStr.split(':').map(Number);
      const yesterday = new Date(currentDate);
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(h, m, 0, 0);
      lastDoseTime = yesterday;
    }
  }

  if (!lastDoseTime) return { factor: baseFactor };

  const hoursSince = (currentDate.getTime() - lastDoseTime.getTime()) / 3_600_000;
  const peakHours  = medData.peak_hours     ?? 2;
  const durationH  = medData.duration_hours ?? 8;

  let multiplier: number;
  if (hoursSince < 0) {
    multiplier = 0;
  } else if (hoursSince <= peakHours) {
    multiplier = hoursSince / peakHours;
  } else if (hoursSince <= durationH) {
    const decay = (hoursSince - peakHours) / (durationH - peakHours);
    multiplier = Math.exp(-2.0 * decay);
  } else {
    multiplier = 0;
  }

  return { factor: 1.0 + (baseFactor - 1.0) * multiplier };
}

/**
 * Compute the combined health multiplier from all active conditions & medications.
 * Mirrors calculateHealthFactors() in EnhancedPatientConstantsCalc.js.
 */
export function calculateHealthFactors(
  constants: PatientConstants,
  currentDate: Date = new Date(),
): number {
  if (!constants) return 1.0;
  let multiplier = 1.0;

  // Conditions
  for (const condition of constants.active_conditions ?? []) {
    const data = constants.disease_factors?.[condition];
    if (data?.factor) multiplier *= data.factor;
  }

  // Medications
  for (const med of constants.active_medications ?? []) {
    const medData  = constants.medication_factors?.[med];
    if (!medData?.factor) continue;
    const schedule = constants.medication_schedules?.[med];

    if (medData.duration_based) {
      const effect = calculateMedicationEffect(medData, schedule, currentDate);
      multiplier *= effect.factor;
    } else {
      multiplier *= medData.factor;
    }
  }

  return multiplier;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY IMPACT
// ─────────────────────────────────────────────────────────────────────────────

/** Parse "H:MM" or numeric duration string → total hours. */
function parseDurationHours(duration: string | number | undefined): number {
  if (duration === undefined || duration === null) return 0;
  if (typeof duration === 'number') return duration;
  if (duration.includes(':')) {
    const [h, m] = duration.split(':').map(Number);
    return h + m / 60;
  }
  return parseFloat(duration) || 0;
}

/** Calculate duration in hours between two UTC ISO strings. */
function durationBetween(startISO?: string, endISO?: string): number {
  if (!startISO || !endISO) return 0;
  return (new Date(endISO).getTime() - new Date(startISO).getTime()) / 3_600_000;
}

/**
 * Compute the combined activity impact coefficient.
 * Mirrors calculateActivityImpact() in EnhancedPatientConstantsCalc.js.
 */
export function calculateActivityImpact(
  activities: ActivityEntry[],
  constants: PatientConstants,
): number {
  if (!activities?.length || !constants?.activity_coefficients) return 1.0;

  let totalImpact = 1.0;
  for (const activity of activities) {
    const level = activity.level.toString();
    const coefficient = constants.activity_coefficients[level] ?? 1.0;

    let hours: number;
    if (activity.startTime && activity.endTime) {
      hours = durationBetween(activity.startTime, activity.endTime);
    } else {
      hours = parseDurationHours(activity.duration);
    }

    const durationWeight    = Math.min(hours / 2, 1);
    const weightedImpact    = 1.0 + (coefficient - 1.0) * durationWeight;
    totalImpact            *= weightedImpact;
  }

  return 1.0 + (totalImpact - 1.0);
}

// ─────────────────────────────────────────────────────────────────────────────
// PEAK OVERLAP PREDICTION  (mirrors projectMOBEffect/IOBEffect + calculatePeakOverlap)
// ─────────────────────────────────────────────────────────────────────────────

interface OverlapData {
  adjustmentFactor: number;
  existingMobAtPeak: number;
  existingIobAtPeak: number;
  netBgImpactAtPeak: number;
}

function calculateAdjustmentFromOverlap(
  mobAtPeak: number,
  iobAtPeak: number,
): number {
  let adj = 1.0;
  if (mobAtPeak > 10)  adj *= 1 + (mobAtPeak / 100) * 0.1;
  if (iobAtPeak > 1)   adj *= 1 - (iobAtPeak / 10)  * 0.2;
  return Math.max(0.5, Math.min(1.5, adj));
}

/**
 * Estimate remaining active carbs at a future time point using a simple
 * trapezoidal approximation (avoids importing the full gamma PK engine).
 */
function estimateMobAtPeak(
  activeCarbs: number,
  peakHours: number,
  profile: AbsorptionProfile,
): number {
  if (activeCarbs <= 0) return 0;
  const remaining = Math.max(0, profile.duration_hours - 1.0); // assume 1h already elapsed
  if (remaining <= 0) return 0;
  const fractionLeft = Math.max(0, 1 - peakHours / remaining);
  return activeCarbs * fractionLeft;
}

/**
 * Estimate remaining IOB at a future time point (linear decay approximation).
 */
function estimateIobAtPeak(
  activeInsulin: number,
  peakHours: number,
  insulinDurationHours = 4.0,
): number {
  if (activeInsulin <= 0) return 0;
  const elapsed = 1.5; // assume 1.5h already elapsed for current IOB
  const remaining = insulinDurationHours - elapsed;
  if (remaining <= 0) return 0;
  const fraction = Math.max(0, 1 - peakHours / remaining);
  return activeInsulin * fraction;
}

/**
 * Compute predictive peak overlap between this meal and currently active MOB/IOB.
 * Mirrors calculatePeakOverlap() in EnhancedPatientConstantsCalc.js.
 */
function calculatePeakOverlap(
  newMealProfile: AbsorptionProfile,
  activeMealCarbs: number,
  activeInsulin: number,
  constants: PatientConstants,
): OverlapData {
  const peakHours    = newMealProfile.peak_hours ?? 1.5;
  const carbToBg     = constants.carb_to_bg_factor  ?? 4.0;
  const corrFactor   = constants.correction_factor  ?? 50;

  const mobAtPeak    = estimateMobAtPeak(activeMealCarbs, peakHours, newMealProfile);
  const iobAtPeak    = estimateIobAtPeak(activeInsulin, peakHours);

  const mobBgImpact  =  mobAtPeak * carbToBg;
  const iobBgImpact  = -iobAtPeak * corrFactor;
  const netBgImpact  = mobBgImpact + iobBgImpact;

  return {
    adjustmentFactor:   calculateAdjustmentFromOverlap(mobAtPeak, iobAtPeak),
    existingMobAtPeak:  mobAtPeak,
    existingIobAtPeak:  iobAtPeak,
    netBgImpactAtPeak:  netBgImpact,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN CALCULATION RESULT
// ─────────────────────────────────────────────────────────────────────────────

export interface InsulinCalculationBreakdown {
  // Carb breakdown
  carbsActual:       number;
  proteinCarbEquiv:  number;
  fatCarbEquiv:      number;
  totalCarbEquiv:    number;

  // Insulin steps
  baseInsulin:       number;   // totalCarbEquiv / ICR
  adjustedInsulin:   number;   // after activity
  correctionInsulin: number;   // (BG − target) / CF
  preActiveTotal:    number;   // adjustedInsulin + correctionInsulin

  // IOB / MOB
  activeInsulin:     number;
  activeMealCarbs:   number;
  mobInsulinEquivalent: number;
  postActiveTotal:   number;   // preActiveTotal − IOB + MOB_equiv

  // Overlap & health
  overlapAdjustment: number;
  healthMultiplier:  number;
  activityImpact:    number;

  // Pharmacodynamic factors (kept at 1.0 — see JS source)
  absorptionFactor:  number;
  mealTimingFactor:  number;

  // Peak overlap details
  projectedMobAtPeak: number;
  projectedIobAtPeak: number;
  netBgImpactAtPeak:  number;
  peakTime:           number;

  // Blood sugar metadata
  bloodSugarUsed:       number;
  bloodSugarSource:     string;
  bloodSugarConfidence: string;
  minutesSinceReading:  number;
  correctionNote:       string;

  // Cumulative day effects
  cumulativeMealEffect:    number;
  cumulativeInsulinEffect: number;
  cumulativeNetBaseline:   number;
  cumulativeAdjustment:    number;

  // Absorbed amounts
  absorbedCarbs:   number;
  absorbedInsulin: number;

  // Pending adjustments
  pendingMealRise:         number;
  pendingInsulinReduction: number;
  pendingNetChange:        number;
  pendingAdjustment:       number;

  // Summary of total adjustments
  totalAdjustments: {
    cumulative: number;
    active: number;
    pending: number;
    total: number;
  };
}

export interface InsulinCalculationResult {
  total:     number;
  breakdown: InsulinCalculationBreakdown;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────

export interface CalculateInsulinDoseParams {
  // Macronutrients
  carbs:   number;
  protein: number;
  fat:     number;

  // Blood glucose
  bloodSugar:           number;
  bloodSugarSource?:    string;   // 'actual' | 'estimated' | 'target_fallback'
  bloodSugarConfidence?: string;
  minutesSinceReading?: number;

  // Context
  activities?:          ActivityEntry[];
  patientConstants:     PatientConstants;
  mealType?:            string;
  absorptionType?:      AbsorptionType;
  currentTime?:         Date;

  // Active effects (IOB / MOB)
  activeInsulinValue?:  number;
  activeMealCarbs?:     number;

  // Cumulative day effects (from active-effects-full or frontend calculation)
  cumulativeMealEffect?:    number;  // total BG rise from meals today (absorbed)
  cumulativeInsulinEffect?: number;  // total BG reduction from insulin today (absorbed)
  cumulativeNetBaseline?:   number;  // net cumulative shift from reset

  // Absorbed amounts at time of reading
  absorbedCarbs?:    number;
  absorbedInsulin?:  number;

  // Pending effects (still in pipeline)
  pendingMealRise?:         number;  // MOB-based future BG rise in mg/dL
  pendingInsulinReduction?: number;  // IOB-based future BG reduction in mg/dL
}

/**
 * Calculate the suggested insulin dose from meal nutrition, blood sugar,
 * activity, and active effects.
 *
 * Exactly mirrors calculateInsulinDose() in EnhancedPatientConstantsCalc.js —
 * pure synchronous, no network calls.
 */
export function calculateInsulinDose(params: CalculateInsulinDoseParams): InsulinCalculationResult {
  const {
    carbs, protein, fat,
    bloodSugar = 0,
    bloodSugarSource     = 'unknown',
    bloodSugarConfidence = 'unknown',
    minutesSinceReading  = 0,
    activities           = [],
    patientConstants,
    absorptionType       = 'medium',
    currentTime          = new Date(),
    activeInsulinValue   = 0,
    activeMealCarbs      = 0,
    cumulativeMealEffect    = 0,
    cumulativeInsulinEffect = 0,
    cumulativeNetBaseline   = 0,
    absorbedCarbs           = 0,
    absorbedInsulin         = 0,
    pendingMealRise         = 0,
    pendingInsulinReduction = 0,
  } = params;

  const constants = patientConstants;

  // ── Step 1: Carb equivalents ──────────────────────────────────────────────
  const carbEquiv = calculateCarbEquivalents(carbs, protein, fat, constants);
  const { totalCarbEquiv } = carbEquiv;

  // ── Step 2: Base insulin  (pharmacodynamic factors DISABLED → 1.0) ────────
  const ICR          = constants.insulin_to_carb_ratio ?? 10;
  const baseInsulin  = totalCarbEquiv / ICR;
  const absorptionFactor  = 1.0; // kept at 1.0 per JS source comment
  const mealTimingFactor  = 1.0;

  // ── Step 3: Activity adjustment ───────────────────────────────────────────
  const activityImpact       = calculateActivityImpact(activities, constants);
  const adjustedInsulin      = baseInsulin * activityImpact;

  // ── Step 4: Correction insulin ────────────────────────────────────────────
  let correctionInsulin = 0;
  let correctionNote    = '';
  const target = constants.target_glucose    ?? 100;
  const CF     = constants.correction_factor ?? 50;

  if (typeof bloodSugar === 'number' && !isNaN(bloodSugar) && bloodSugar > 0) {
    correctionInsulin = (bloodSugar - target) / CF;

    if      (bloodSugarSource === 'estimated')       correctionNote = `Based on estimated BG (confidence: ${bloodSugarConfidence}, ${minutesSinceReading} min since reading)`;
    else if (bloodSugarSource === 'target_fallback') correctionNote = 'Based on target glucose — no recent reading available';
    else                                              correctionNote = 'Based on actual BG reading';
  }

  const preActiveTotal = adjustedInsulin + correctionInsulin;

  // ── Step 5: IOB / MOB deduction ───────────────────────────────────────────
  const activeInsulin       = activeInsulinValue ?? 0;
  const mobInsulinEquivalent = activeMealCarbs > 0
    ? activeMealCarbs / ICR
    : 0;

  const postActiveTotal = preActiveTotal - activeInsulin + mobInsulinEquivalent;

  // ── Step 5b: Cumulative & pending adjustments (display only, mirrors JS) ──
  const cumulativeAdjustment = cumulativeNetBaseline / (CF);
  const pendingNetChange     = pendingMealRise - pendingInsulinReduction;
  const pendingAdjustment    = pendingNetChange / CF;

  // ── Step 6: Predictive peak overlap ───────────────────────────────────────
  let overlapData: OverlapData = {
    adjustmentFactor: 1.0, existingMobAtPeak: 0, existingIobAtPeak: 0, netBgImpactAtPeak: 0,
  };

  if (activeMealCarbs > 0 || activeInsulin > 0) {
    const profile = getAbsorptionProfile(absorptionType);
    overlapData = calculatePeakOverlap(profile, activeMealCarbs, activeInsulin, constants);
  }

  const predictiveAdjustedTotal = postActiveTotal * overlapData.adjustmentFactor;

  // ── Step 7: Health multiplier ─────────────────────────────────────────────
  const healthMultiplier = calculateHealthFactors(constants, currentTime);
  let totalInsulin = Math.max(0, predictiveAdjustedTotal * healthMultiplier);

  // ── Step 8: Round + safety floor ─────────────────────────────────────────
  totalInsulin = Math.round(totalInsulin * 10) / 10;
  // Guard with adjustedInsulin (base meal dose) not preActiveTotal — correction
  // insulin can make preActiveTotal negative for low BG, wrongly skipping the floor.
  if (adjustedInsulin > 0 && totalInsulin < 0.5) totalInsulin = 0.5;

  // ── Build breakdown ───────────────────────────────────────────────────────
  const profile = getAbsorptionProfile(absorptionType);

  const breakdown: InsulinCalculationBreakdown = {
    carbsActual:      round2(carbEquiv.carbsActual),
    proteinCarbEquiv: round2(carbEquiv.proteinCarbEquiv),
    fatCarbEquiv:     round2(carbEquiv.fatCarbEquiv),
    totalCarbEquiv:   round2(totalCarbEquiv),
    baseInsulin:      round2(baseInsulin),
    adjustedInsulin:  round2(adjustedInsulin),
    correctionInsulin:round2(correctionInsulin),
    preActiveTotal:   round2(preActiveTotal),
    activeInsulin:    round2(activeInsulin),
    activeMealCarbs:  round2(activeMealCarbs),
    mobInsulinEquivalent: round2(mobInsulinEquivalent),
    postActiveTotal:  round2(postActiveTotal),
    overlapAdjustment:round2(overlapData.adjustmentFactor),
    healthMultiplier: round2(healthMultiplier),
    activityImpact:   round2(activityImpact),
    absorptionFactor,
    mealTimingFactor,
    projectedMobAtPeak: round2(overlapData.existingMobAtPeak),
    projectedIobAtPeak: round2(overlapData.existingIobAtPeak),
    netBgImpactAtPeak:  Math.round(overlapData.netBgImpactAtPeak),
    peakTime: profile.peak_hours,
    bloodSugarUsed:       bloodSugar,
    bloodSugarSource,
    bloodSugarConfidence,
    minutesSinceReading,
    correctionNote,

    // Cumulative day effects
    cumulativeMealEffect,
    cumulativeInsulinEffect,
    cumulativeNetBaseline,
    cumulativeAdjustment: round2(cumulativeAdjustment),

    // Absorbed amounts
    absorbedCarbs,
    absorbedInsulin,

    // Pending adjustments
    pendingMealRise,
    pendingInsulinReduction,
    pendingNetChange: round2(pendingNetChange),
    pendingAdjustment: round2(pendingAdjustment),

    // Summary of total adjustments (mirrors JS breakdown.totalAdjustments)
    totalAdjustments: {
      cumulative: round2(-cumulativeAdjustment),
      active:     round2(-(activeInsulin - mobInsulinEquivalent)),
      pending:    round2(-pendingAdjustment),
      total:      round2(-(cumulativeAdjustment + activeInsulin - mobInsulinEquivalent + pendingAdjustment)),
    },
  };

  return { total: totalInsulin, breakdown };
}

/**
 * Convenience wrapper — accepts selected food items directly.
 * Drop-in equivalent of calculateInsulinNeeds() in EnhancedPatientConstantsCalc.js.
 */
export function calculateInsulinNeeds(
  selectedFoods: FoodItem[],
  bloodSugar: number,
  activities: ActivityEntry[],
  patientConstants: PatientConstants,
  mealType?: string,
  currentTime: Date = new Date(),
  activeInsulinValue = 0,
  activeMealCarbs    = 0,
  // Extended context (mirrors MealInput.js smart BG + cumulative effects)
  options?: {
    bloodSugarSource?:      string;
    bloodSugarConfidence?:  string;
    minutesSinceReading?:   number;
    cumulativeMealEffect?:    number;
    cumulativeInsulinEffect?: number;
    cumulativeNetBaseline?:   number;
    absorbedCarbs?:           number;
    absorbedInsulin?:         number;
    pendingMealRise?:         number;
    pendingInsulinReduction?: number;
  },
): InsulinCalculationResult | null {
  if (!selectedFoods?.length || !patientConstants) return null;

  const nutrition = calculateTotalNutrients(selectedFoods);
  return calculateInsulinDose({
    carbs:   nutrition.carbs,
    protein: nutrition.protein,
    fat:     nutrition.fat,
    absorptionType: nutrition.absorptionType,
    bloodSugar,
    activities,
    patientConstants,
    mealType,
    currentTime,
    activeInsulinValue,
    activeMealCarbs,
    ...(options ?? {}),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function round2(v: number): number { return Math.round(v * 100) / 100; }