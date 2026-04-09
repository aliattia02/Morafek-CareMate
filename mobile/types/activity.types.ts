/**
 * Activity type definitions for NATIVE diabetes management platform
 * @module types/activity
 */

/**
 * Activity level matching backend ACTIVITY_LEVELS
 */
export interface ActivityLevel {
  /** Numeric value (-2 to 2) */
  value: number;
  /** Display label */
  label: string;
  /** Impact factor on insulin needs */
  impact: number;
}

/**
 * Activity type classification
 */
export type ActivityType = 
  | 'walking'
  | 'running'
  | 'cycling'
  | 'swimming'
  | 'strength_training'
  | 'yoga'
  | 'sports'
  | 'housework'
  | 'gardening'
  | 'other';

/**
 * Activity intensity level
 */
export type ActivityIntensity = 'light' | 'moderate' | 'vigorous';

/**
 * Activity record
 */
export interface Activity {
  /** Unique identifier */
  id: string;
  /** User ID who recorded this activity */
  userId: string;
  /** Type of activity */
  type: ActivityType;
  /** Intensity level */
  intensity: ActivityIntensity;
  /** Duration in minutes */
  durationMinutes: number;
  /** Start timestamp (ISO 8601 format) */
  startTime: string;
  /** End timestamp (ISO 8601 format) */
  endTime?: string;
  /** Estimated calories burned */
  caloriesBurned?: number;
  /** Activity level value (-2 to 2) for insulin calculations */
  activityLevel: number;
  /** Notes about the activity */
  notes?: string;
  /** Creation timestamp */
  createdAt?: string;
}

/**
 * Predefined activity levels from backend Constants.ACTIVITY_LEVELS
 */
export const ACTIVITY_LEVELS: ActivityLevel[] = [
  { value: -2, label: 'mode 1', impact: 1.2 },
  { value: -1, label: 'mode 2', impact: 1.1 },
  { value: 0, label: 'Normal Activity', impact: 1.0 },
  { value: 1, label: 'High Activity', impact: 0.9 },
  { value: 2, label: 'Vigorous Activity', impact: 0.8 }
];

/**
 * Get activity coefficient for insulin calculations
 * @param activityLevel - Activity level value (-2 to 2)
 * @returns Impact factor for insulin needs
 */
export function getActivityCoefficient(activityLevel: number): number {
  const level = ACTIVITY_LEVELS.find(l => l.value === activityLevel);
  return level ? level.impact : 1.0;
}

/**
 * Activity effect on blood glucose
 */
export interface ActivityEffect {
  /** Start timestamp in milliseconds */
  startTimestamp: number;
  /** Duration of effect in hours */
  durationHours: number;
  /** Peak effect time in hours after start */
  peakHours: number;
  /** Maximum effect percentage */
  maxEffectPercent: number;
  /** Current effect percentage at a given time */
  currentEffect: number;
}
