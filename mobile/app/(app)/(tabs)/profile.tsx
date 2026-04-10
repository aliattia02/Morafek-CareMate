Replace the entire contents of mobile/app/(app)/(tabs)/profile.tsx.
Delete everything. Replace with this:

import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card, Button } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

const showAlert = (title: string, message: string) => {
  if (Platform.OS === 'web') { window.alert(`${title}\n\n${message}`); }
  else { Alert.alert(title, message); }
};

export default function ProfileScreen() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const isDoctor = user?.user_type === 'doctor' || user?.user_type === 'admin';

  const handleLogout = () => {
    if (Platform.OS === 'web') {
      if (window.confirm('Sign out?')) logout();
    } else {
      Alert.alert('Sign Out', 'Are you sure?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign Out', style: 'destructive', onPress: logout },
      ]);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>

        {/* User card */}
        <Card variant="elevated" padding="large" style={styles.userCard}>
          <View style={[styles.avatar, isDoctor && styles.avatarDoctor]}>
            <Text style={styles.avatarText}>{user?.firstName?.[0] || 'U'}</Text>
          </View>
          <Text style={styles.name}>
            {isDoctor ? 'Dr. ' : ''}{user?.firstName} {user?.lastName}
          </Text>
          <Text style={styles.role}>
            {isDoctor ? '👨‍⚕️ Healthcare Provider' : '🧑 Patient'}
          </Text>
        </Card>

        {/* Patient links */}
        {!isDoctor && (
          <Card variant="outlined" padding="none" style={styles.linksCard}>
            <TouchableOpacity style={styles.link}
              onPress={() => router.push('/(app)/settings/doctors')}>
              <Text style={styles.linkIcon}>👨‍⚕️</Text>
              <View style={styles.linkBody}>
                <Text style={styles.linkTitle}>Manage My Doctors</Text>
                <Text style={styles.linkSub}>Authorize doctors to view your data</Text>
              </View>
              <Text style={styles.arrow}>›</Text>
            </TouchableOpacity>
            <View style={styles.divider} />
            <TouchableOpacity style={styles.link}
              onPress={() => router.push('/(app)/log/vitals')}>
              <Text style={styles.linkIcon}>📊</Text>
              <View style={styles.linkBody}>
                <Text style={styles.linkTitle}>Log Blood Pressure</Text>
                <Text style={styles.linkSub}>Record a new vital reading</Text>
              </View>
              <Text style={styles.arrow}>›</Text>
            </TouchableOpacity>
          </Card>
        )}

        {/* Doctor links */}
        {isDoctor && (
          <Card variant="outlined" padding="none" style={styles.linksCard}>
            <TouchableOpacity style={styles.link}
              onPress={() => router.push('/(app)/(tabs)/doctor-dashboard')}>
              <Text style={styles.linkIcon}>👥</Text>
              <View style={styles.linkBody}>
                <Text style={styles.linkTitle}>My Patients</Text>
                <Text style={styles.linkSub}>View and manage assigned patients</Text>
              </View>
              <Text style={styles.arrow}>›</Text>
            </TouchableOpacity>
          </Card>
        )}

        {/* Shared links */}
        <Card variant="outlined" padding="none" style={styles.linksCard}>
          <TouchableOpacity style={styles.link}
            onPress={() => showAlert('Help', 'Support documentation coming soon.')}>
            <Text style={styles.linkIcon}>❓</Text>
            <View style={styles.linkBody}>
              <Text style={styles.linkTitle}>Help & Support</Text>
            </View>
            <Text style={styles.arrow}>›</Text>
          </TouchableOpacity>
          <View style={styles.divider} />
          <TouchableOpacity style={styles.link}
            onPress={() => showAlert('Privacy', 'Privacy policy coming soon.')}>
            <Text style={styles.linkIcon}>🔒</Text>
            <View style={styles.linkBody}>
              <Text style={styles.linkTitle}>Privacy Policy (DSGVO)</Text>
            </View>
            <Text style={styles.arrow}>›</Text>
          </TouchableOpacity>
        </Card>

        <Button title="Sign Out" variant="outline" onPress={handleLogout}
          fullWidth style={styles.logout} />
        <Text style={styles.version}>Morafek v1.0.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:       { flex: 1, backgroundColor: colors.background },
  content:    { padding: spacing.md, paddingBottom: spacing.xl },
  userCard:   { alignItems: 'center', marginBottom: spacing.md },
  avatar: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md,
  },
  avatarDoctor: { backgroundColor: colors.secondary ?? colors.primary },
  avatarText: { fontSize: 32, fontWeight: 'bold', color: colors.text.inverse },
  name:       { ...typography.h2, color: colors.text.primary },
  role:       { ...typography.body, color: colors.text.secondary, marginTop: spacing.xs },
  linksCard:  { marginBottom: spacing.md, overflow: 'hidden' },
  link:       { flexDirection: 'row', alignItems: 'center', padding: spacing.md },
  linkIcon:   { fontSize: 24, marginRight: spacing.md },
  linkBody:   { flex: 1 },
  linkTitle:  { ...typography.body, color: colors.text.primary, fontWeight: '500' },
  linkSub:    { ...typography.small, color: colors.text.secondary },
  arrow:      { fontSize: 24, color: colors.text.secondary },
  divider:    { height: 1, backgroundColor: colors.divider, marginLeft: 56 },
  logout:     { marginTop: spacing.md, borderColor: colors.danger },
  version:    { ...typography.small, color: colors.text.secondary,
                textAlign: 'center', marginTop: spacing.lg },
});