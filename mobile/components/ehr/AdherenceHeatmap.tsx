import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { E, ET } from '@/constants/elderlyTheme';
import type { MedicationAdherenceDay } from '@/services/api/medications';

interface AdherenceHeatmapProps {
  days: MedicationAdherenceDay[];
  overallRate: number;
}

function getCellColor(day: MedicationAdherenceDay): string {
  if (day.total === 0) return E.colors.surfaceAlt;
  if (day.rate >= 0.9) return '#2E7D32';
  if (day.rate >= 0.7) return '#66BB6A';
  if (day.rate >= 0.5) return '#FFB300';
  return '#E53935';
}

export default function AdherenceHeatmap({ days, overallRate }: AdherenceHeatmapProps) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>📈 28-day adherence</Text>
        <Text style={styles.rate}>{Math.round(overallRate * 100)}%</Text>
      </View>

      <View style={styles.grid}>
        {days.map((day) => (
          <View
            key={day.date}
            style={[styles.cell, { backgroundColor: getCellColor(day) }]}
            accessibilityLabel={`${day.date} adherence ${Math.round(day.rate * 100)} percent`}
          />
        ))}
      </View>

      <Text style={styles.caption}>Each square is one day (left to right)</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: E.colors.surface,
    borderRadius: E.radius,
    borderWidth: 1,
    borderColor: E.colors.border,
    padding: E.padSm,
    gap: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    ...ET.bodyBold,
  },
  rate: {
    ...ET.h3,
    color: E.colors.primary,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  cell: {
    width: 18,
    height: 18,
    borderRadius: 4,
  },
  caption: {
    ...ET.caption,
  },
});
