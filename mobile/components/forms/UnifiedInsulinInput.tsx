/**
 * Unified Insulin Input
 * Location: mobile/components/forms/UnifiedInsulinInput.tsx
 *
 * Main Component: UnifiedInsulinInput
 * Description: Insulin dose input component with UTC timestamp handling,
 *              properly handles UTC storage and local display
 *
 * Features:
 * - Insulin type selection by category (rapid/short/intermediate/long)
 * - Dose validation with range limits
 * - Suggested dose display
 * - UTC timestamp management via UnifiedTimePicker
 * - Optional notes field
 * - Real-time validation feedback
 * - Correction suggestion card (standalone mode only — not shown in MealForm)
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView, ActivityIndicator } from 'react-native';

// Constants
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import { DEFAULT_PATIENT_CONSTANTS, getInsulinsByType, getCircadianBaseline, type MedicationFactor } from '@/constants/shared-constants';

// Utils
import { validateInsulinDose, INSULIN_LIMITS } from '@/utils/validation';
import { TimeManager } from '@/utils/time';

// Components
import UnifiedTimePicker, { type TimeMode } from './UnifiedTimePicker';

// Services & hooks (used only in standalone mode)
import { useActiveEffects } from '@/hooks/useActiveEffects';
import { usePatientConstants } from '@/hooks/usePatientConstants';

// Types
interface InsulinProfileWithId extends MedicationFactor {
  id: string;
  name?: string;
}

export interface InsulinData {
  medication: string;
  dose: number;
  timestamp: string; // ISO string in UTC
  notes?: string;
  mealType?: string;
  bloodSugar?: number;
  timestampMode?: 'now' | 'custom'; // ✅ lets MealForm snap meal time from live clock when in "now" mode
}

interface UnifiedInsulinInputProps {
  onChange: (data: InsulinData) => void;
  suggestedDose?: number;
  suggestedType?: string;
  mealType?: string;
  bloodSugar?: number;
  initialDose?: string;
  initialMedication?: string;
  initialTimestamp?: Date | string;
  initialMode?: TimeMode;
  initialNotes?: string;
  standalone?: boolean;
  disabled?: boolean;
  showTimestampSelector?: boolean;
  showSuggestion?: boolean;
  showNotes?: boolean;
}

const INSULIN_CATEGORIES = [
  { id: 'rapid', label: 'Rapid Acting', color: colors.insulin?.rapid || '#4caf50' },
  { id: 'short', label: 'Short Acting', color: colors.insulin?.short || '#8bc34a' },
  { id: 'intermediate', label: 'Intermediate', color: colors.insulin?.intermediate || '#ff9800' },
  { id: 'long', label: 'Long Acting', color: colors.insulin?.long || '#9c27b0' },
];

// ─── Suggestion engine (correction-only, no food context) ─────────────────────

interface CorrectionSuggestion {
  // ── One-sentence headline the patient reads first ───────────────────────────
  header: string;
  headerColor: string;

  // ── Supporting data (always visible, compact rows) ──────────────────────────
  estimatedBG: number | null;
  activeMealEffect:    { grams: number; pendingRise: number } | null;
  activeInsulinEffect: { units: number; pendingDrop: number } | null;
  projectedBG: number | null;
  projectedContext: string;

  // ── Correction dose — null = no dose row ───────────────────────────────────
  correctionDose:    number | null;
  correctionType:    string | null;
  correctionFormula: string | null;

  type: 'rapid' | 'long' | 'none';
  caution?: string;
  bgSource?: 'reading' | 'estimated' | 'circadian';
}

// ─── buildSuggestion ─────────────────────────────────────────────────────────

function buildSuggestion(
  estimatedBG: number | null,
  projectedBG: number | null,
  iob: number,
  pendingInsulinReduction: number,
  pendingMealRise: number,
  mob: number,
  targetBG: number,
  correctionFactor: number,
  bgSource?: 'reading' | 'estimated' | 'circadian',
): CorrectionSuggestion {
  const hour    = new Date().getHours();
  const isNight = hour >= 22 || hour < 6;

  const activeMealEffect: CorrectionSuggestion['activeMealEffect'] =
    mob > 0.5 ? { grams: mob, pendingRise: pendingMealRise } : null;
  const activeInsulinEffect: CorrectionSuggestion['activeInsulinEffect'] =
    iob > 0.05 ? { units: iob, pendingDrop: pendingInsulinReduction } : null;

  // ── No BG reading ─────────────────────────────────────────────────────────
  if (estimatedBG === null) {
    if (isNight) {
      return {
        header: 'No reading — nighttime basal dose likely',
        headerColor: '#6a1b9a',
        estimatedBG: null, activeMealEffect, activeInsulinEffect,
        projectedBG: null, projectedContext: '',
        correctionDose: null, correctionType: null, correctionFormula: null,
        type: 'long',
        bgSource,
      };
    }
    return {
      header: 'No BG reading — check before dosing',
      headerColor: '#e64a19',
      estimatedBG: null, activeMealEffect, activeInsulinEffect,
      projectedBG: null, projectedContext: '',
      correctionDose: null, correctionType: null, correctionFormula: null,
      type: 'rapid',
      caution: 'Check your blood sugar before dosing.',
      bgSource,
    };
  }

  const netPendingBG   = pendingMealRise - pendingInsulinReduction;
  const projectedValue = projectedBG ?? estimatedBG + netPendingBG;

  const netCorrectionUnits = (projectedValue - targetBG) / correctionFactor;

  // ── BG going low ─────────────────────────────────────────────────────────
  if (estimatedBG < targetBG - 10 || projectedValue < targetBG - 10) {
    return {
      header: 'Your blood sugar is going low — please consider taking a snack as soon as possible',
      headerColor: '#0d47a1',
      estimatedBG, activeMealEffect, activeInsulinEffect,
      projectedBG: projectedValue, projectedContext: 'when effects clear',
      correctionDose: null, correctionType: null, correctionFormula: null,
      type: 'none',
      caution: iob > 0.5
        ? `${iob.toFixed(1)}u of active insulin may lower it further — do not dose.`
        : undefined,
      bgSource,
    };
  }

  // ── IOB will handle it ────────────────────────────────────────────────────
  if (projectedValue <= targetBG + 20) {
    return {
      header: "It's OK — you don't need correction insulin right now",
      headerColor: '#2e7d32',
      estimatedBG, activeMealEffect, activeInsulinEffect,
      projectedBG: projectedValue, projectedContext: 'projected when effects clear',
      correctionDose: null, correctionType: null, correctionFormula: null,
      type: 'none',
      caution: 'Your active insulin is already bringing BG toward target. Dosing now risks a low.',
      bgSource,
    };
  }

  // ── BG at / below target ──────────────────────────────────────────────────
  if (estimatedBG <= targetBG) {
    if (isNight) {
      return {
        header: "It's OK — BG at target, nighttime basal dose likely",
        headerColor: '#6a1b9a',
        estimatedBG, activeMealEffect, activeInsulinEffect,
        projectedBG: projectedValue, projectedContext: 'when effects clear',
        correctionDose: null, correctionType: null, correctionFormula: null,
        type: 'long',
        caution: iob > 1
          ? `You have ${iob.toFixed(1)}u active — confirm basal is due.`
          : undefined,
        bgSource,
      };
    }
    return {
      header: "It's OK — you don't need correction insulin",
      headerColor: '#2e7d32',
      estimatedBG, activeMealEffect, activeInsulinEffect,
      projectedBG: projectedValue, projectedContext: 'when effects clear',
      correctionDose: null, correctionType: null, correctionFormula: null,
      type: 'none',
      caution: 'If logging a scheduled basal, select Long-Acting below.',
      bgSource,
    };
  }

  // ── Correction needed ─────────────────────────────────────────────────────
  // projectedValue already nets out both pendingMealRise and pendingInsulinReduction,
  // so we correct from projected BG — avoids double-counting IOB that is already
  // spoken for by active meal carbs.
  const formula = `(${projectedValue.toFixed(0)} projected − ${targetBG} target) ÷ ${correctionFactor} CF\n(active meal & IOB already netted into projected BG)`;
  const dose    = netCorrectionUnits >= 1.0 ? parseFloat(netCorrectionUnits.toFixed(1)) : null;

  return {
    header: dose !== null
      ? `Suggested correction insulin is ~${dose.toFixed(1)}u Rapid-Acting`
      : "It's OK — correction is small, no dose needed",
    headerColor: dose !== null ? '#c62828' : '#e65100',
    estimatedBG, activeMealEffect, activeInsulinEffect,
    projectedBG: projectedValue, projectedContext: 'projected without correction',
    correctionDose: dose,
    correctionType: dose !== null ? 'Rapid-Acting' : null,
    correctionFormula: dose !== null ? formula : null,
    type: 'rapid',
    caution: mob > 20
      ? `${mob.toFixed(0)}g active meal carbs already factored in.`
      : undefined,
    bgSource,
  };
}

// ─── Suggestion card component ────────────────────────────────────────────────

const SuggestionCard: React.FC<{ suggestion: CorrectionSuggestion }> = ({ suggestion }) => {
  const [showFormula, setShowFormula]           = useState(false);
  const [showActiveEffects, setShowActiveEffects] = useState(false);

  const hasActiveEffects =
    suggestion.activeMealEffect !== null || suggestion.activeInsulinEffect !== null;
  const hasDetails =
    suggestion.estimatedBG !== null || hasActiveEffects || suggestion.projectedBG !== null;

  // Net pending BG change from active meal/insulin effects — shown in the collapsed header
  const netPending = (() => {
    const rise = suggestion.activeMealEffect?.pendingRise  ?? 0;
    const drop = suggestion.activeInsulinEffect?.pendingDrop ?? 0;
    return rise - drop;
  })();
  const netLabel  = netPending >= 0 ? `+${netPending.toFixed(0)}` : `${netPending.toFixed(0)}`;
  const netColor  = netPending > 10 ? '#e65100' : netPending < -10 ? '#1565c0' : '#2e7d32';

  return (
    <View style={[suggStyles.card, { borderLeftColor: suggestion.headerColor }]}>

      {/* ── Header — one clear patient-facing sentence ── */}
      <View style={[suggStyles.header, { backgroundColor: suggestion.headerColor + '14' }]}>
        <Text style={[suggStyles.headerText, { color: suggestion.headerColor }]}>
          {suggestion.header}
        </Text>
        {suggestion.bgSource === 'circadian' && (
          <Text style={{ fontSize: 10, color: '#6a1b9a', marginTop: 4, fontStyle: 'italic' }}>
            🌙 BG from circadian baseline
          </Text>
        )}
      </View>

      {/* ── Compact data rows ── */}
      {hasDetails && (
        <View style={suggStyles.dataBlock}>

          {/* Current BG — always visible */}
          {suggestion.estimatedBG !== null && (
            <View style={suggStyles.dataRow}>
              <Text style={suggStyles.dataLabel}>📊 Current BG</Text>
              <Text style={[suggStyles.dataValue, { color: suggestion.headerColor }]}>
                {suggestion.estimatedBG.toFixed(0)}{' '}
                <Text style={suggStyles.dataUnit}>mg/dL</Text>
              </Text>
            </View>
          )}

          {/* ── Active effects — collapsed by default ── */}
          {hasActiveEffects && (
            <>
              {/* Collapsed header row — always visible, tappable to expand */}
              <TouchableOpacity
                style={suggStyles.activeEffectsHeader}
                onPress={() => setShowActiveEffects(v => !v)}
                activeOpacity={0.75}
              >
                <Text style={suggStyles.dataLabel}>⚡ Active effects</Text>
                <View style={suggStyles.activeEffectsHeaderRight}>
                  <Text style={[suggStyles.activeEffectsNet, { color: netColor }]}>
                    {netLabel}{' '}
                    <Text style={suggStyles.dataUnit}>mg/dL net</Text>
                  </Text>
                  <Text style={suggStyles.activeEffectsChevron}>
                    {showActiveEffects ? '▲' : '▼'}
                  </Text>
                </View>
              </TouchableOpacity>

              {/* Expanded rows */}
              {showActiveEffects && (
                <View style={suggStyles.activeEffectsBody}>
                  {suggestion.activeMealEffect && (
                    <View style={[suggStyles.dataRow, suggStyles.activeEffectsInnerRow]}>
                      <Text style={suggStyles.dataLabel}>🍽️ Meal still raising</Text>
                      <Text style={[suggStyles.dataValue, { color: '#e65100' }]}>
                        +{suggestion.activeMealEffect.pendingRise.toFixed(0)}{' '}
                        <Text style={suggStyles.dataUnit}>
                          mg/dL  ({suggestion.activeMealEffect.grams.toFixed(0)}g active)
                        </Text>
                      </Text>
                    </View>
                  )}
                  {suggestion.activeInsulinEffect && (
                    <View style={[suggStyles.dataRow, suggStyles.activeEffectsInnerRow]}>
                      <Text style={suggStyles.dataLabel}>💉 Insulin working</Text>
                      <Text style={[suggStyles.dataValue, { color: '#1565c0' }]}>
                        −{suggestion.activeInsulinEffect.pendingDrop.toFixed(0)}{' '}
                        <Text style={suggStyles.dataUnit}>
                          mg/dL  ({suggestion.activeInsulinEffect.units.toFixed(1)}u IOB)
                        </Text>
                      </Text>
                    </View>
                  )}
                </View>
              )}
            </>
          )}

          {/* Projected BG — always visible */}
          {suggestion.projectedBG !== null && !!suggestion.projectedContext && (
            <View style={[suggStyles.dataRow, suggStyles.dataRowProjected]}>
              <Text style={suggStyles.dataLabel}>🎯 Projected BG</Text>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[suggStyles.dataValue, { color: suggestion.headerColor }]}>
                  {suggestion.projectedBG.toFixed(0)}{' '}
                  <Text style={suggStyles.dataUnit}>mg/dL</Text>
                </Text>
                <Text style={suggStyles.projectedCtx}>{suggestion.projectedContext}</Text>
              </View>
            </View>
          )}
        </View>
      )}

      {/* ── Correction dose (only when ≥ 1.0u) ── */}
      {suggestion.correctionDose !== null && (
        <>
          <View style={suggStyles.divider} />
          <TouchableOpacity
            style={suggStyles.correctionRow}
            onPress={() => setShowFormula(v => !v)}
            activeOpacity={0.75}
          >
            <View style={{ flex: 1 }}>
              <Text style={suggStyles.correctionLabel}>Suggested dose</Text>
              <Text style={[suggStyles.correctionDose, { color: suggestion.headerColor }]}>
                ~{suggestion.correctionDose.toFixed(1)}u{'  '}
                <Text style={suggStyles.correctionType}>{suggestion.correctionType}</Text>
              </Text>
            </View>
            <Text style={[suggStyles.formulaToggle, { color: suggestion.headerColor }]}>
              {showFormula ? 'Hide ▲' : 'How? ▼'}
            </Text>
          </TouchableOpacity>
          {showFormula && suggestion.correctionFormula && (
            <View style={suggStyles.formulaBody}>
              <Text style={suggStyles.formulaText}>{suggestion.correctionFormula}</Text>
            </View>
          )}
        </>
      )}

      {/* ── Caution ── */}
      {!!suggestion.caution && (
        <View style={suggStyles.cautionRow}>
          <Text style={suggStyles.cautionText}>⚠️  {suggestion.caution}</Text>
        </View>
      )}

      <Text style={suggStyles.disclaimer}>
        Always follow your doctor's prescription. Informational only.
      </Text>
    </View>
  );
};

