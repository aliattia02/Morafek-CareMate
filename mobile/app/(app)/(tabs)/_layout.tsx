import React from 'react';
import { Text } from 'react-native';
import { Tabs } from 'expo-router';
import { colors } from '@/constants/theme';
import { E } from '@/constants/elderlyTheme';
import { useAuthStore } from '@/store/auth.store';

function TabIcon({ icon, color }: { icon: string; color: string }) {
  return <Text style={{ fontSize: 20, color }}>{icon}</Text>;
}

export default function TabLayout() {
  const { user } = useAuthStore();
  // 'patient' or unset (legacy/default) sees the Home tab; doctor/admin get
  // Doctor Dashboard instead; researcher gets neither — Profile is their
  // only tab, and it links out to /(app)/research/sync (see profile.tsx).
  const isPatient = !user?.user_type || user.user_type === 'patient';
  const isDoctor = user?.user_type === 'doctor' || user?.user_type === 'admin';

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: E.colors.primary,
        tabBarInactiveTintColor: colors.text.secondary,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
        },
        headerStyle: { backgroundColor: E.colors.primary },
        headerTintColor: colors.text.inverse,
        headerTitleStyle: { fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarLabel: 'Home',
          tabBarIcon: ({ color }) => <TabIcon icon="🏠" color={color} />,
          href: isPatient ? undefined : null,
        }}
      />

      <Tabs.Screen
        name="doctor-dashboard"
        options={{
          title: 'Doctor Dashboard',
          tabBarLabel: 'Patients',
          tabBarIcon: ({ color }) => <TabIcon icon="👨‍⚕️" color={color} />,
          href: isDoctor ? undefined : null,
        }}
      />

      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarLabel: 'Profile',
          tabBarIcon: ({ color }) => <TabIcon icon="👤" color={color} />,
        }}
      />
    </Tabs>
  );
}