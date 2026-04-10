import { Stack } from 'expo-router';

export default function EhrLayout() {
  return (
    <Stack screenOptions={{ headerShown: true }}>
      <Stack.Screen name="documents" options={{ title: 'Documents' }} />
    </Stack>
  );
}
