/**
 * Dashboard / Home Tab Screen
 * Location: mobile/app/(app)/(tabs)/index.tsx
 *
 * Patient-only dashboard. Doctors are immediately redirected to the
 * doctor-dashboard tab so they never trigger patient-only API endpoints.
 *
 * Includes the 3-tab chart visualization section (previously on its own
 * visualization.tsx screen) embedded directly below the Active Effects panel.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RecentMeals, QuickActions } from '@/components/dashboard';
import ActiveEffectsDisplay from '@/components/dashboard/ActiveEffectsDisplay';
import { Card } from '@/components/ui';
import { useAuthStore } from '@/store/auth.store';
import { usePatientConstants } from '@/hooks/usePatientConstants';
import { useBloodGlucoseEstimation } from '@/hooks/useBloodGlucoseEstimation';
import { getMeals } from '@/services/api/meals';
import { getActiveDoses } from '@/services/api/insulin';

import {
  getMealOnBoard,
  getMealTimingAssessment,
  type MealOnBoardResult,
  type MealTimingAssessment,
} from '@/services/api/calculations';

import { getLibreStatus } from '@/services/api/libre';

import EffectsVisualizationChart from '@/components/charts/EffectsVisualizationChart';
import BloodGlucoseVisualization from '@/components/charts/BloodGlucoseVisualization';
import BloodGlucoseChart         from '@/components/charts/BloodGlucoseChart';

import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import type { MealResponse, ActiveInsulinResponse } from '@/types/api';

// ─── Chart tab type ────────────────────────────────────────────────────────────
type ActiveChart = 'glucose_chart' | 'effects' | 'blood_glucose';

const CHART_TABS: { key: ActiveChart; icon: string; label: string }[] = [
  { key: 'glucose_chart', icon: '📈', label: 'Glucose'      },
  { key: 'effects',       icon: '⚡', label: 'Effects'      },
  { key: 'blood_glucose', icon: '🩸', label: 'BG Projected' },
];

// ─────────────────────────────────────────────────────────────────────────────

export default function DashboardScreen() {
  const router = useRouter();
  const { user } = useAuthStore();

  // ── Doctor guard ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (user?.user_type === 'doctor' || user?.user_type === 'admin') {
      router.replace('/(app)/(tabs)/doctor-dashboard');
    }
  }, [user?.user_type]);

  const isDoctor = user?.user_type === 'doctor' || user?.user_type === 'admin';

  const { constants, isLoading: constantsLoading } = usePatientConstants(!isDoctor);

  const {
    estimatedBG,
    recentReadings,
    combinedData,
    isLoading: bgEstimationLoading,
    error: bgEstimationError,
    refresh: refreshBGEstimation,
  } = useBloodGlucoseEstimation({
    targetGlucose: constants?.target_glucose ?? 100,
    refreshInterval: 2 * 60 * 1000,
    stabilizationHours: 3,
  });

  const [refreshing, setRefreshing]       = useState(false);
  const [recentMeals, setRecentMeals]     = useState<MealResponse[]>([]);
  const [activeInsulin, setActiveInsulin] = useState<ActiveInsulinResponse | null>(null);
  const [mealOnBoard, setMealOnBoard]     = useState<MealOnBoardResult | null>(null);
  const [mealTiming, setMealTiming]       = useState<MealTimingAssessment | null>(null);
  const [isLoadingData, setIsLoadingData] = useState(true);

  // ── Chart tab state ────────────────────────────────────────────────────────
  const [activeChart, setActiveChart] = useState<ActiveChart>('glucose_chart');

  const loadDashboardData = useCallback(async () => {
    if (user?.user_type === 'doctor' || user?.user_type === 'admin') return;

    try {
      getLibreStatus(true).catch(() => {});

      const [meals, insulin, mob, timing] = await Promise.all([
        getMeals({ limit: 5 }).catch(() => ({ meals: [], pagination: { total: 0, limit: 5, skip: 0 } })),
        getActiveDoses().catch(() => null),
        getMealOnBoard({ max_hours_back: 12 }).catch(() => null),
        getMealTimingAssessment().catch(() => null),
      ]);

      setRecentMeals(meals.meals);
      setActiveInsulin(insulin);
      setMealOnBoard(mob);
      setMealTiming(timing);
    } catch (error) {
      console.error('Error loading dashboard data:', error);
    } finally {
      setIsLoadingData(false);
    }
  }, [isDoctor]);

  // Re-fetch every time this screen comes into focus so that doses/meals
  // logged on other screens (e.g. insulin.tsx, meal.tsx) are reflected
  // immediately when the user is redirected back here.
  useFocusEffect(
    useCallback(() => {
      loadDashboardData();
      refreshBGEstimation();
    }, [loadDashboardData, refreshBGEstimation])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadDashboardData(), refreshBGEstimation()]);
    setRefreshing(false);
  }, [loadDashboardData, refreshBGEstimation]);

  const handleLogMeal      = () => router.push('/(app)/log/meal');
  const handleLogGlucose   = () => router.push('/(app)/log/glucose');
  const handleLogInsulin   = () => router.push('/(app)/log/insulin');
  const handleLogActivity  = () => router.push('/(app)/log/activity');
  const handleViewHistory  = () => router.push('/(app)/(tabs)/history');

  if (isDoctor) return <View style={styles.safeArea} />;

  return (
    <SafeAreaView style={styles.safeArea} edges={[]}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} />
        }
      >
        {/* ── Welcome ── */}
        <View style={styles.welcomeSection}>
          <Text style={styles.greeting}>
            {`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}`}
          </Text>
          <Text style={styles.userName}>{user?.firstName || 'User'}</Text>
        </View>

        {/* ══════════════════════════════════════════════════════════════════════
            CHARTS SECTION — pinned to top of dashboard
        ══════════════════════════════════════════════════════════════════════ */}

        {/* Tab selector */}
        <Card variant="outlined" padding="small" style={styles.selectorCard}>
          <View style={styles.chartSelector}>
            {CHART_TABS.map(({ key, icon, label }) => (
              <TouchableOpacity
                key={key}
                style={[styles.chartTab, activeChart === key && styles.chartTabActive]}
                onPress={() => setActiveChart(key)}
              >
                <Text style={styles.chartTabIcon}>{icon}</Text>
                <Text style={[
                  styles.chartTabText,
                  activeChart === key && styles.chartTabTextActive,
                ]}>
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </Card>

        {/* Charts (all mounted; inactive ones hidden to preserve data/state) */}
        <Card variant="elevated" padding="none" style={styles.chartCard}>
          <View style={activeChart !== 'glucose_chart' && styles.hidden}>
            <BloodGlucoseChart height={300} showControls embedded defaultView="12h" />
          </View>
          <View style={activeChart !== 'effects' && styles.hidden}>
            <EffectsVisualizationChart height={300} showControls embedded />
          </View>
          <View style={activeChart !== 'blood_glucose' && styles.hidden}>
            <BloodGlucoseVisualization height={300} showControls embedded />
          </View>
        </Card>

        {/* ══════════════════════════════════════════════════════════════════════ */}

        {/* ── Active Effects ── */}
        <ActiveEffectsDisplay
          iobData={activeInsulin}
          mobData={mealOnBoard}
          estimatedBG={estimatedBG}
          timingAssessment={mealTiming}
          correctionFactor={constants?.correction_factor ?? 50}
          isLoading={isLoadingData || bgEstimationLoading}
          compact={false}
          onRefresh={onRefresh}
        />



        {/* ── Quick Actions ── */}
        <QuickActions
          onLogMeal={handleLogMeal}
          onLogGlucose={handleLogGlucose}
          onLogInsulin={handleLogInsulin}
          onLogActivity={handleLogActivity}
        />

        {/* ── Recent Meals ── */}
        <RecentMeals
          meals={recentMeals}
          onMealPress={(meal) => router.push(`/(app)/meal/${meal.id}`)}
          onViewAll={handleViewHistory}
          isLoading={isLoadingData}
        />

        {/* ── Target constants row ── */}
        <Card variant="filled" padding="small" style={styles.targetCard}>
          <View style={styles.targetRow}>
            <View style={styles.targetItem}>
              <Text style={styles.targetValue}>{constants?.target_glucose ?? 100}</Text>
              <Text style={styles.targetLabel}>Target mg/dL</Text>
            </View>
            <View style={styles.targetDivider} />
            <View style={styles.targetItem}>
              <Text style={styles.targetValue}>1:{constants?.insulin_to_carb_ratio ?? 10}</Text>
              <Text style={styles.targetLabel}>I:C Ratio</Text>
            </View>
            <View style={styles.targetDivider} />
            <View style={styles.targetItem}>
              <Text style={styles.targetValue}>{constants?.correction_factor ?? 50}</Text>
              <Text style={styles.targetLabel}>Correction Factor</Text>
            </View>
          </View>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea:  { flex: 1, backgroundColor: colors.background },
  container: { flex: 1 },
  content:   { padding: spacing.md, paddingBottom: spacing.xl },

  welcomeSection: { marginBottom: spacing.lg },
  greeting: { ...typography.body, color: colors.text.secondary },
  userName: { ...typography.h1,   color: colors.text.primary },

  // BG status badge
  bgStatusCard:     { marginBottom: spacing.md },
  bgStatusRow:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  bgStatusLabel:    { ...typography.small, color: colors.text.secondary },
  bgStatusBadge:    { paddingVertical: 4, paddingHorizontal: spacing.sm, borderRadius: 12, backgroundColor: colors.background },
  bgStatusText:     { ...typography.small, fontWeight: '600' },
  bgStatusHint:     { ...typography.caption, color: colors.text.secondary, marginTop: spacing.xs, fontStyle: 'italic' },
  dataQualityRow:   { flexDirection: 'row', justifyContent: 'space-around', marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.divider },
  dataQualityLabel: { ...typography.caption, color: colors.text.secondary },

  // Chart tab selector
  selectorCard: { marginBottom: spacing.sm },
  chartSelector: {
    flexDirection: 'row',
    backgroundColor: colors.background,
    borderRadius: borderRadius.md,
    padding: 4,
  },
  chartTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: borderRadius.sm,
    gap: 4,
  },
  chartTabActive:     { backgroundColor: colors.primary },
  chartTabIcon:       { fontSize: 16 },
  chartTabText:       { ...typography.small, color: colors.text.secondary, fontWeight: '500', fontSize: 11 },
  chartTabTextActive: { color: colors.text.inverse, fontWeight: '600' },

  chartCard: { marginBottom: spacing.sm, overflow: 'hidden' },

  // Hide inactive chart without unmounting (preserves data + state)
  hidden: { display: 'none' },

  // Target constants row
  targetCard: { marginTop: spacing.md },
  targetRow:  { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' },
  targetItem: { alignItems: 'center', flex: 1 },
  targetValue: { ...typography.h3, color: colors.text.primary },
  targetLabel: { ...typography.small, color: colors.text.secondary, marginTop: 2 },
  targetDivider: { width: 1, height: 40, backgroundColor: colors.border },
});