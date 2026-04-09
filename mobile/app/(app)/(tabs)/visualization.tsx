/**
 * Visualization Screen
 * Location: mobile/app/(app)/(tabs)/visualization.tsx
 *
 * Three chart tabs:
 *   📈 Glucose      – BloodGlucoseChart      (pure BG curve — DEFAULT)
 *   ⚡ Effects      – EffectsVisualizationChart (MOB/IOB dual-line + cumulative)
 *   🩸 Blood Glucose – BloodGlucoseVisualization (projected BG + actual readings)
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card } from '@/components/ui';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

import EffectsVisualizationChart  from '@/components/charts/EffectsVisualizationChart';
import BloodGlucoseVisualization  from '@/components/charts/BloodGlucoseVisualization';
import BloodGlucoseChart          from '@/components/charts/BloodGlucoseChart';

// ─────────────────────────────────────────────────────────────
type ActiveChart = 'glucose_chart' | 'effects' | 'blood_glucose';

// ─────────────────────────────────────────────────────────────
export default function VisualizationScreen() {
  // BloodGlucoseChart (pure curve) is the default tab
  const [activeChart, setActiveChart] = useState<ActiveChart>('glucose_chart');
  const [refreshing, setRefreshing]   = useState(false);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 600);
  }, []);

  // ── Tab config ──
  const TABS: { key: ActiveChart; icon: string; label: string }[] = [
    { key: 'glucose_chart', icon: '📈', label: 'Glucose'      },
    { key: 'effects',       icon: '⚡', label: 'Effects'      },
    { key: 'blood_glucose', icon: '🩸', label: 'BG Projected' },
  ];

  const subtitleMap: Record<ActiveChart, string> = {
    glucose_chart: 'Raw glucose curve with time-in-range analysis',
    effects:       'Active meal/insulin effects + cumulative baseline shift',
    blood_glucose: 'Projected BG with actual readings + confidence lines',
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.primary]}
          />
        }
      >
        {/* ── Header ── */}
        <View style={styles.header}>
          <Text style={styles.title}>Blood Glucose Charts</Text>
          <Text style={styles.subtitle}>{subtitleMap[activeChart]}</Text>
        </View>

        {/* ── Chart Type Selector ── */}
        <Card variant="outlined" padding="small" style={styles.selectorCard}>
          <View style={styles.chartSelector}>
            {TABS.map(({ key, icon, label }) => (
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

        {/* ── Charts ── */}
        {/* All three charts are always mounted so their data fetching and state
            survive tab switches. The inactive ones are hidden with display:none. */}
        <Card variant="elevated" padding="none" style={styles.chartCard}>

          {/* 📈 Pure glucose curve (default) */}
          <View style={activeChart !== 'glucose_chart' && styles.hidden}>
            <BloodGlucoseChart
              height={340}
              showControls
              embedded
              defaultView="12h"
            />
          </View>

          {/* ⚡ Effects visualization */}
          <View style={activeChart !== 'effects' && styles.hidden}>
            <EffectsVisualizationChart
              height={340}
              showControls
              embedded
            />
          </View>

          {/* 🩸 Projected BG visualization */}
          <View style={activeChart !== 'blood_glucose' && styles.hidden}>
            <BloodGlucoseVisualization
              height={340}
              showControls
              embedded
            />
          </View>
        </Card>

        {/* ── Legend ── */}
        <Card variant="outlined" padding="medium" style={styles.legendCard}>
          <Text style={styles.legendTitle}>Chart Legend</Text>

          {activeChart === 'glucose_chart' ? (
            <>
              <LegendRow dot="#22c55e"   label="🟢 Target Zone (70–180 mg/dL)"   description="Green line + faint green background" />
              <LegendRow dot="#f97316"   label="🟠 High / Low"                   description="180–250 mg/dL (high) or 54–70 mg/dL (low)" />
              <LegendRow dot="#ef4444"   label="🔴 Very High / Very Low"         description=">250 mg/dL or <54 mg/dL" />
              <LegendRow dashed="#6b7280" label="│ Now Line"                     description="Current time separator" />
              <LegendRow dot="#3b82f6"   label="🔵 Tap any dot"                  description="Opens detailed tooltip with exact value and status" />
            </>
          ) : activeChart === 'effects' ? (
            <>
              <LegendRow dot="#FF9800"    label="🍽️ Meal Effect (MOB)"       description="Active meal absorption – mg/dL rate" />
              <LegendRow dot="#9C27B0"    label="💉 Insulin Effect (IOB)"     description="Active insulin – mg/dL rate (negative)" />
              <LegendRow dashed="#2196F3" label="📊 Net Effect"               description="Current combined rate of change" />
              <LegendRow thick="#4CAF50"  label="📈 Cumulative Baseline ⭐"   description="Accumulated shift from baseline since 7 AM reset" />
              <LegendRow dot="#607D8B"    label="📌 Dose Markers"             description="Meal (orange bars) and insulin (purple bars)" />
            </>
          ) : (
            <>
              <LegendRow dot="#8031A7"    label="🟣 Projected BG (High)"      description="Solid line — high confidence estimate" />
              <LegendRow dashed="#9C27B0" label="🟣 Projected BG (Low)"       description="Dashed line — lower confidence estimate" />
              <LegendRow dashed="#2196F3" label="🔵 T1D Baseline"             description="Stable daily baseline (step line)" />
              <LegendRow dot="#FF9800"    label="🟠 Cumulative Meal Effect"    description="Orange fill above baseline = absorbed carbs" />
              <LegendRow dot="#2196F3"    label="🔵 Cumulative Insulin"        description="Blue fill below baseline = absorbed insulin" />
              <LegendRow dot="#E53935"    label="🔴 Actual Readings"           description="Colour shows status: green = in range, red = low, orange = high" />
            </>
          )}
        </Card>

        {/* ── Technical Details ── */}
        <Card variant="filled" padding="medium" style={styles.helpCard}>
          <Text style={styles.helpTitle}>💡 Technical Details</Text>
          <Text style={styles.helpText}>
            {activeChart === 'glucose_chart' ? (
              <>
                {'• '}
                <Text style={styles.helpBold}>CGM mode</Text>
                {': raw sensor readings rendered as a dense continuous trace\n'}
                {'• '}
                <Text style={styles.helpBold}>SMBG mode</Text>
                {': smoothstep (S-curve) interpolation between fingerstick readings\n'}
                {'• '}
                <Text style={styles.helpBold}>Time in Range (TIR)</Text>
                {' targets ≥70% for most adults with T1D\n'}
                {'• Stats bar updates in real-time as you switch view windows'}
              </>
            ) : activeChart === 'effects' ? (
              <>
                {'• Gamma distribution curves model absorption (S3 guideline)\n'}
                {'• '}
                <Text style={styles.helpBold}>MOB/IOB lookback:</Text>
                {' 8–48 hours depending on view mode\n'}
                {'• '}
                <Text style={styles.helpBold}>Cumulative baseline</Text>
                {' resets at 7 AM (configurable)\n'}
                {'• Tap chart to see detailed tooltip with dose breakdown'}
              </>
            ) : (
              <>
                {'• '}
                <Text style={styles.helpBold}>Projected BG</Text>
                {' = stable baseline + cumulative net effect\n'}
                {'• '}
                <Text style={styles.helpBold}>Persist-at-100%:</Text>
                {' fully absorbed doses remain in the bank balance until reset\n'}
                {'• Confidence degrades with reading age (30 min → high, 90 min → medium, 3h+ → low)\n'}
                {'• Tap any reading dot to inspect the full dose breakdown'}
              </>
            )}
          </Text>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────
// Legend row helper
// ─────────────────────────────────────────────────────────────
const LegendRow = ({
  dot, dashed, thick, label, description,
}: {
  dot?:         string;
  dashed?:      string;
  thick?:       string;
  label:        string;
  description:  string;
}) => (
  <View style={styles.legendItem}>
    {dot    && <View style={[styles.legendDot,  { backgroundColor: dot }]} />}
    {dashed && <View style={[styles.legendDash, { borderColor: dashed, borderWidth: 1.5, borderStyle: 'dashed' }]} />}
    {thick  && <View style={[styles.legendDash, { borderColor: thick,  borderWidth: 3,   borderStyle: 'solid'  }]} />}
    <View style={styles.legendText}>
      <Text style={styles.legendLabel}>{label}</Text>
      <Text style={styles.legendDescription}>{description}</Text>
    </View>
  </View>
);

// ─────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safeArea:  { flex: 1, backgroundColor: colors.background },
  container: { flex: 1 },
  content:   { padding: spacing.md, paddingBottom: spacing.xl },
  header:    { marginBottom: spacing.md },
  title:     { ...typography.h1, color: colors.text.primary },
  subtitle:  { ...typography.body, color: colors.text.secondary, marginTop: spacing.xs },

  selectorCard: { marginBottom: spacing.md },
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

  chartCard: { marginBottom: spacing.md, overflow: 'hidden' },

  // Hide the inactive charts without unmounting them (preserves data + state)
  hidden: { display: 'none' },

  legendCard:        { marginBottom: spacing.md },
  legendTitle:       { ...typography.h3, color: colors.text.primary, marginBottom: spacing.md },
  legendItem:        { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  legendDot:         { width: 16, height: 16, borderRadius: 8, marginRight: spacing.sm },
  legendDash:        { width: 20, height: 0,  marginRight: spacing.sm },
  legendText:        { flex: 1 },
  legendLabel:       { ...typography.body,  color: colors.text.primary,   fontWeight: '600' },
  legendDescription: { ...typography.small, color: colors.text.secondary },

  helpCard: { backgroundColor: colors.primary + '10' },
  helpTitle: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  helpText: { ...typography.small, color: colors.text.secondary, lineHeight: 22 },
  helpBold: { fontWeight: '600', color: colors.text.primary },
});