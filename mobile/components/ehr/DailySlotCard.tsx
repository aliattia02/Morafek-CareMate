import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { E, ET } from '@/constants/elderlyTheme';
import type { TodayMedicationSlotItem } from '@/services/api/medications';

interface DailySlotCardProps {
  item: TodayMedicationSlotItem;
  onOpenDetails: (item: TodayMedicationSlotItem) => void;
  onConfirm: (item: TodayMedicationSlotItem, status: 'taken' | 'skipped') => void;
  isUpdating?: boolean;
}

const STATUS_META: Record<TodayMedicationSlotItem['status'], { label: string; bg: string; fg: string }> = {
  pending: { label: 'Pending', bg: E.colors.warningLight, fg: E.colors.warning },
  taken: { label: 'Taken', bg: E.colors.successLight, fg: E.colors.success },
  skipped: { label: 'Skipped', bg: E.colors.dangerLight, fg: E.colors.danger },
};

export default function DailySlotCard({ item, onOpenDetails, onConfirm, isUpdating }: DailySlotCardProps) {
  const status = STATUS_META[item.status];
  const canConfirm = item.status === 'pending' && !isUpdating;

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>{item.medication.trade_name}</Text>
        <View style={[styles.statusBadge, { backgroundColor: status.bg }]}>
          <Text style={[styles.statusText, { color: status.fg }]}>{status.label}</Text>
        </View>
      </View>

      {item.medication.active_substance ? (
        <Text style={styles.subtitle}>{item.medication.active_substance}</Text>
      ) : null}

      <Text style={styles.dose}>💊 {item.dosage} {item.unit}</Text>

      <View style={styles.actionsRow}>
        <TouchableOpacity style={styles.detailButton} onPress={() => onOpenDetails(item)}>
          <Text style={styles.detailButtonText}>Details</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionButton, styles.takenButton, !canConfirm && styles.disabledButton]}
          onPress={() => onConfirm(item, 'taken')}
          disabled={!canConfirm}
        >
          <Text style={styles.actionText}>Taken</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionButton, styles.skippedButton, !canConfirm && styles.disabledButton]}
          onPress={() => onConfirm(item, 'skipped')}
          disabled={!canConfirm}
        >
          <Text style={styles.actionText}>Skip</Text>
        </TouchableOpacity>
      </View>

      {isUpdating ? <ActivityIndicator color={E.colors.primary} style={styles.loader} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: E.colors.surface,
    borderRadius: E.radius,
    borderWidth: 1,
    borderColor: E.colors.border,
    padding: E.padSm,
    gap: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  title: {
    ...ET.bodyBold,
    flex: 1,
  },
  subtitle: {
    ...ET.small,
  },
  dose: {
    ...ET.body,
    color: E.colors.textSecondary,
  },
  statusBadge: {
    borderRadius: E.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  statusText: {
    ...ET.small,
    fontWeight: '700',
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  detailButton: {
    flex: 1.1,
    borderRadius: E.radiusSm,
    borderWidth: 1,
    borderColor: E.colors.border,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailButtonText: {
    ...ET.small,
    fontWeight: '700',
    color: E.colors.textSecondary,
  },
  actionButton: {
    flex: 1,
    borderRadius: E.radiusSm,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  takenButton: {
    backgroundColor: E.colors.success,
  },
  skippedButton: {
    backgroundColor: E.colors.warning,
  },
  actionText: {
    ...ET.small,
    color: E.colors.textInverse,
    fontWeight: '700',
  },
  disabledButton: {
    opacity: 0.45,
  },
  loader: {
    marginTop: 4,
  },
});
