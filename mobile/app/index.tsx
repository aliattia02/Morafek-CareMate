/**
 * App Entry Point
 * Location: mobile/app/index.tsx
 *
 * Main Function: Index
 * Description: Initial route that waits for the auth check to complete, then
 *              redirects to the appropriate screen without causing a visible
 *              flash for returning users.
 *
 * Features:
 * - Waits for isLoading to become false before navigating
 * - Redirects authenticated users straight to the app tabs
 * - Redirects unauthenticated users to the login screen
 * - Shows a centered ActivityIndicator while the auth check runs
 */

import { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';

// Store
import { useAuthStore } from '@/store/auth.store';

// Constants
import { colors } from '@/constants/theme';

export default function Index() {
  const router = useRouter();
  const { isLoading, token, user } = useAuthStore();

  useEffect(() => {
    if (isLoading) return;

    if (token && user) {
      router.replace('/(app)/(tabs)');
    } else {
      router.replace('/(auth)/login');
    }
  }, [isLoading]);

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
  },
});