import 'react-native-get-random-values'; // must be first import — required for UUID in health-connect-mapper

/**
 * Root App Layout
 * Location: mobile/app/_layout.tsx
 *
 * Main Function: RootLayout
 * Description: Root layout for the entire mobile app handling authentication state,
 *              navigation initialization, and app-wide providers
 *
 * Features:
 * - Authentication state management on startup
 * - Offline queue initialization
 * - SafeAreaProvider for safe area handling
 * - Stack navigation configuration
 * - Loading screen during auth check
 * - Root navigation structure (index, auth, app, not-found)
 */

import React, { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';

// Store
import { useAuthStore } from '@/store/auth.store';

// Constants
import { colors } from '@/constants/theme';

export default function RootLayout() {
  const router = useRouter();
  const { checkAuth } = useAuthStore();

  // Check authentication status on app start
  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    const navigateToNotificationTarget = (data: Record<string, unknown> | undefined) => {
      if (!data) return;
      if (data.screen === 'medications') {
        router.push('/(app)/ehr/medications');
      }
    };

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      navigateToNotificationTarget(response.notification.request.content.data as Record<string, unknown> | undefined);
    });

    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        navigateToNotificationTarget(response?.notification.request.content.data as Record<string, unknown> | undefined);
      })
      .catch(() => {
        // no-op
      });

    return () => {
      subscription.remove();
    };
  }, [router]);

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: {
            backgroundColor: colors.primary,
          },
          headerTintColor: colors.text.inverse,
          headerTitleStyle: {
            fontWeight: '600',
          },
          headerBackTitle: 'Back',
          contentStyle: {
            backgroundColor: colors.background,
          },
        }}
      >
        <Stack.Screen
          name="index"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="(auth)"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="(app)"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="+not-found"
          options={{
            title: 'Not Found',
          }}
        />
      </Stack>
    </SafeAreaProvider>
  );
}