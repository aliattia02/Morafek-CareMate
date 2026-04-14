import { Stack } from 'expo-router';

export default function EhrLayout() {
  return (
    <Stack screenOptions={{ headerShown: true }}>
      <Stack.Screen name="documents" options={{ title: 'Documents' }} />
      <Stack.Screen name="exercise-form" options={{ headerShown: true }} />
      <Stack.Screen name="visits" options={{ title: 'My Visits', headerShown: true }} />
      <Stack.Screen name="messages" options={{ title: 'Messages', headerShown: true }} />
      <Stack.Screen name="exercises" options={{ title: 'My Exercises', headerShown: true }} />
      <Stack.Screen name="visit-form" options={{ title: 'New Visit', headerShown: true }} />
      <Stack.Screen name="patient-profile" options={{ title: 'Medical Profile', headerShown: true }} />
      <Stack.Screen name="share-bundle" options={{ title: 'Share with doctor', headerShown: true }} />
      <Stack.Screen name="import-bundle" options={{ title: 'Import from doctor', headerShown: true }} />
    </Stack>
  );
}
