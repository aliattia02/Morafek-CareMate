/**
 * Net Effect Integration
 * Combines baseline, cumulative effects, MOB, and IOB into a
 * single BG estimation with safety status and trend.
 *
 * Re-exports and wraps logic from blood-glucose-estimation.ts.
 *
 * Ports: backend/utils/pharmacodynamics.py (net effect calculation section)
 *
 * @module utils/calculations/net-effect
 * @version 1.0
 */

import type { Meal } from '@/types/meal.types';
import type { InsulinDose } from '@/types/insulin.types';
import type { PatientConstants } from '@/types/constants.types';
import type { PharmacodynamicProfile } from '@/types/pharmacodynamics.types';
import type { NetEffectResult, BaselineResult } from '@/types/calculation.types';
import type { AbsorptionType } from '@/types/meal.types';

import {
  calculateNetEffect as _calculateNetEffect,
} from '@/utils/glucose/blood-glucose-estimation';

// ─── Re-export result types ───────────────────────────────────────────────────
export type { NetEffectResult, BaselineResult };

/**
 * Calculate the complete net BG effect integrating all active interventions.
 *
 * This is the top-level calculation that produces all values shown in the
 * Active Effects Display:
 *
 *   estimatedBG      = baseline + cumulativeNetBaseline
 *   projectedFinalBG = estimatedBG + pendingMOBRise − pendingIOBReduction
 *   safetyStatus     = derived from estimatedBG + trend velocity
 *   trend            = derived from currentNetEffect (mg/dL change rate)
 *
 * The calculation chain:
 *   1. calculateStackedMealEffect  → activeMealEffect, totalMOB, pendingBGRise
 *   2. calculateStackedInsulinEffect → activeInsulinEffect, totalIOB
 *   3. calculateTotalCumulativeEffects → cumulativeNetBaseline (bank balance)
 *   4. Combine → estimatedBG, projectedFinalBG, safetyStatus, trend
 *
 * @param baseline           - Stable baseline (from calculateStableBaselineFromReading),
 *                             or null to fall back to patientConstants.target_glucose
 * @param meals              - Active meals
 * @param insulinDoses       - Active doses
 * @param currentTime        - Current timestamp
 * @param patientConstants   - Patient constants
 * @param absorptionProfiles - Absorption profile map keyed by AbsorptionType
 * @returns Full net effect result
 *
 * @example
 * const netEffect = calculateNetEffect(
 *   baseline,          // from calculateStableBaselineFromReading
 *   meals,
 *   doses,
 *   new Date(),
 *   constants,
 *   MEAL_ABSORPTION_PROFILES
 * );
 * console.log(netEffect.estimatedBG);  // e.g. 127 mg/dL
 * console.log(netEffect.totalIOB);     // e.g. 2.3 units
 * console.log(netEffect.totalMOB);     // e.g. 18.4 g
 * console.log(netEffect.safetyStatus); // 'acceptable'
 * console.log(netEffect.trend);        // 'stable'
 */
export function calculateNetEffect(
  baseline: BaselineResult | null,
  meals: Meal[],
  insulinDoses: InsulinDose[],
  currentTime: Date,
  patientConstants: PatientConstants,
  absorptionProfiles: Record<AbsorptionType, PharmacodynamicProfile>
): NetEffectResult {
  return _calculateNetEffect(
    baseline,
    meals,
    insulinDoses,
    currentTime,
    patientConstants,
    absorptionProfiles
  );
}

/**
 * Convenience: quickly check if a NetEffectResult needs urgent attention.
 *
 * Returns true for critical_low, critical_high, hypoglycemia_risk, or
 * hyperglycemia_risk statuses.
 *
 * @param result - NetEffectResult from calculateNetEffect
 * @returns true if the patient may need immediate action
 */
export function requiresAttention(result: NetEffectResult): boolean {
  return (
    result.safetyStatus === 'critical_low' ||
    result.safetyStatus === 'critical_high' ||
    result.safetyStatus === 'hypoglycemia_risk' ||
    result.safetyStatus === 'hyperglycemia_risk'
  );
}

/**
 * Get a human-readable trend arrow string from a NetEffectResult.
 *
 * @param result - NetEffectResult
 * @returns Unicode arrow character(s) representing the BG trend
 */
export function getTrendArrow(result: NetEffectResult): string {
  switch (result.trend) {
    case 'rising_rapidly':  return '⬆⬆';
    case 'rising':          return '⬆';
    case 'rising_slightly': return '↗';
    case 'stable':          return '→';
    case 'falling_slightly':return '↘';
    case 'falling':         return '⬇';
    case 'falling_rapidly': return '⬇⬇';
    default:                return '—';
  }
}
