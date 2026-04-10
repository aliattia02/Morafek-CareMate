import { Stack } from 'expo-router';

export default function LogLayout() {
  return (
    <Stack screenOptions={{ headerShown: true }}>
      <Stack.Screen name="vitals" options={{ title: 'Log Blood Pressure' }} />
    </Stack>
  );
}