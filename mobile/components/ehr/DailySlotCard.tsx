import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { E, ET } from '@/constants/elderlyTheme';

export interface DailySlotCardProps {
  medicationName: string;
  activeSubstance: string;
  dosage: number;
  unit: string;
  intakeId: string;
  status: 'pending' | 'taken' | 'skipped';
  onConfirm: (intakeId: string, status: 'taken' | 'skipped') => void;
  disabled?: boolean;
}

export default function DailySlotCard({
  medicationName,
  activeSubstance,
  dosage,
  unit,
  intakeId,
  status,
  onConfirm,
  disabled = false,
}: DailySlotCardProps) {
  const isPending = status === 'pending';
  const isTaken = status === 'taken';
  const isSkipped = status === 'skipped';

  return (
    <View
      style={[
        styles.card,
        isTaken && styles.cardTaken,
        isSkipped && styles.cardSkipped,
      ]}
    >
      <Text style={styles.name}>{medicationName}</Text>
      <Text style={styles.dosage}>{`${dosage} ${unit}`}</Text>
      <Text style={styles.substance}>{activeSubstance}</Text>

      {isPending ? (
        <View style={styles.pendingActions}>
          <TouchableOpacity
            style={[styles.takeButton, disabled && styles.disabled]}
            onPress={() => onConfirm(intakeId, 'taken')}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={`${medicationName} nehmen`}
          >
            <Text style={styles.takeButtonText}>Nehmen</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.skipLink}
            onPress={() => onConfirm(intakeId, 'skipped')}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={`${medicationName} überspringen`}
          >
            <Text style={[styles.skipLinkText, disabled && styles.disabledText]}>Überspringen</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.statusRow}>
          <Text style={styles.statusIcon}>{isTaken ? '✅' : '✖️'}</Text>
          <Text style={styles.statusLabel}>{isTaken ? 'Genommen' : 'Übersprungen'}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: E.colors.surface,
    borderWidth: 1,
    borderColor: E.colors.border,
    borderRadius: E.radius,
    padding: E.padSm,
    gap: 6,
  },
  cardTaken: {
    backgroundColor: E.colors.successLight,
    borderColor: E.colors.success,
  },
  cardSkipped: {
    backgroundColor: E.colors.surfaceAlt,
    borderColor: E.colors.border,
  },
  name: {
    ...ET.bodyBold,
  },
  dosage: {
    ...ET.body,
    color: E.colors.textPrimary,
  },
  substance: {
    ...ET.small,
    color: E.colors.textSecondary,
  },
  pendingActions: {
    gap: 8,
    marginTop: 4,
  },
  takeButton: {
    minHeight: 52,
    backgroundColor: E.colors.primary,
    borderRadius: E.radiusSm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  takeButtonText: {
    ...ET.bodyBold,
    color: E.colors.textInverse,
  },
  skipLink: {
    alignSelf: 'center',
    paddingVertical: 4,
  },
  skipLinkText: {
    ...ET.small,
    color: E.colors.textSecondary,
    textDecorationLine: 'underline',
  },
  statusRow: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusIcon: {
    fontSize: 18,
  },
  statusLabel: {
    ...ET.bodyBold,
    color: E.colors.textPrimary,
  },
  disabled: {
    opacity: 0.5,
  },
  disabledText: {
    opacity: 0.5,
  },
});