const suggStyles = StyleSheet.create({
  // ── Card shell ──────────────────────────────────────────────────────────────
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    marginBottom: 14,
    overflow: 'hidden',
    borderLeftWidth: 4,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 4,
  },
  // ── Header band ─────────────────────────────────────────────────────────────
  header: {
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  headerText: {
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
  },
  // ── Compact data block ───────────────────────────────────────────────────────
  dataBlock: {
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  dataRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#f5f5f5',
  },
  dataRowProjected: {
    backgroundColor: '#fafafa',
  },
  dataLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: '#666',
    flex: 1,
  },
  dataValue: {
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'right',
  },
  dataUnit: {
    fontSize: 11,
    fontWeight: '400',
    color: '#888',
  },
  projectedCtx: {
    fontSize: 10,
    color: '#aaa',
    marginTop: 1,
    textAlign: 'right',
  },
  // ── Active effects collapsible ────────────────────────────────────────────
  activeEffectsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#f5f5f5',
  },
  activeEffectsHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  activeEffectsNet: {
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'right',
  },
  activeEffectsChevron: {
    fontSize: 10,
    color: '#aaa',
    fontWeight: '600',
    marginLeft: 4,
  },
  activeEffectsBody: {
    backgroundColor: '#fafcff',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  activeEffectsInnerRow: {
    paddingLeft: 22,   // indent under the parent row
    backgroundColor: 'transparent',
    borderBottomColor: '#f0f4f8',
  },
  // ── Divider ─────────────────────────────────────────────────────────────────
  divider: {
    height: 1,
    backgroundColor: '#ececec',
  },
  // ── Correction row ───────────────────────────────────────────────────────────
  correctionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  correctionLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: '#999',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  correctionDose: {
    fontSize: 18,
    fontWeight: '800',
  },
  correctionType: {
    fontSize: 13,
    fontWeight: '500',
    color: '#555',
  },
  formulaToggle: {
    fontSize: 12,
    fontWeight: '600',
    paddingLeft: 10,
  },
  formulaBody: {
    backgroundColor: '#fafafa',
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  formulaText: {
    fontSize: 12,
    color: '#666',
    fontFamily: 'monospace',
    lineHeight: 18,
  },
  // ── Caution ─────────────────────────────────────────────────────────────────
  cautionRow: {
    backgroundColor: '#fff8e1',
    borderTopWidth: 1,
    borderTopColor: '#ffe082',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  cautionText: {
    fontSize: 12,
    color: '#795548',
    lineHeight: 17,
  },
  // ── Disclaimer ───────────────────────────────────────────────────────────────
  disclaimer: {
    fontSize: 10,
    color: '#bbb',
    fontStyle: 'italic',
    marginTop: 6,
    marginBottom: 8,
    marginHorizontal: 14,
  },
  // ── Loading state ────────────────────────────────────────────────────────────
  loadingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.surfaceVariant,
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
  },
  loadingText: {
    fontSize: 13,
    color: colors.text.secondary,
  },
});

