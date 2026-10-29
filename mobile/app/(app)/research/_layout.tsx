import { Stack } from 'expo-router';
import { colors } from '@/constants/theme';

export default function ResearchLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.primary },
        headerTintColor: colors.text.inverse,
        headerTitleStyle: { fontWeight: '600' },
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="sync" options={{ title: 'Sync Consent Status' }} />
    </Stack>
  );
}
