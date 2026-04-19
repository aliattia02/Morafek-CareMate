import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

export interface DosageValue {
  morning: number;
  noon: number;
  evening: number;
  night: number;
}

interface Props {
  value: DosageValue;
  onChange: (value: DosageValue) => void;
  label?: string;
  maxPerSlot?: number;
}

const SLOT_CONFIG: Array<{ key: keyof DosageValue; label: string; short: string }> = [
  { key: 'morning', label: 'Morgen', short: 'M' },
  { key: 'noon', label: 'Mittag', short: 'N' },
  { key: 'evening', label: 'Abend', short: 'A' },
  { key: 'night', label: 'Nacht', short: 'Nacht' },
];

export default function DosageBuilder({
  value,
  onChange,
  label = 'Dosierung (morgens-mittags-abends-nachts)',
  maxPerSlot = 5,
}: Props) {
  const setSlot = (slot: keyof DosageValue, next: number) => {
    const safe = Math.max(0, Math.min(maxPerSlot, next));
    onChange({ ...value, [slot]: safe });
  };

  const dosageLabel = `${value.morning}-${value.noon}-${value.evening}-${value.night}`;

  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label}</Text>

      <View style={styles.summaryBadge}>
        <Text style={styles.summaryText}>{dosageLabel}</Text>
      </View>

      <View style={styles.grid}>
        {SLOT_CONFIG.map((slot) => {
          const slotValue = value[slot.key];
          return (
            <View key={slot.key} style={styles.slotCard}>
              <Text style={styles.slotLabel}>{slot.label}</Text>
              <View style={styles.stepperRow}>
                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => setSlot(slot.key, slotValue - 1)}
                  accessibilityRole="button"
                  accessibilityLabel={`${slot.label} reduzieren`}
                >
                  <Text style={styles.stepperBtnText}>−</Text>
                </TouchableOpacity>

                <View style={styles.valuePill}>
                  <Text style={styles.valueText}>{slotValue}</Text>
                </View>

                <TouchableOpacity
                  style={styles.stepperBtn}
                  onPress={() => setSlot(slot.key, slotValue + 1)}
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md,
  },
  label: {
    ...typography.small,
    color: colors.text.primary,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  summaryBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primary + '12',
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginBottom: spacing.sm,
  },
  summaryText: {
    ...typography.small,
    color: colors.primary,
    fontWeight: '700',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  slotCard: {
    width: '47%',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  slotLabel: {
    ...typography.small,
    color: colors.text.secondary,
    fontWeight: '600',
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stepperBtn: {
    width: 30,
    height: 30,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  stepperBtnText: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '700',
    lineHeight: 20,
  },
  valuePill: {
    minWidth: 40,
    height: 30,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  valueText: {
    ...typography.small,
    color: '#fff',
    fontWeight: '700',
  },
});