// ─── Main component ───────────────────────────────────────────────────────────

const UnifiedInsulinInput: React.FC<UnifiedInsulinInputProps> = ({
  onChange,
  suggestedDose,
  suggestedType,
  mealType,
  bloodSugar,
  initialDose = '',
  initialMedication = '',
  initialTimestamp,
  initialMode = 'now',
  initialNotes = '',
  standalone = false,
  disabled = false,
  showTimestampSelector = true,
  showSuggestion = true,
  showNotes = true,
  activeEffectsSnapshot,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<string>('rapid');
  const [selectedInsulin, setSelectedInsulin] = useState<string>(initialMedication || suggestedType || '');
  const [dose, setDose] = useState(initialDose || suggestedDose?.toString() || '');
  const [notes, setNotes] = useState(initialNotes);
  const [timestampUTC, setTimestampUTC] = useState<string>(
    initialTimestamp ? new Date(initialTimestamp).toISOString() : new Date().toISOString()
  );
  const [timestampMode, setTimestampMode] = useState<TimeMode>(initialMode);
  const [error, setError] = useState<string | null>(null);

  // Standalone-only: active effects for correction suggestion card.
  //
  // useActiveEffects is called unconditionally (rules of hooks) but with
  // autoRefresh: standalone so it only fetches and calculates when this
  // component is rendered in standalone mode. In embedded mode (standalone=false)
  // the hook returns empty/null values and the suggestion card is never shown.
  //
  // ── Active effects source ────────────────────────────────────────────────
  //
  // PREFERRED: parent passes activeEffectsSnapshot → use those values directly.
  // This guarantees the suggestion card is bit-for-bit identical to
  // ActiveEffectsDisplay — no independent fetch, no timing skew.
  //
  // FALLBACK: no snapshot provided → run our own useActiveEffects instance.
  const { constants } = usePatientConstants();
  const hasSnapshot = !!activeEffectsSnapshot;
  const {
    estimatedBG:      hookEstimatedBG,
    projectedFinalBG: hookProjectedFinalBG,
    totalIOB:         hookIOB,
    totalMOB:         hookMOB,
    isLoading:        hookEffectsLoading,
    baselineMode:     hookBaselineMode,
  } = useActiveEffects({ autoRefresh: standalone && !hasSnapshot, windowHours: 24 });

  // Resolve which source to use — snapshot wins when available
  const effectsLoading      = hasSnapshot ? false : hookEffectsLoading;
  const resolvedEstBG       = hasSnapshot ? activeEffectsSnapshot!.estimatedBG        : hookEstimatedBG;
  const resolvedProjBG      = hasSnapshot ? activeEffectsSnapshot!.projectedFinalBG   : hookProjectedFinalBG;
  const resolvedIOB         = hasSnapshot ? activeEffectsSnapshot!.totalIOB           : hookIOB;
  const resolvedMOB         = hasSnapshot ? activeEffectsSnapshot!.totalMOB           : hookMOB;
  const resolvedMode        = hasSnapshot ? activeEffectsSnapshot!.baselineMode       : hookBaselineMode;
  const resolvedPendingDrop = hasSnapshot
    ? activeEffectsSnapshot!.pendingBGReduction
    : hookIOB * ((constants as any)?.correction_factor ?? 40);
  const resolvedPendingRise = hasSnapshot
    ? activeEffectsSnapshot!.pendingBGRise
    : hookMOB * ((constants as any)?.carb_to_bg_factor ?? 4);

  // Derive correction suggestion from active effects (standalone only).
  const suggestion = useMemo<CorrectionSuggestion | null>(() => {
    if (!standalone) return null;

    const targetBG         = (constants as any)?.target_glucose    ?? 100;
    const correctionFactor = (constants as any)?.correction_factor ?? 40;
    const carbToBgFactor   = (constants as any)?.carb_to_bg_factor ?? 4;

    const estimatedBG = resolvedEstBG;

    const bgSource: CorrectionSuggestion['bgSource'] =
      resolvedMode === 'preset' ? 'circadian' :
      estimatedBG !== null      ? 'reading'   : undefined;

    // Pending components — from snapshot when available (exact match to
    // ActiveEffectsDisplay), otherwise approximated from IOB/MOB scalars.
    const pendingInsulinReduction = resolvedPendingDrop;
    const pendingMealRise         = resolvedPendingRise;

    // Projected BG — from snapshot (ActiveEffectsDisplay Card-3) or derived
    // as estimatedBG + pendingNetEffect (avoids old IOB double-count bug).
    const pendingNetEffect = pendingMealRise - pendingInsulinReduction;
    const projectedBG = hasSnapshot
      ? resolvedProjBG
      : (estimatedBG !== null ? estimatedBG + pendingNetEffect : null);

    // ── DEBUG ───────────────────────────────────────────────────────────────
    console.log('[UnifiedInsulinInput] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('[UnifiedInsulinInput] source       :', hasSnapshot ? '✅ SNAPSHOT (identical to ActiveEffectsDisplay)' : '⚠️  HOOK (independent fetch — may differ)');
    console.log('[UnifiedInsulinInput] estimatedBG  :', estimatedBG);
    console.log('[UnifiedInsulinInput] projectedBG  :', projectedBG?.toFixed(1), hasSnapshot ? '(snapshot)' : '(derived)');
    console.log('[UnifiedInsulinInput] hookProjBG   :', hookProjectedFinalBG?.toFixed(1), '(hook raw, for comparison)');
    console.log('[UnifiedInsulinInput] pendingRise  :', pendingMealRise.toFixed(1));
    console.log('[UnifiedInsulinInput] pendingDrop  :', pendingInsulinReduction.toFixed(1));
    console.log('[UnifiedInsulinInput] pendingNet   :', pendingNetEffect.toFixed(1));
    console.log('[UnifiedInsulinInput] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const result = buildSuggestion(
      estimatedBG, projectedBG, resolvedIOB,
      pendingInsulinReduction, pendingMealRise, resolvedMOB,
      targetBG, correctionFactor, bgSource,
    );

    console.log('[UnifiedInsulinInput] 🎯 projectedBG:', result.projectedBG, ' corrDose:', result.correctionDose);
    return result;
  }, [
    standalone, hasSnapshot,
    resolvedEstBG, resolvedProjBG, resolvedIOB, resolvedMOB,
    resolvedPendingDrop, resolvedPendingRise, resolvedMode,
    hookProjectedFinalBG, constants,
  ]);

  const isInitialMount = useRef(true);

  const numericDose = parseFloat(dose);
  const isValidDose = !isNaN(numericDose) && numericDose >= INSULIN_LIMITS.MIN && numericDose <= INSULIN_LIMITS.MAX;

  // Get all insulin profiles from shared constants
  const ALL_INSULIN_PROFILES_ARRAY = useMemo(() => {
    const medications = DEFAULT_PATIENT_CONSTANTS.medication_factors;
    return Object.entries(medications).map(([id, profile]) => ({
      id,
      ...profile,
      name: profile.brand_names?.[0] || id.replace(/_/g, ' '),
    })) as InsulinProfileWithId[];
  }, []);

  // Get insulin profiles by category
  const getInsulinsByCategory = (category: string): InsulinProfileWithId[] => {
    return ALL_INSULIN_PROFILES_ARRAY.filter((profile) => {
      switch (category) {
        case 'rapid':
          return profile.type === 'rapid_acting' || profile.type === 'ultra_rapid_acting';
        case 'short':
          return profile.type === 'short_acting';
        case 'intermediate':
          return profile.type === 'intermediate_acting';
        case 'long':
          return profile.type === 'long_acting' || profile.type === 'ultra_long_acting';
        default:
          return false;
      }
    });
  };

  const insulinsInCategory = getInsulinsByCategory(selectedCategory);

  // Set initial category based on selected insulin
  useEffect(() => {
    if (selectedInsulin) {
      const profile = ALL_INSULIN_PROFILES_ARRAY.find(p => p.id === selectedInsulin);
      if (profile) {
        const categoryMap: Record<string, string> = {
          'rapid_acting': 'rapid',
          'short_acting': 'short',
          'intermediate_acting': 'intermediate',
          'long_acting': 'long',
        };
        const cat = categoryMap[profile.type];
        if (cat) setSelectedCategory(cat);
      }
    }
  }, []);

  // Notify parent of changes (debounced)
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    if (selectedInsulin && isValidDose) {
      const timeoutId = setTimeout(() => {
        console.log('[UnifiedInsulinInput] Triggering callback with UTC:', timestampUTC);
        onChange({
          medication: selectedInsulin,
          dose: numericDose,
          timestamp: timestampUTC,
          timestampMode,
          notes,
          mealType,
          bloodSugar,
        });
      }, 300);

      return () => clearTimeout(timeoutId);
    }
  }, [selectedInsulin, numericDose, timestampUTC, notes]);

  const handleDoseChange = (text: string) => {
    setDose(text);
    setError(null);

    const value = parseFloat(text);
    if (text && !isNaN(value)) {
      const validation = validateInsulinDose(value);
      if (!validation.isValid) {
        setError(validation.error || 'Invalid dose');
      }
    }
  };

  const handleTimeChange = (utcIsoString: string) => {
    console.log('[UnifiedInsulinInput] Time changed to:', utcIsoString);
    setTimestampUTC(utcIsoString);
  };

  const handleModeChange = (newMode: TimeMode) => {
    setTimestampMode(newMode);
  };

  return (
    <View style={[styles.container, !standalone && styles.containerEmbedded]}>
      {standalone && <Text style={styles.title}>Insulin Dose</Text>}

      {/* ── Correction suggestion card (standalone only) ──────────────────── */}
      {standalone && (
        effectsLoading ? (
          <View style={suggStyles.loadingCard}>
            <ActivityIndicator color={colors.primary} size="small" />
            <Text style={suggStyles.loadingText}>Checking active effects…</Text>
          </View>
        ) : suggestion ? (
          <SuggestionCard suggestion={suggestion} />
        ) : null
      )}

      {/* Suggested Dose (numeric pill — shown in MealForm when suggestedDose is provided) */}
      {showSuggestion && suggestedDose && (
        <View style={styles.suggestionBox}>
          <Text style={styles.suggestionLabel}>Suggested Dose</Text>
          <Text style={styles.suggestionValue}>{suggestedDose.toFixed(1)} units</Text>
        </View>
      )}

      {/* Insulin Category Selector */}
      <Text style={styles.label}>Insulin Type</Text>
      <View style={styles.categoryTabs}>
        {INSULIN_CATEGORIES.map((category) => (
          <TouchableOpacity
            key={category.id}
            style={[
              styles.categoryTab,
              selectedCategory === category.id && {
                backgroundColor: category.color,
                borderColor: category.color,
              },
            ]}
            onPress={() => {
              setSelectedCategory(category.id);
              setSelectedInsulin('');
            }}
            disabled={disabled}
          >
            <Text
              style={[
                styles.categoryTabText,
                selectedCategory === category.id && styles.categoryTabTextActive,
              ]}
            >
              {category.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Insulin Selector */}
      <ScrollView style={styles.insulinList} nestedScrollEnabled>
        {insulinsInCategory.map((insulin) => (
          <TouchableOpacity
            key={insulin.id}
            style={[
              styles.insulinOption,
              selectedInsulin === insulin.id && styles.insulinOptionSelected,
            ]}
            onPress={() => setSelectedInsulin(insulin.id)}
            disabled={disabled}
          >
            <View style={styles.insulinInfo}>
              <Text
                style={[
                  styles.insulinName,
                  selectedInsulin === insulin.id && styles.insulinNameSelected,
                ]}
              >
                {insulin.name || insulin.id.replace(/_/g, ' ')}
              </Text>
              <Text style={styles.insulinDetails}>
                Onset: {insulin.onset_hours}h | Peak: {insulin.peak_hours ? `${insulin.peak_hours}h` : 'N/A'} | Duration: {insulin.duration_hours}h
              </Text>
              {insulin.brand_names && insulin.brand_names.length > 0 && (
                <Text style={styles.insulinBrands}>({insulin.brand_names.join(', ')})</Text>
              )}
            </View>
            {selectedInsulin === insulin.id && (
              <View style={styles.checkmark}>
                <Text style={styles.checkmarkText}>✓</Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Dose Input */}
      <Text style={[styles.label, styles.labelSpacing]}>Dose (units)</Text>
      <TextInput
        style={[styles.input, error && styles.inputError]}
        value={dose}
        onChangeText={handleDoseChange}
        placeholder={suggestedDose ? `Suggested: ${suggestedDose.toFixed(1)}` : 'Enter dose'}
        placeholderTextColor={colors.text.secondary}
        keyboardType="decimal-pad"
        editable={!disabled}
      />
      {error && <Text style={styles.errorText}>{error}</Text>}
      <Text style={styles.helperText}>
        Range: {INSULIN_LIMITS.MIN} - {INSULIN_LIMITS.MAX} units
      </Text>

      {/* Unified Time Picker */}
      {showTimestampSelector && (
        <UnifiedTimePicker
          value={timestampUTC}
          onChange={handleTimeChange}
          mode={timestampMode}
          onModeChange={handleModeChange}
          disabled={disabled}
          label="Administration Time"
          displayFormat="datetime"
        />
      )}

      {/* Notes — hidden when embedded (e.g. in MealForm) */}
      {showNotes && (
        <>
          <Text style={[styles.label, styles.labelSpacing]}>Notes (optional)</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={notes}
            onChangeText={setNotes}
            placeholder="Add any notes..."
            placeholderTextColor={colors.text.secondary}
            multiline
            numberOfLines={2}
            textAlignVertical="top"
            editable={!disabled}
          />
        </>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  containerEmbedded: {
    backgroundColor: 'transparent',
    borderRadius: 0,
    padding: 0,
    marginBottom: 0,
  },
  title: {
    ...typography.h3,
    color: colors.text.primary,
    marginBottom: spacing.md,
  },
  suggestionBox: {
    backgroundColor: colors.primary + '10',
    borderRadius: borderRadius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    alignItems: 'center',
  },
  suggestionLabel: {
    ...typography.caption,
    color: colors.primary,
    marginBottom: spacing.xs,
  },
  suggestionValue: {
    ...typography.h2,
    color: colors.primary,
  },
  label: {
    ...typography.caption,
    color: colors.text.primary,
    fontWeight: '500',
    marginBottom: spacing.xs,
  },
  labelSpacing: {
    marginTop: spacing.md,
  },
  categoryTabs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  categoryTab: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  categoryTabText: {
    ...typography.small,
    color: colors.text.secondary,
  },
  categoryTabTextActive: {
    color: colors.text.inverse,
    fontWeight: '600',
  },
  insulinList: {
    maxHeight: 200,
    marginBottom: spacing.md,
  },
  insulinOption: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    marginBottom: spacing.xs,
    backgroundColor: colors.surface,
  },
  insulinOptionSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary + '10',
  },
  insulinInfo: {
    flex: 1,
  },
  insulinName: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '500',
  },
  insulinNameSelected: {
    color: colors.primary,
  },
  insulinDetails: {
    ...typography.small,
    color: colors.text.secondary,
    marginTop: 2,
  },
  insulinBrands: {
    ...typography.caption,
    color: colors.text.secondary,
    marginTop: 2,
    fontStyle: 'italic',
  },
  checkmark: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkmarkText: {
    color: colors.text.inverse,
    fontWeight: 'bold',
  },
  input: {
    backgroundColor: colors.surfaceVariant,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    fontSize: 16,
    color: colors.text.primary,
  },
  inputError: {
    borderColor: colors.danger,
  },
  textArea: {
    height: 80,
  },
  errorText: {
    ...typography.caption,
    color: colors.danger,
    marginTop: spacing.xs,
  },
  helperText: {
    ...typography.caption,
    color: colors.text.secondary,
    marginTop: spacing.xs,
  },
});

export default UnifiedInsulinInput;