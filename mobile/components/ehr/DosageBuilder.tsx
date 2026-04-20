import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

export interface DosageValue {
  morning: number;
  noon: number;
  evening: number;
  night: number;
}

export interface DosageBuilderProps {
  value: DosageValue;
  unit: string;
  onChange: (v: DosageValue) => void;
  onUnitChange: (unit: string) => void;
  disabled?: boolean;
}

const SLOT_CONFIG: Array<{ key: keyof DosageValue; label: string }> = [
  { key: 'morning', label: 'Morgens' },
  { key: 'noon', label: 'Mittags' },
  { key: 'evening', label: 'Abends' },
  { key: 'night', label: 'Nachts' },
];

const UNIT_OPTIONS = ['Tablette', 'Kapsel', 'ml', 'IE', 'Hub', 'Tropfen'] as const;
const STEP = 0.5;
const MIN = 0;
const MAX = 10;

function clampDose(value: number): number {
  return Math.min(MAX, Math.max(MIN, Math.round(value / STEP) * STEP));
}

function formatDose(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function unitForSummary(unit: string): string {
  if (unit === 'Tablette') return 'Tabletten';
  if (unit === 'Kapsel') return 'Kapseln';
  return unit;
}

export default function DosageBuilder({ value, unit, onChange, onUnitChange, disabled = false }: DosageBuilderProps) {
  const totalDose = value.morning + value.noon + value.evening + value.night;

  const dosageLabel = useMemo(
    () => `${formatDose(value.morning)}-${formatDose(value.noon)}-${formatDose(value.evening)}-${formatDose(value.night)}`,
    [value]
  );

  const setSlot = (slot: keyof DosageValue, next: number) => {
    if (disabled) return;
    onChange({ ...value, [slot]: clampDose(next) });
  };

  return (
    <View style={styles.container}>
      <Text style={styles.sectionLabel}>Dosierung (Morgens-Mittags-Abends-Nachts)</Text>

      <View style={styles.slotsRow}>
        {SLOT_CONFIG.map((slot) => {
          const slotValue = value[slot.key];
          const isInactive = slotValue === 0;

          return (
            <View key={slot.key} style={styles.slotColumn}>
              <Text style={styles.slotLabel}>{slot.label}</Text>

              <View style={styles.stepperRow}>
                <TouchableOpacity
                  style={[styles.stepperBtn, disabled && styles.stepperBtnDisabled]}
                  onPress={() => setSlot(slot.key, slotValue - STEP)}
                  disabled={disabled || slotValue <= MIN}
                  accessibilityRole="button"
                  accessibilityLabel={`${slot.label} reduzieren`}
                >
                  <Text style={styles.stepperBtnText}>−</Text>
                </TouchableOpacity>

                <View style={[styles.valuePill, isInactive && styles.valuePillInactive]}>
                  <Text style={[styles.valueText, isInactive && styles.valueTextInactive]}>{formatDose(slotValue)}</Text>
                </View>

                <TouchableOpacity
                  style={[styles.stepperBtn, disabled && styles.stepperBtnDisabled]}
                  onPress={() => setSlot(slot.key, slotValue + STEP)}
                  disabled={disabled || slotValue >= MAX}
                  accessibilityRole="button"
                  accessibilityLabel={`${slot.label} erhöhen`}
                >
                  <Text style={styles.stepperBtnText}>+</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        })}
      </View>

      <Text style={styles.sectionLabel}>Dosierungseinheit</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.unitStrip}>
        {UNIT_OPTIONS.map((opt) => {
          const selected = unit === opt;
          return (
            <TouchableOpacity
              key={opt}
              style={[styles.unitChip, selected && styles.unitChipSelected, disabled && styles.unitChipDisabled]}
              onPress={() => onUnitChange(opt)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={`Einheit ${opt}`}
            >
              <Text style={[styles.unitChipText, selected && styles.unitChipTextSelected]}>{opt}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <View style={[styles.summaryLine, totalDose === 0 && styles.summaryWarning]}>
        <Text style={[styles.summaryText, totalDose === 0 && styles.summaryWarningText]}>
          {totalDose === 0 ? 'Keine Dosierung konfiguriert' : `${dosageLabel} ${unitForSummary(unit)}`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md,
  },
  sectionLabel: {
    ...typography.small,
    color: colors.text.primary,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  slotsRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  slotColumn: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    backgroundColor: colors.surface,
    padding: spacing.sm,
    minWidth: 0,
  },
  slotLabel: {
    ...typography.small,
    color: colors.text.secondary,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.xs,
  },
  stepperBtn: {
    width: 28,
    height: 28,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  stepperBtnDisabled: {
    opacity: 0.5,
  },
  stepperBtnText: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '700',
    lineHeight: 20,
  },
  valuePill: {
    flex: 1,
    minHeight: 28,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xs,
  },
  valuePillInactive: {
    backgroundColor: colors.surfaceVariant,
    borderWidth: 1,
    borderColor: colors.border,
  },
  valueText: {
    ...typography.small,
    color: colors.text.inverse,
    fontWeight: '700',
  },
  valueTextInactive: {
    color: colors.text.disabled,
  },
  unitStrip: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingBottom: spacing.xs,
    marginBottom: spacing.sm,
  },
  unitChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
  },
  unitChipSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  unitChipDisabled: {
    opacity: 0.6,
  },
  unitChipText: {
    ...typography.small,
    color: colors.text.primary,
    fontWeight: '600',
  },
  unitChipTextSelected: {
    color: colors.text.inverse,
  },
  summaryLine: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceVariant,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  summaryWarning: {
    borderColor: colors.warningLight,
    backgroundColor: colors.warning + '14',
  },
  summaryText: {
    ...typography.small,
    color: colors.text.primary,
    fontWeight: '700',
  },
  summaryWarningText: {
    color: colors.warningDark,
  },
});
