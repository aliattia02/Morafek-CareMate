import { Stack } from 'expo-router';
import { colors } from '@/constants/theme';

export default function AdminLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.primary },
        headerTintColor: colors.text.inverse,
        headerTitleStyle: { fontWeight: '600' },
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="sync-issues" options={{ title: 'Sync Issues' }} />
      <Stack.Screen name="erasure-requests" options={{ title: 'Erasure Requests' }} />
    </Stack>
  );
}
