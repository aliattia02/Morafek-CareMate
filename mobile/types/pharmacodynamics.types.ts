/**
 * Pharmacodynamics type definitions for NATIVE diabetes management platform
 * Covers insulin and meal absorption modeling using gamma distribution curves
 * @module types/pharmacodynamics
 */

/**
 * Gamma distribution parameters for absorption modeling
 * Used for both insulin activity and meal absorption curves
 */
export interface GammaDistributionParams {
  /** Shape parameter (k or α) - controls curve sharpness */
  shapeParam: number;
  /** Scale parameter (θ) - controls curve width */
  scaleParam: number;
}

/**
 * Pharmacodynamic profile for insulin or meal absorption
 * Defines timing and curve characteristics
 */
export interface PharmacodynamicProfile {
  /** Time to onset in hours */
  onsetHours: number;
  /** Time to peak activity in hours */
  peakHours: number;
  /** Total duration of action in hours */
  durationHours: number;
  /** Type of curve used for modeling */
  curveType: string;
  /** Optional shape parameter for gamma distribution */
  shapeParam?: number;
  /** Optional scale parameter for gamma distribution */
  scaleParam?: number;
  /** Optional plateau duration for meal absorption */
  plateauHours?: number;
}

/**
 * Point on an activity curve (insulin or meal)
 * Represents activity at a specific time
 */
export interface ActivityCurvePoint {
  /** Time in hours since administration/consumption */
  time: number;
  /** Timestamp in milliseconds */
  timestamp?: number;
  /** Activity level (0-1) at this time */
  activity: number;
  /** Cumulative effect up to this time (0-1) */
  cumulativeEffect: number;
  /** Absorbed fraction up to this time (0-1) */
  absorbedFraction?: number;
}

/**
 * Insulin on board (IOB) calculation result
 */
export interface IOBResult {
  /** Total insulin on board in units */
  iob: number;
  /** Active insulin effect (rate of change) */
  activeEffect: number;
  /** Absorbed fraction (0-1) */
  absorbedFraction: number;
  /** Cumulative effect accumulated since administration */
  cumulativeEffect: number;
  /** Time since administration in hours */
  timeSinceAdministration: number;
}

/**
 * Meal on board (MOB) calculation result
 */
export interface MOBResult {
  /** Meal on board in carb equivalents */
  mob: number;
  /** Active meal effect (rate of change) */
  activeEffect: number;
  /** Absorbed fraction (0-1) */
  absorbedFraction: number;
  /** Cumulative effect accumulated since meal */
  cumulativeEffect: number;
  /** Time since meal in hours */
  timeSinceMeal: number;
}

/**
 * Activity curve data for visualization
 */
export interface ActivityCurveData {
  /** Array of curve points */
  points: ActivityCurvePoint[];
  /** Peak activity value */
  peakActivity: number;
  /** Time of peak activity in hours */
  peakTime: number;
  /** Total duration in hours */
  duration: number;
  /** Curve type identifier */
  curveType: string;
}

/**
 * Insulin activity calculation result
 */
export interface InsulinActivityResult {
  /** Activity level (0-1) at specified time */
  activity: number;
  /** Cumulative effect (0-1) */
  cumulativeEffect: number;
  /** Insulin on board in units */
  iob: number;
  /** Blood glucose impact in mg/dL */
  bgImpact: number;
  /** Hours since administration */
  hoursSinceDose: number;
  /** Whether insulin is still active */
  isActive: boolean;
}

/**
 * Meal activity calculation result
 */
export interface MealActivityResult {
  /** Activity level (0-1) at specified time */
  activity: number;
  /** Cumulative effect (0-1) */
  cumulativeEffect: number;
  /** Meal on board in carb equivalents */
  mob: number;
  /** Blood glucose impact in mg/dL */
  bgImpact: number;
  /** Hours since meal */
  hoursSinceMeal: number;
  /** Whether meal is still absorbing */
  isActive: boolean;
}

/**
 * Time series point for pharmacodynamic timeline
 */
export interface PharmacodynamicTimelinePoint {
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Hours since administration/consumption */
  hoursElapsed: number;
  /** Activity at this time (0-1) */
  activity: number;
  /** Cumulative effect at this time (0-1) */
  cumulativeEffect: number;
  /** Absorbed fraction at this time (0-1) */
  absorbedFraction: number;
  /** On-board amount (units or carb equiv) */
  onBoard: number;
  /** Blood glucose impact in mg/dL */
  bgImpact: number;
}

/**
 * Combined pharmacodynamic effects from multiple doses/meals
 */
export interface StackedPharmacodynamicEffect {
  /** Total active effect (sum of individual effects) */
  totalActiveEffect: number;
  /** Total on-board amount */
  totalOnBoard: number;
  /** Total blood glucose impact in mg/dL */
  totalBgImpact: number;
  /** Total cumulative baseline effect */
  totalCumulativeBaseline: number;
  /** Individual dose/meal contributions */
  contributions: Array<{
    id: string;
    timestamp: number;
    amount: number;
    activeEffect: number;
    onBoard: number;
    bgImpact: number;
    cumulativeEffect: number;
  }>;
  /** Number of active doses/meals */
  activeCount: number;
}
