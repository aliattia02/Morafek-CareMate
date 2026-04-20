import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

import { Input } from '@/components/ui';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

export interface ERezeptValue {
  norm_size: 'N1' | 'N2' | 'N3';
  aut_idem: boolean;
  coverage: 'GKV' | 'PKV' | 'Selbstzahler';
  is_chronic: boolean;
  duration_days: number | null;
  end_date: string | null;
  dosage_note: string;
}

export interface ERezeptFieldsProps {
  value: ERezeptValue;
  onChange: (partial: Partial<ERezeptValue>) => void;
  disabled?: boolean;
}

const NORM_SIZE_OPTIONS: Array<ERezeptValue['norm_size']> = ['N1', 'N2', 'N3'];
const COVERAGE_OPTIONS: Array<ERezeptValue['coverage']> = ['GKV', 'PKV', 'Selbstzahler'];

export default function ERezeptFields({ value, onChange, disabled = false }: ERezeptFieldsProps) {
  const [expanded, setExpanded] = useState(false);

  const durationInputValue = useMemo(
    () => (value.duration_days == null ? '' : String(value.duration_days)),
    [value.duration_days]
  );

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.header}
        onPress={() => setExpanded((p) => !p)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="E-Rezept Details ein- oder ausklappen"
      >
        <Text style={styles.headerTitle}>E-Rezept Details</Text>
        <Text style={styles.chevron}>{expanded ? '▴' : '▾'}</Text>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.content}>
          <Text style={styles.sectionLabel}>Normgröße</Text>
          <View style={styles.optionRow}>
            {NORM_SIZE_OPTIONS.map((opt) => {
              const selected = value.norm_size === opt;
              return (
                <TouchableOpacity
                  key={opt}
                  style={[styles.optionChip, selected && styles.optionChipSelected, disabled && styles.optionChipDisabled]}
                  onPress={() => onChange({ norm_size: opt })}
                  disabled={disabled}
                >
                  <Text style={[styles.optionChipText, selected && styles.optionChipTextSelected]}>{opt}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.sectionLabel}>Kostenträger</Text>
          <View style={styles.optionRowWrap}>
            {COVERAGE_OPTIONS.map((opt) => {
              const selected = value.coverage === opt;
              return (
                <TouchableOpacity
                  key={opt}
                  style={[styles.optionChip, selected && styles.optionChipSelected, disabled && styles.optionChipDisabled]}
                  onPress={() => onChange({ coverage: opt })}
                  disabled={disabled}
                >
                  <Text style={[styles.optionChipText, selected && styles.optionChipTextSelected]}>{opt}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.sectionLabel}>Aut-idem (§129 SGB V)</Text>
          <View style={styles.optionRow}>
            <TouchableOpacity
              style={[styles.optionChip, value.aut_idem && styles.optionChipSelected, disabled && styles.optionChipDisabled]}
              onPress={() => onChange({ aut_idem: true })}
              disabled={disabled}
            >
              <Text style={[styles.optionChipText, value.aut_idem && styles.optionChipTextSelected]}>Ja</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.optionChip, !value.aut_idem && styles.optionChipSelected, disabled && styles.optionChipDisabled]}
              onPress={() => onChange({ aut_idem: false })}
              disabled={disabled}
            >
              <Text style={[styles.optionChipText, !value.aut_idem && styles.optionChipTextSelected]}>Nein</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.sectionLabel}>Therapieart</Text>
          <View style={styles.optionRow}>
            <TouchableOpacity
              style={[styles.optionChip, value.is_chronic && styles.optionChipSelected, disabled && styles.optionChipDisabled]}
              onPress={() => onChange({ is_chronic: true, end_date: null, duration_days: null })}
              disabled={disabled}
            >
              <Text style={[styles.optionChipText, value.is_chronic && styles.optionChipTextSelected]}>Chronisch</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.optionChip, !value.is_chronic && styles.optionChipSelected, disabled && styles.optionChipDisabled]}
              onPress={() => onChange({ is_chronic: false })}
              disabled={disabled}
            >
              <Text style={[styles.optionChipText, !value.is_chronic && styles.optionChipTextSelected]}>Befristet</Text>
            </TouchableOpacity>
          </View>

          {!value.is_chronic && (
            <View style={styles.row2}>
              <View style={styles.flex1}>
                <Input
                  label="Dauer (Tage, optional)"
                  value={durationInputValue}
                  onChangeText={(txt) => {
                    const clean = txt.replace(/[^0-9]/g, '');
                    onChange({ duration_days: clean ? Number(clean) : null });
                  }}
                  keyboardType="numeric"
                  placeholder="z.B. 30"
                  editable={!disabled}
                />
              </View>
              <View style={styles.flex1}>
                <Input
                  label="Enddatum"
                  value={value.end_date ?? ''}
                  onChangeText={(txt) => onChange({ end_date: txt || null })}
                  placeholder="JJJJ-MM-TT"
                  editable={!disabled}
                />
              </View>
            </View>
          )}

          <Input
            label="Dosierhinweis"
            value={value.dosage_note}
            onChangeText={(txt) => onChange({ dosage_note: txt })}
            placeholder="z.B. nach dem Essen"
            editable={!disabled}
            multiline
            numberOfLines={3}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  header: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surfaceVariant,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '700',
  },
  chevron: {
    ...typography.body,
    color: colors.text.secondary,
    fontWeight: '700',
  },
  content: {
    padding: spacing.md,
  },
  sectionLabel: {
    ...typography.small,
    color: colors.text.primary,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  row2: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  flex1: {
    flex: 1,
  },
  optionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  optionRowWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  optionChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
  },
  optionChipSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  optionChipDisabled: {
    opacity: 0.6,
  },
  optionChipText: {
    ...typography.small,
    color: colors.text.primary,
    fontWeight: '600',
  },
  optionChipTextSelected: {
    color: colors.text.inverse,
  },
});
