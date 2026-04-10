/**
 * App Entry Point
 * Location: mobile/app/index.tsx
 *
 * Main Function: Index
 * Description: Initial route that checks stored auth state and redirects to the
 *              appropriate screen without causing a visible flash for returning users.
 *
 * Features:
 * - Reads token + user from auth store synchronously via getState()
 * - Redirects authenticated users straight to the app tabs
 * - Redirects unauthenticated users to the login screen
 * - Shows a centered ActivityIndicator while the effect fires
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

  useEffect(() => {
    const { token, user } = useAuthStore.getState();
    if (token && user) {
      router.replace('/(app)/(tabs)');
    } else {
      router.replace('/(auth)/login');
    }
  }, []);

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