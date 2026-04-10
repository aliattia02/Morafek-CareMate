
import React, { useEffect, useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, TouchableOpacity } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuthStore } from '@/store/auth.store';
import { Card } from '@/components/ui';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// TODO Phase 2: import { getMyVitals, getMyVisits } from '@/services/api/ehr';

export default function PatientHomeScreen() {
  const router = useRouter();
  const { user } = useAuthStore();

  useEffect(() => {
    if (user?.user_type === 'doctor' || user?.user_type === 'admin') {
      router.replace('/(app)/(tabs)/doctor-dashboard');
    }
  }, [user?.user_type]);

  if (user?.user_type === 'doctor' || user?.user_type === 'admin') {
    return <View style={{ flex: 1, backgroundColor: '#fff' }} />;
  }

  return (
    <SafeAreaView style={styles.safe} edges={[]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.greeting}>
            {new Date().getHours() < 12 ? 'Good morning'
              : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening'}
          </Text>
          <Text style={styles.name}>{user?.firstName || 'Patient'}</Text>
        </View>

        <Card variant="outlined" padding="medium" style={styles.card}>
          <Text style={styles.cardTitle}>📊 Your Health Summary</Text>
          <Text style={styles.cardSubtitle}>
            Vitals and visit history will appear here once you log your first reading.
          </Text>
          <TouchableOpacity
            style={styles.button}
            onPress={() => router.push('/(app)/log/vitals')}
          >
            <Text style={styles.buttonText}>+ Log Blood Pressure</Text>
          </TouchableOpacity>
        </Card>

        <Card variant="outlined" padding="medium" style={styles.card}>
          <Text style={styles.cardTitle}>🏥 Recent Visits</Text>
          <Text style={styles.cardSubtitle}>
            Your doctor visits will appear here.
          </Text>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:          { flex: 1, backgroundColor: colors.background },
  content:       { padding: spacing.md, paddingBottom: spacing.xl },
  header:        { marginBottom: spacing.lg },
  greeting:      { ...typography.body, color: colors.text.secondary },
  name:          { ...typography.h1, color: colors.text.primary },
  card:          { marginBottom: spacing.md },
  cardTitle:     { ...typography.h3, color: colors.text.primary, marginBottom: spacing.xs },
  cardSubtitle:  { ...typography.body, color: colors.text.secondary, marginBottom: spacing.md },
  button: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  buttonText: { ...typography.body, color: colors.text.inverse, fontWeight: '600' },
});