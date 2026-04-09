/**
 * Blood Glucose Estimation Hook - UNIFIED WITH WEB CONTEXT
 * Matches BloodSugarDataContext.js logic exactly
 * Location: mobile/hooks/useBloodGlucoseEstimation.ts
 *
 * Single source of truth for baseline blood glucose estimation with decay
 * DEFAULT: Returns to target glucose over 3 hours using exponential decay
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { getReadings } from '@/services/api/glucose';
import {
  getCircadianBaseline,
  BASELINE_MODES,
  type BaselineMode,
  type CircadianProfile,
  type PatientConstants,
} from '@/constants/shared-constants';
import type { BloodSugarResponse } from '@/types/api';

export interface EstimatedBG {
  value: number;
  timestamp: number;
  source: 'actual' | 'last_actual' | 'estimated' | 'target' | 'loading';
  isActual: boolean;
  confidence: 'high' | 'medium' | 'low' | 'initializing';
  dataPoint?: BloodSugarResponse;
}

export interface UseBloodGlucoseEstimationOptions {
  targetGlucose?: number;
  refreshInterval?: number; // milliseconds
  maxReadingAge?: number; // minutes (unused in web context logic)
  stabilizationHours?: number; // hours to return to target (DEFAULT: 3 hours)
  /**
   * When false, all API calls and intervals are skipped entirely.
   * Use this to prevent patient-only endpoints being hit during doctor sessions.
   * React hook rules are satisfied — the hook is still called, but is inert.
   * Default: true
   */
  enabled?: boolean;
  /**
   * 🆕 v4.3: Patient constants — used to read baseline_mode and circadian_profile.
   * When baseline_mode === 'preset', calculateBaselineFromData() returns the
   * circadian profile value at the current local hour instead of interpolating
   * between readings. Omitting this prop defaults to 'dynamic' mode.
   */
  patientConstants?: PatientConstants;
}

interface ProcessedReading extends BloodSugarResponse {
  readingTime: number;
  isActualReading: boolean;
  isInterpolated: boolean;
  isEstimated: boolean;
  dataType: 'actual' | 'estimated';
}

