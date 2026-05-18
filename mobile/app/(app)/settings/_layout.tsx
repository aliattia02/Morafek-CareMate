/**
 * Settings Stack Layout
 * Location: mobile/app/(app)/settings/_layout.tsx
 */

import { Stack } from 'expo-router';
import { colors } from '@/constants/theme';

export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: {
          backgroundColor: colors.primary,
        },
        headerTintColor: colors.text.inverse,
        headerTitleStyle: {
          fontWeight: '600',
        },
        contentStyle: {
          backgroundColor: colors.background,
        },
      }}
    >
      <Stack.Screen
        name="doctors"
        options={{ title: 'Manage Doctors' }}
      />
      <Stack.Screen
        name="clinics"
        options={{ title: 'Clinics' }}
      />
      {/* ── Android Health Connect wearable sync ──────────────────────── */}
      <Stack.Screen
        name="health-connect"
        options={{ title: 'Health Connect', headerBackTitle: 'Settings' }}
      />
    </Stack>
  );
}