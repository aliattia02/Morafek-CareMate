/**
 * App Entry Point
 * Location: mobile/app/index.tsx
 */

import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { Redirect } from 'expo-router';

import { useAuthStore } from '@/store/auth.store';
import { colors } from '@/constants/theme';

export default function Index() {
  const { isLoading, token, user } = useAuthStore();

  // Still checking auth — show spinner
  if (isLoading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // Auth check done — declarative redirect (safe, no race condition)
  return <Redirect href={token && user ? '/(app)/(tabs)' : '/(auth)/login'} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
  },
});