import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Platform, Image, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Card, Button } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { colors, spacing, typography } from '@/constants/theme';
import { uploadAvatar } from '@/services/api/profile';
import { getBaseUrl } from '@/services/api/client';

const showAlert = (title: string, message: string) => {
  if (Platform.OS === 'web') { window.alert(`${title}\n\n${message}`); }
  else { Alert.alert(title, message); }
};

export default function ProfileScreen() {
  const router = useRouter();
  const { user, token, logout, updateProfilePicture } = useAuth();
  const isDoctor = user?.user_type === 'doctor' || user?.user_type === 'admin';
  const [isUploading, setIsUploading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const handleFhirExport = async () => {
    setIsExporting(true);
    try {
      const res = await fetch(`${getBaseUrl()}/api/patient/fhir-export`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const bundle = await res.json();
      const json   = JSON.stringify(bundle, null, 2);
      const count  = bundle.entry?.length ?? 0;
      const filename = `fhir-export-${new Date().toISOString().slice(0, 10)}.json`;

      if (Platform.OS === 'web') {
        const blob = new Blob([json], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showAlert('Export complete', `${count} resources saved as ${filename}`);
        return;
      }

      const path = `${FileSystem.cacheDirectory}${filename}`;
      await FileSystem.writeAsStringAsync(path, json, {
        encoding: FileSystem.EncodingType.UTF8,
      });

      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(path, {
          mimeType: 'application/json',
          dialogTitle: 'Save or share your FHIR export',
          UTI: 'public.json',
        });
      } else {
        showAlert('Export saved', `${count} resources written to:\n${path}`);
      }
    } catch (err) {
      console.error('[FHIR Export]', err);
      showAlert('Export failed', 'Could not export FHIR data. Please try again.');
    } finally {
      setIsExporting(false);
    }
  };

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

  const handleAvatarPress = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      showAlert('Permission required', 'Please allow access to your photo library to change your profile picture.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });

    if (result.canceled || !result.assets?.length) return;

    const asset = result.assets[0];
    setIsUploading(true);
    try {
      const { profile_picture_url } = await uploadAvatar(
        asset.uri,
        asset.mimeType ?? 'image/jpeg'
      );
      updateProfilePicture(profile_picture_url);
    } catch (err) {
      showAlert('Upload failed', 'Could not update your profile picture. Please try again.');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>

        {/* User card */}
        <Card variant="elevated" padding="large" style={styles.userCard}>
          <TouchableOpacity onPress={handleAvatarPress} activeOpacity={0.8} style={styles.avatarWrapper}>
            <View style={[styles.avatarContainer, isDoctor && styles.avatarContainerDoctor]}>
              {user?.profile_picture_url ? (
                <Image source={{ uri: user.profile_picture_url }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarPlaceholder]}>
                  <Text style={styles.avatarText}>{user?.firstName?.[0] || 'U'}</Text>
                </View>
              )}
            </View>
            {isUploading ? (
              <View style={styles.avatarOverlay}>
                <ActivityIndicator color={colors.text.inverse} />
              </View>
            ) : (
              <View style={styles.avatarOverlay}>
                <Text style={styles.avatarEditIcon}>✎</Text>
              </View>
            )}
          </TouchableOpacity>
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
              onPress={() => router.push('/(app)/ehr/patient-profile')}>
              <Text style={styles.linkIcon}>🩺</Text>
              <View style={styles.linkBody}>
                <Text style={styles.linkTitle}>My Medical Profile</Text>
                <Text style={styles.linkSub}>Blood type, allergies &amp; conditions</Text>
              </View>
              <Text style={styles.arrow}>›</Text>
            </TouchableOpacity>
            <View style={styles.divider} />
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
            <View style={styles.divider} />
            <TouchableOpacity style={styles.link} onPress={handleFhirExport} disabled={isExporting}>
              <Text style={styles.linkIcon}>📤</Text>
              <View style={styles.linkBody}>
                <Text style={styles.linkTitle}>Export FHIR R4 Data</Text>
                <Text style={styles.linkSub}>
                  {isExporting ? 'Preparing export…' : 'Download your health records bundle'}
                </Text>
              </View>
              {isExporting
                ? <ActivityIndicator size="small" color={colors.primary} />
                : <Text style={styles.arrow}>›</Text>}
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
            <View style={styles.divider} />
            {/* ── NEW: My Clinics ── */}
            <TouchableOpacity style={styles.link}
              onPress={() => router.push('/(app)/settings/clinics')}>
              <Text style={styles.linkIcon}>🏥</Text>
              <View style={styles.linkBody}>
                <Text style={styles.linkTitle}>My Clinics</Text>
                <Text style={styles.linkSub}>Create and manage your clinic listings</Text>
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
  avatarWrapper: { position: 'relative', marginBottom: spacing.md },
  avatarContainer: {
    width: 80, height: 80, borderRadius: 40, overflow: 'hidden',
  },
  avatarContainerDoctor: {
    borderWidth: 2, borderColor: colors.secondary ?? colors.primary,
  },
  avatar: {
    width: 80, height: 80, borderRadius: 40,
  },
  avatarPlaceholder: {
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarOverlay: {
    position: 'absolute', bottom: 0, right: 0,
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarEditIcon: { color: '#fff', fontSize: 14 },
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