export const useBloodGlucoseEstimation = (
  options: UseBloodGlucoseEstimationOptions = {}
) => {
  const {
    targetGlucose = 100,
    refreshInterval = 2 * 60 * 1000, // 2 minutes
    stabilizationHours = 3, // 🔥 DEFAULT: 3 HOURS to return to target
    enabled = true,
    patientConstants,
  } = options;

  // 🆕 v4.3: Resolve baseline mode from patient constants
  const baselineMode = (patientConstants?.baseline_mode ?? 'dynamic') as BaselineMode;

  const [estimatedBG, setEstimatedBG] = useState<EstimatedBG>({
    value: targetGlucose,
    timestamp: Date.now(),
    source: 'loading',
    isActual: false,
    confidence: 'initializing',
  });

  const [recentReadings, setRecentReadings] = useState<BloodSugarResponse[]>([]);
  const [combinedData, setCombinedData] = useState<ProcessedReading[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isFetchingRef = useRef(false);
  const lastFetchTimeRef = useRef(0);
  const processing24hData = useRef(false);
  const baselineCalculatedRef = useRef(false);

  /**
   * Model blood glucose decay - MATCHES WEB APP LOGIC EXACTLY
   * Returns to target glucose over stabilizationHours using exponential decay
   *
   * Formula: BG(t) = target + (initial - target) * (1 - exponentialReturn)
   * where exponentialReturn = 1 - e^(-3 * ratio)
   */
  const modelBloodGlucose = useCallback(
    (startReading: BloodSugarResponse, elapsedMinutes: number): number => {
      const baseValue = startReading.bloodSugar;
      const stabilizationMinutes = stabilizationHours * 60;

      // If we're still within stabilization period, apply exponential decay
      if (elapsedMinutes < stabilizationMinutes) {
        const stabilizationRatio = elapsedMinutes / stabilizationMinutes;
        // Exponential return to target: 1 - e^(-3*ratio)
        const exponentialReturn = 1 - Math.exp(-3 * stabilizationRatio);

        // Current BG = target + (initial - target) * (1 - exponentialReturn)
        return targetGlucose + (baseValue - targetGlucose) * (1 - exponentialReturn);
      }

      // After stabilization period, return target glucose
      return targetGlucose;
    },
    [targetGlucose, stabilizationHours]
  );

  /**
   * 🔥 UNIFIED: Calculate baseline from combined data (MATCHES WEB CONTEXT)
   */
  const calculateBaselineFromData = useCallback(
    (combinedDataToUse: ProcessedReading[]): EstimatedBG => {
      // ── 🆕 v4.3: Preset (circadian) mode ──────────────────────────────────
      // Bypass reading interpolation entirely and return the circadian profile
      // value at the current local hour.  This makes the current-BG widget
      // consistent with the pharmacodynamic baseline in useActiveEffects.
      if (baselineMode === 'preset') {
        const now = new Date();
        const tzOffsetMin = patientConstants?.timezone_offset_minutes ?? 0;
        const localHour = (
          now.getUTCHours() +
          now.getUTCMinutes() / 60 +
          now.getUTCSeconds() / 3600 +
          tzOffsetMin / 60
        ) % 24;

        const circadianValue = getCircadianBaseline(
          localHour,
          patientConstants?.circadian_profile as CircadianProfile | undefined
        );

        console.log(
          '[BG Estimation] Preset circadian baseline:',
          circadianValue,
          'mg/dL @ local hour',
          localHour.toFixed(2)
        );

        return {
          value: Math.round(circadianValue),
          timestamp: Date.now(),
          source: 'estimated',
          isActual: false,
          confidence: 'medium',
        };
      }
      // ── Dynamic mode — original reading-interpolation logic unchanged ──────
      if (!combinedDataToUse || combinedDataToUse.length === 0) {
        console.log('[BG Estimation] No combined data available for baseline calculation');
        return {
          value: targetGlucose,
          timestamp: Date.now(),
          source: 'target',
          isActual: false,
          confidence: 'low'
        };
      }

      const now = Date.now();

      // Find the closest data point to current time (within 15 minutes)
      let closestPoint: ProcessedReading | null = null;
      let minDiff = Infinity;

      for (const point of combinedDataToUse) {
        const diff = Math.abs(point.readingTime - now);
        if (diff < minDiff && diff <= 15 * 60 * 1000) {
          minDiff = diff;
          closestPoint = point;
        }
      }

      if (closestPoint) {
        const estimatedValue = closestPoint.bloodSugar || targetGlucose;
        console.log('[BG Estimation] Found closest point for baseline:', {
          value: Math.round(estimatedValue),
          source: closestPoint.isActualReading ? 'actual' : 'estimated',
          timeDiff: Math.round(minDiff / 60000) + ' min'
        });
        return {
          value: Math.round(estimatedValue),
          timestamp: closestPoint.readingTime,
          source: closestPoint.isActualReading ? 'actual' : 'estimated',
          isActual: closestPoint.isActualReading,
          dataPoint: closestPoint,
          confidence: minDiff < 5 * 60 * 1000 ? 'high' : 'medium'
        };
      }

      // Fallback: find the most recent actual reading
      for (let i = combinedDataToUse.length - 1; i >= 0; i--) {
        const point = combinedDataToUse[i];
        if (point.isActualReading && point.bloodSugar && point.readingTime <= now) {
          console.log('[BG Estimation] Using last actual reading for baseline:', Math.round(point.bloodSugar));
          return {
            value: Math.round(point.bloodSugar),
            timestamp: point.readingTime,
            source: 'last_actual',
            isActual: true,
            dataPoint: point,
            confidence: 'medium'
          };
        }
      }

      // Final fallback: use the last estimated point
      const lastPoint = combinedDataToUse[combinedDataToUse.length - 1];
      if (lastPoint && lastPoint.bloodSugar) {
        console.log('[BG Estimation] Using last point for baseline:', Math.round(lastPoint.bloodSugar));
        return {
          value: Math.round(lastPoint.bloodSugar),
          timestamp: lastPoint.readingTime,
          source: 'estimated',
          isActual: false,
          dataPoint: lastPoint,
          confidence: 'low'
        };
      }

      console.log('[BG Estimation] No suitable point found, using target glucose');
      return {
        value: targetGlucose,
        timestamp: now,
        source: 'target',
        isActual: false,
        confidence: 'low'
      };
    },
    [targetGlucose, baselineMode, patientConstants]
  );

  /**
   * 🔥 UNIFIED: Generate 24h estimated data (MATCHES WEB CONTEXT EXACTLY)
   */
  const generateLast24hEstimatedData = useCallback(() => {
    if (processing24hData.current || recentReadings.length === 0) {
      console.log('[BG Estimation] Skipping 24h data generation - already processing or no data');
      return;
    }

    processing24hData.current = true;
    console.log('[BG Estimation] Starting 24h data generation with', recentReadings.length, 'actual readings');

    try {
      const now = Date.now();
      const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);

      const minimumMinutesBetweenPoints = 15;
      const intervalMs = minimumMinutesBetweenPoints * 60 * 1000;

      /**
       * Generate estimated points between readings
       */
      const generateEstimatedPoints = (
        startPoint: ProcessedReading,
        endTime: number,
        actualReadings: ProcessedReading[]
      ): ProcessedReading[] => {
        const points: ProcessedReading[] = [];
        const startTime = startPoint.readingTime;
        const totalGapMinutes = (endTime - startTime) / (60 * 1000);

        if (totalGapMinutes < minimumMinutesBetweenPoints / 2) return points;

        let currentTime = startTime + intervalMs;

        // Add 30-minute point after actual readings if no nearby reading
        if (startPoint.isActualReading) {
          const thirtyMinutesAfterActual = startTime + (30 * 60 * 1000);
          const hasNearbyReading = actualReadings.some(reading => {
            const timeDiff = reading.readingTime - startTime;
            return timeDiff > 0 && timeDiff < 29 * 60 * 1000;
          });

          if (!hasNearbyReading && thirtyMinutesAfterActual < endTime) {
            const glucoseValue = modelBloodGlucose(startPoint, 30);
            points.push({
              ...startPoint,
              readingTime: thirtyMinutesAfterActual,
              bloodSugar: glucoseValue,
              isActualReading: false,
              isInterpolated: true,
              isEstimated: true,
              dataType: 'estimated'
            });
            currentTime = Math.ceil((thirtyMinutesAfterActual + intervalMs) / intervalMs) * intervalMs;
          }
        }

        // Generate estimated points at regular intervals
        while (currentTime < endTime) {
          const elapsedMinutes = (currentTime - startTime) / (60 * 1000);
          const glucoseValue = modelBloodGlucose(startPoint, elapsedMinutes);

          points.push({
            ...startPoint,
            readingTime: currentTime,
            bloodSugar: glucoseValue,
            isActualReading: false,
            isInterpolated: true,
            isEstimated: true,
            dataType: 'estimated'
          });

          currentTime += intervalMs;
        }

        return points;
      };

      let estimatedPoints: ProcessedReading[] = [];

      // Convert readings to processed format
      const sortedActualReadings: ProcessedReading[] = [...recentReadings]
        .sort((a, b) =>
          new Date(a.bloodSugarTimestamp || a.timestamp).getTime() -
          new Date(b.bloodSugarTimestamp || b.timestamp).getTime()
        )
        .map(reading => ({
          ...reading,
          readingTime: new Date(reading.bloodSugarTimestamp || reading.timestamp).getTime(),
          isActualReading: true,
          isInterpolated: false,
          isEstimated: false,
          dataType: 'actual' as const
        }));

      // Start from target if first reading is after 24h ago
      if (sortedActualReadings.length > 0 && sortedActualReadings[0].readingTime > twentyFourHoursAgo) {
        const startPoint: ProcessedReading = {
          ...sortedActualReadings[0],
          readingTime: twentyFourHoursAgo,
          bloodSugar: targetGlucose,
          isActualReading: false,
          isInterpolated: true,
          isEstimated: true,
          dataType: 'estimated'
        };

        estimatedPoints.push(startPoint);
        const pointsToFirst = generateEstimatedPoints(
          startPoint,
          sortedActualReadings[0].readingTime,
          sortedActualReadings
        );
        estimatedPoints = [...estimatedPoints, ...pointsToFirst];
      }

      // Process each actual reading
      for (let i = 0; i < sortedActualReadings.length; i++) {
        // Add actual reading with isEstimatedLine flag
        estimatedPoints.push({
          ...sortedActualReadings[i],
          isEstimated: true // Flag for estimated line continuity
        });

        // Generate points between this and next reading, or to now
        if (i < sortedActualReadings.length - 1) {
          const pointsBetween = generateEstimatedPoints(
            sortedActualReadings[i],
            sortedActualReadings[i + 1].readingTime,
            sortedActualReadings
          );
          estimatedPoints = [...estimatedPoints, ...pointsBetween];
        } else {
          if (sortedActualReadings[i].readingTime < now) {
            const pointsToNow = generateEstimatedPoints(
              sortedActualReadings[i],
              now,
              sortedActualReadings
            );
            estimatedPoints = [...estimatedPoints, ...pointsToNow];
          }
        }
      }

      // Combine and sort all data
      const combined = [...sortedActualReadings, ...estimatedPoints.filter(p => p.isInterpolated)];
      combined.sort((a, b) => a.readingTime - b.readingTime);

      console.log(`[BG Estimation] Generated ${combined.length} points for 24h baseline (${sortedActualReadings.length} actual, ${estimatedPoints.filter(p => p.isInterpolated).length} estimated)`);

      // 🔥 Calculate baseline BEFORE setting state
      const newBaseline = calculateBaselineFromData(combined);

      console.log('[BG Estimation] Calculated baseline BEFORE state update:', {
        value: newBaseline.value,
        source: newBaseline.source
      });

      // 🔥 Set both states together
      setCombinedData(combined);
      setEstimatedBG(newBaseline);
      baselineCalculatedRef.current = true;

      console.log('[BG Estimation] 24h data generation complete, baseline set to:', newBaseline.value);

    } catch (err) {
      console.error('[BG Estimation] Error generating 24h estimated data:', err);
    } finally {
      processing24hData.current = false;
    }
  }, [recentReadings, targetGlucose, stabilizationHours, modelBloodGlucose, calculateBaselineFromData]);

  /**
   * Fetch recent readings (last 24 hours)
   */
  const fetchRecentReadings = useCallback(async () => {
    // Prevent concurrent fetches
    if (isFetchingRef.current) {
      console.log('[BG Estimation] Fetch already in progress, skipping');
      return;
    }

    // Rate limiting: don't fetch more than once every 5 seconds
    const now = Date.now();
    if (now - lastFetchTimeRef.current < 5000) {
      console.log('[BG Estimation] Rate limited, skipping fetch');
      return;
    }

    try {
      isFetchingRef.current = true;
      lastFetchTimeRef.current = now;
      setIsLoading(true);
      setError(null);

      console.log('[BG Estimation] Fetching recent readings...');

      // Get readings from last 24 hours
      const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000);
      const startDate = twentyFourHoursAgo.toISOString().split('T')[0];

      const readings = await getReadings({ start_date: startDate });

      console.log('[BG Estimation] Fetched', readings.length, 'readings');

      setRecentReadings(readings);

    } catch (err) {
      console.error('[BG Estimation] Error fetching readings:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch readings');

      // On error, use target glucose as fallback
      setEstimatedBG({
        value: targetGlucose,
        timestamp: Date.now(),
        source: 'target',
        isActual: false,
        confidence: 'low',
      });
    } finally {
      setIsLoading(false);
      isFetchingRef.current = false;
    }
  }, [targetGlucose]);

  /**
   * Recalculate baseline periodically (every minute)
   */
  const recalculateBaseline = useCallback(() => {
    if (combinedData.length > 0) {
      const baseline = calculateBaselineFromData(combinedData);
      setEstimatedBG(baseline);

      console.log('[BG Estimation] Recalculated baseline:', {
        value: baseline.value,
        source: baseline.source,
      });
    }
  }, [combinedData, calculateBaselineFromData]);

  /**
   * Manual refresh function
   */
  const refresh = useCallback(() => {
    console.log('[BG Estimation] Manual refresh triggered');
    return fetchRecentReadings();
  }, [fetchRecentReadings]);

  // Generate 24h data when readings change
  useEffect(() => {
    if (!enabled) return;
    if (recentReadings.length > 0) {
      console.log('[BG Estimation] recentReadings changed, triggering generation');
      generateLast24hEstimatedData();
    }
  }, [enabled, recentReadings, generateLast24hEstimatedData]);

  // ── Stable refs so the polling effect never needs callbacks in its deps ──
  // fetchRecentReadings and recalculateBaseline are useCallbacks that recreate
  // whenever their own deps change (targetGlucose, combinedData, …).
  // Listing them in the effect dep array caused the effect to re-run on every
  // re-render, re-registering both intervals and stacking concurrent fetch
  // loops — exactly the timeout storm seen on Render free tier.
  const fetchRecentReadingsRef = useRef(fetchRecentReadings);
  const recalculateBaselineRef = useRef(recalculateBaseline);
  useEffect(() => { fetchRecentReadingsRef.current = fetchRecentReadings; }, [fetchRecentReadings]);
  useEffect(() => { recalculateBaselineRef.current = recalculateBaseline; }, [recalculateBaseline]);

  /**
   * Initial fetch and periodic refresh.
   * Skipped entirely when enabled=false (e.g. doctor sessions).
   */
  useEffect(() => {
    if (!enabled) {
      console.log('[BG Estimation] Disabled — skipping fetch and intervals');
      setIsLoading(false);
      return;
    }

    console.log('[BG Estimation] Hook initialized with', stabilizationHours, 'hour decay');
    fetchRecentReadingsRef.current();

    // Fetch new data periodically
    const fetchInterval = setInterval(() => {
      console.log('[BG Estimation] Auto-refresh triggered');
      fetchRecentReadingsRef.current();
    }, refreshInterval);

    // Recalculate baseline every minute (applies decay without fetching)
    const recalcInterval = setInterval(() => {
      recalculateBaselineRef.current();
    }, 60 * 1000); // Every minute

    return () => {
      console.log('[BG Estimation] Hook cleanup');
      clearInterval(fetchInterval);
      clearInterval(recalcInterval);
      isFetchingRef.current = false;
    };
  // fetchRecentReadings / recalculateBaseline intentionally EXCLUDED — the ref
  // pattern above handles updates without causing infinite re-registration.
  }, [enabled, refreshInterval, stabilizationHours]);

  return {
    estimatedBG,
    recentReadings,
    combinedData, // 🔥 Expose combined data like web context
    isLoading,
    error,
    refresh,
    // 🔥 Expose the decay model for use by other components
    modelBloodGlucose,
    stabilizationHours, // Expose current stabilization setting
  };
};

export default useBloodGlucoseEstimation;