import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { Card } from '@/components/ui';
import { colors, spacing, typography } from '@/constants/theme';

export function ActiveEffectsDisplay() {
  return (
    <Card variant="outlined" padding="medium" style={styles.card}>
      <Text style={styles.title}>📋 Health Overview</Text>
      <Text style={styles.sub}>
        Log a blood pressure reading to see your health summary here.
      </Text>
    </Card>
  );
}

export default ActiveEffectsDisplay;

const styles = StyleSheet.create({
  card:  { marginBottom: spacing.md },
  title: { ...typography.h3, color: colors.text.primary, marginBottom: spacing.xs },
  sub:   { ...typography.body, color: colors.text.secondary },
});
