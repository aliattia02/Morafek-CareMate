import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Alert, Platform, Image, ActivityIndicator, Modal, TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '@/hooks/useAuth';
import { E, ET } from '@/constants/elderlyTheme';
import { uploadAvatar } from '@/services/api/profile';
import apiClient from '@/services/api/client';

const showAlert = (title: string, message: string) => {
  if (Platform.OS === 'web') { window.alert(`${title}\n\n${message}`); }
  else { Alert.alert(title, message); }
};

export default function ProfileScreen() {
  const router = useRouter();
  const { user, logout, updateProfilePicture } = useAuth();
  // Explicit per-role checks — 'isDoctor' used to stand in for "not a
  // patient," which broke once 'researcher' became a real 4th user_type
  // (a researcher is neither a patient nor a doctor/admin).
  const isPatient = !user?.user_type || user.user_type === 'patient';
  const isDoctorOnly = user?.user_type === 'doctor';
  const isAdmin = user?.user_type === 'admin';
  const isDoctorOrAdmin = isDoctorOnly || isAdmin;
  const isResearcher = user?.user_type === 'researcher';
  const [isUploading, setIsUploading] = useState(false);

  // ── DSGVO delete-account modal ────────────────────────────────────────────
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletePassword, setDeletePassword]   = useState('');
  const [deleteError, setDeleteError]         = useState('');
  const [isDeleting, setIsDeleting]           = useState(false);

  const openDeleteModal = () => {
    setDeletePassword('');
    setDeleteError('');
    setShowDeleteModal(true);
  };

  const handleDeleteAccount = async () => {
    if (!deletePassword) {
      setDeleteError('Please enter your password to confirm.');
      return;
    }
    setIsDeleting(true);
    setDeleteError('');
    try {
      await apiClient.delete('/api/auth/delete-account', {
        data: { password: deletePassword },
      });
      setShowDeleteModal(false);
      // Clear all local auth state — server has wiped everything
      logout();

      // Hard-redirect on web: router.replace races with React re-render after
      // logout() clears auth state, leaving the spinner frozen. A full page
      // reload via window.location.href sidesteps React entirely; the root
      // layout then redirects to login because the token is already gone.
      if (Platform.OS === 'web') {
        window.alert(
          'Account deleted\n\nYour account and all associated data have been permanently erased.',
        );
        window.location.href = '/';
      } else {
        Alert.alert(
          'Account deleted',
          'Your account and all associated data have been permanently erased.',
          [{ text: 'OK', onPress: () => router.replace('/(auth)/login') }],
        );
      }
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Deletion failed. Try again.';
      setDeleteError(msg);
    } finally {
      setIsDeleting(false);
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

        {/* Hero section */}
        <View style={styles.hero}>
          <TouchableOpacity onPress={handleAvatarPress} activeOpacity={0.8} style={styles.avatarWrapper}>
            <View style={[styles.avatarRing, isDoctorOrAdmin && styles.avatarRingDoctor]}>
              <View style={styles.avatarContainer}>
                {user?.profile_picture_url ? (
                  <Image source={{ uri: user.profile_picture_url }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatar, styles.avatarPlaceholder]}>
                    <Text style={styles.avatarText}>{user?.firstName?.[0] || 'U'}</Text>
                  </View>
                )}
              </View>
            </View>
            {isUploading ? (
              <View style={styles.avatarOverlay}>
                <ActivityIndicator color={E.colors.textInverse} />
              </View>
            ) : (
              <View style={styles.avatarOverlay}>
                <Text style={styles.avatarEditIcon}>✎</Text>
              </View>
            )}
          </TouchableOpacity>
          <Text style={styles.name}>
            {isDoctorOnly ? 'Dr. ' : ''}{user?.firstName} {user?.lastName}
          </Text>
          <View style={styles.roleChip}>
            <Text style={styles.roleChipText}>
              {isAdmin ? '🛡️ Administrator' :
               isDoctorOnly ? '👨‍⚕️ Healthcare Provider' :
               isResearcher ? '🔬 Researcher' : '🧑 Patient'}
            </Text>
          </View>
        </View>

        {/* Patient links */}
        {isPatient && (
          <>
            <Text style={styles.groupLabel}>MY HEALTH</Text>
            <View style={styles.groupCard}>
              <TouchableOpacity style={styles.link}
                onPress={() => router.push('/(app)/ehr/patient-profile')}>
                <View style={styles.linkIconWrap}>
                  <Text style={styles.linkIcon}>🩺</Text>
                </View>
                <View style={styles.linkBody}>
                  <Text style={styles.linkTitle}>My Medical Profile</Text>
                  <Text style={styles.linkSub}>Blood type, allergies &amp; conditions</Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </TouchableOpacity>
              <View style={styles.divider} />
              <TouchableOpacity style={styles.link}
                onPress={() => router.push('/(app)/log/vitals')}>
                <View style={styles.linkIconWrap}>
                  <Text style={styles.linkIcon}>📊</Text>
                </View>
                <View style={styles.linkBody}>
                  <Text style={styles.linkTitle}>Log Blood Pressure</Text>
                  <Text style={styles.linkSub}>Record a new vital reading</Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </TouchableOpacity>
              <View style={styles.divider} />
              <TouchableOpacity style={styles.link}
                onPress={() => router.push('/(app)/settings/doctors')}>
                <View style={styles.linkIconWrap}>
                  <Text style={styles.linkIcon}>👨‍⚕️</Text>
                </View>
                <View style={styles.linkBody}>
                  <Text style={styles.linkTitle}>Manage My Doctors</Text>
                  <Text style={styles.linkSub}>Authorize doctors to view your data</Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </TouchableOpacity>
              <View style={styles.divider} />
              <TouchableOpacity style={styles.link}
                onPress={() => router.push('/(app)/ehr/consent')}>
                <View style={styles.linkIconWrap}>
                  <Text style={styles.linkIcon}>🔐</Text>
                </View>
                <View style={styles.linkBody}>
                  <Text style={styles.linkTitle}>Data &amp; Consent</Text>
                  <Text style={styles.linkSub}>Manage your research data sharing consent</Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </TouchableOpacity>
              <View style={styles.divider} />

              {/* ── FHIR Export — navigates to the dedicated screen ── */}
              <TouchableOpacity style={styles.link}
                onPress={() => router.push('/ehr/fhir-export')}>
                <View style={styles.linkIconWrap}>
                  <Text style={styles.linkIcon}>📤</Text>
                </View>
                <View style={styles.linkBody}>
                  <Text style={styles.linkTitle}>Export FHIR R4 Data</Text>
                  <Text style={styles.linkSub}>View bundle structure &amp; download</Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </TouchableOpacity>
            </View>

            {/* ── Wearables — Android only (Health Connect is not available on iOS) ── */}
            {Platform.OS === 'android' && (
              <>
                <Text style={styles.groupLabel}>WEARABLES</Text>
                <View style={styles.groupCard}>
                  <TouchableOpacity
                    style={styles.link}
                    onPress={() => router.push('/(app)/settings/health-connect')}
                  >
                    <View style={styles.linkIconWrap}>
                      <Text style={styles.linkIcon}>⌚</Text>
                    </View>
                    <View style={styles.linkBody}>
                      <Text style={styles.linkTitle}>Health Connect</Text>
                      <Text style={styles.linkSub}>Sync heart rate &amp; steps from your device</Text>
                    </View>
                    <Text style={styles.arrow}>›</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </>
        )}

        {/* Doctor links */}
        {isDoctorOrAdmin && (
          <>
            <Text style={styles.groupLabel}>PRACTICE</Text>
            <View style={styles.groupCard}>
              <TouchableOpacity style={styles.link}
                onPress={() => router.push('/(app)/(tabs)/doctor-dashboard')}>
                <View style={styles.linkIconWrap}>
                  <Text style={styles.linkIcon}>👥</Text>
                </View>
                <View style={styles.linkBody}>
                  <Text style={styles.linkTitle}>My Patients</Text>
                  <Text style={styles.linkSub}>View and manage assigned patients</Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </TouchableOpacity>
              <View style={styles.divider} />
              <TouchableOpacity style={styles.link}
                onPress={() => router.push('/(app)/settings/clinics')}>
                <View style={styles.linkIconWrap}>
                  <Text style={styles.linkIcon}>🏥</Text>
                </View>
                <View style={styles.linkBody}>
                  <Text style={styles.linkTitle}>My Clinics</Text>
                  <Text style={styles.linkSub}>Create and manage your clinic listings</Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* Research links */}
        {isResearcher && (
          <>
            <Text style={styles.groupLabel}>RESEARCH</Text>
            <View style={styles.groupCard}>
              <TouchableOpacity style={styles.link}
                onPress={() => router.push('/(app)/research/sync')}>
                <View style={styles.linkIconWrap}>
                  <Text style={styles.linkIcon}>🔄</Text>
                </View>
                <View style={styles.linkBody}>
                  <Text style={styles.linkTitle}>Sync Consent Status</Text>
                  <Text style={styles.linkSub}>Refresh eligibility &amp; mirror vitals from gICS</Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* Admin links */}
        {isAdmin && (
          <>
            <Text style={styles.groupLabel}>ADMINISTRATION</Text>
            <View style={styles.groupCard}>
              <TouchableOpacity style={styles.link}
                onPress={() => router.push('/(app)/admin/sync-issues')}>
                <View style={styles.linkIconWrap}>
                  <Text style={styles.linkIcon}>⚠️</Text>
                </View>
                <View style={styles.linkBody}>
                  <Text style={styles.linkTitle}>Sync Issues</Text>
                  <Text style={styles.linkSub}>Standing consent-sync problems</Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </TouchableOpacity>
              <View style={styles.divider} />
              <TouchableOpacity style={styles.link}
                onPress={() => router.push('/(app)/admin/erasure-requests')}>
                <View style={styles.linkIconWrap}>
                  <Text style={styles.linkIcon}>🗑️</Text>
                </View>
                <View style={styles.linkBody}>
                  <Text style={styles.linkTitle}>Erasure Requests</Text>
                  <Text style={styles.linkSub}>Review and approve data-deletion requests</Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {/* Shared links */}
        <Text style={styles.groupLabel}>SUPPORT &amp; LEGAL</Text>
        <View style={styles.groupCard}>
          <TouchableOpacity style={styles.link}
            onPress={() => showAlert('Help', 'Support documentation coming soon.')}>
            <View style={styles.linkIconWrap}>
              <Text style={styles.linkIcon}>❓</Text>
            </View>
            <View style={styles.linkBody}>
              <Text style={styles.linkTitle}>Help & Support</Text>
            </View>
            <Text style={styles.arrow}>›</Text>
          </TouchableOpacity>
          <View style={styles.divider} />
          <TouchableOpacity style={styles.link}
            onPress={() => showAlert('Privacy', 'Privacy policy coming soon.')}>
            <View style={styles.linkIconWrap}>
              <Text style={styles.linkIcon}>🔒</Text>
            </View>
            <View style={styles.linkBody}>
              <Text style={styles.linkTitle}>Privacy Policy (DSGVO)</Text>
            </View>
            <Text style={styles.arrow}>›</Text>
          </TouchableOpacity>
        </View>

        {/* Destructive */}
        <Text style={styles.groupLabel}>ACCOUNT</Text>
        <View style={styles.groupCard}>
          <TouchableOpacity style={styles.link} onPress={handleLogout}>
            <View style={[styles.linkIconWrap, styles.linkIconWrapDestructive]}>
              <Text style={styles.linkIcon}>🚪</Text>
            </View>
            <View style={styles.linkBody}>
              <Text style={[styles.linkTitle, { color: E.colors.danger }]}>Sign Out</Text>
            </View>
            <Text style={[styles.arrow, { color: E.colors.danger }]}>›</Text>
          </TouchableOpacity>
          <View style={styles.divider} />
          <TouchableOpacity style={styles.link} onPress={openDeleteModal}>
            <View style={[styles.linkIconWrap, styles.linkIconWrapDestructive]}>
              <Text style={styles.linkIcon}>🗑️</Text>
            </View>
            <View style={styles.linkBody}>
              <Text style={[styles.linkTitle, { color: E.colors.danger }]}>Delete My Data</Text>
              <Text style={styles.linkSub}>DSGVO Art. 17 — permanent erasure</Text>
            </View>
            <Text style={[styles.arrow, { color: E.colors.danger }]}>›</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.version}>Morafek v1.0.0</Text>
      </ScrollView>

      {/* ── DSGVO Delete Account Modal ──────────────────────────────────── */}
      <Modal
        visible={showDeleteModal}
        transparent
        animationType="fade"
        onRequestClose={() => !isDeleting && setShowDeleteModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>

            {/* Header */}
            <View style={styles.modalHeader}>
              <View style={styles.modalIconWrap}>
                <Text style={styles.modalIcon}>🗑️</Text>
              </View>
              <Text style={styles.modalTitle}>Delete All My Data</Text>
              <Text style={styles.modalSubtitle}>
                DSGVO Art. 17 — Right to Erasure
              </Text>
            </View>

            {/* Warning */}
            <View style={styles.warningBox}>
              <Text style={styles.warningTitle}>⚠️  This cannot be undone</Text>
              <Text style={styles.warningBody}>
                The following will be permanently deleted:{'\n'}
                {'  '}• Your account &amp; login credentials{'\n'}
                {'  '}• All blood pressure readings{'\n'}
                {'  '}• All visit records{'\n'}
                {'  '}• All uploaded documents{'\n'}
                {'  '}• Your medical profile{'\n'}
                {'  '}• All exercise plans{'\n'}
                {'  '}• All Health Connect wearable data
              </Text>
            </View>

            {/* Password confirmation */}
            <Text style={styles.confirmLabel}>CONFIRM WITH YOUR PASSWORD</Text>
            <TextInput
              style={[styles.confirmInput, deleteError ? styles.confirmInputError : null]}
              value={deletePassword}
              onChangeText={(v) => { setDeletePassword(v); setDeleteError(''); }}
              placeholder="Enter your password"
              placeholderTextColor={E.colors.textMuted}
              secureTextEntry
              editable={!isDeleting}
              autoCapitalize="none"
            />
            {deleteError ? (
              <Text style={styles.deleteErrorText}>{deleteError}</Text>
            ) : null}

            {/* Actions */}
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setShowDeleteModal(false)}
                disabled={isDeleting}
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.deleteBtn, isDeleting && styles.deleteBtnDisabled]}
                onPress={handleDeleteAccount}
                disabled={isDeleting}
              >
                {isDeleting
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={styles.deleteBtnText}>Delete Everything</Text>
                }
              </TouchableOpacity>
            </View>

          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: E.colors.bg },
  content: { paddingBottom: 40 },

  // Hero
  hero: {
    alignItems: 'center',
    backgroundColor: E.colors.primary,
    paddingTop: E.pad,
    paddingBottom: E.pad + 16,
  },
  avatarWrapper: { position: 'relative', marginBottom: E.padSm },
  avatarRing: {
    width: 96, height: 96, borderRadius: E.radiusFull,
    borderWidth: 4, borderColor: E.colors.primaryLight,
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarRingDoctor: {
    borderColor: E.colors.accent,
  },
  avatarContainer: {
    width: 84, height: 84, borderRadius: E.radiusFull, overflow: 'hidden',
  },
  avatar: {
    width: 84, height: 84, borderRadius: E.radiusFull,
  },
  avatarPlaceholder: {
    backgroundColor: E.colors.primaryDark,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarOverlay: {
    position: 'absolute', bottom: 0, right: 0,
    width: 28, height: 28, borderRadius: E.radiusFull,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarEditIcon: { color: '#fff', fontSize: 14 },
  avatarText: { fontSize: 36, fontWeight: 'bold', color: E.colors.textInverse },
  name: { ...ET.h2, color: E.colors.textInverse, marginBottom: 6 },
  roleChip: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: E.radiusFull,
    paddingHorizontal: E.padSm,
    paddingVertical: 4,
  },
  roleChipText: { ...ET.small, color: E.colors.textInverse, fontWeight: '600' },

  // Group labels + cards
  groupLabel: {
    ...ET.label,
    marginTop: E.pad,
    marginBottom: E.padXs,
    marginHorizontal: E.pad,
  },
  groupCard: {
    backgroundColor: E.colors.surface,
    borderRadius: E.radius,
    marginHorizontal: E.pad,
    overflow: 'hidden',
    ...E.shadowSm,
  },
  link: { flexDirection: 'row', alignItems: 'center', padding: E.padSm, minHeight: E.tap },
  linkIconWrap: {
    width: 40, height: 40, borderRadius: E.radiusSm,
    backgroundColor: E.colors.primaryLight,
    alignItems: 'center', justifyContent: 'center',
    marginRight: E.padSm,
  },
  linkIconWrapDestructive: {
    backgroundColor: E.colors.dangerLight,
  },
  linkIcon:  { fontSize: 20 },
  linkBody:  { flex: 1 },
  linkTitle: { ...ET.bodyBold },
  linkSub:   { ...ET.small },
  arrow:     { fontSize: 24, color: E.colors.textSecondary },
  divider:   { height: 1, backgroundColor: E.colors.divider, marginLeft: 60 },
  version:   { ...ET.small, textAlign: 'center', marginTop: E.pad, marginBottom: E.padSm },

  // ── DSGVO Delete modal ────────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(10,20,22,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: E.pad,
  },
  modalCard: {
    backgroundColor: E.colors.surface,
    borderRadius: E.radius,
    padding: E.pad,
    width: '100%',
    maxWidth: 420,
    ...E.shadow,
  },
  modalHeader: {
    alignItems: 'center',
    marginBottom: E.padSm,
  },
  modalIconWrap: {
    width: 56,
    height: 56,
    borderRadius: E.radiusFull,
    backgroundColor: E.colors.dangerLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: E.padSm,
  },
  modalIcon: { fontSize: 24 },
  modalTitle: {
    ...ET.h2,
    color: E.colors.danger,
    textAlign: 'center',
    marginBottom: 4,
  },
  modalSubtitle: {
    ...ET.small,
    color: E.colors.textSecondary,
    textAlign: 'center',
  },
  warningBox: {
    backgroundColor: E.colors.dangerLight,
    borderRadius: E.radiusSm,
    borderLeftWidth: 4,
    borderLeftColor: E.colors.danger,
    padding: E.padSm,
    marginTop: E.padSm,
    marginBottom: E.pad,
  },
  warningTitle: {
    ...ET.bodyBold,
    color: E.colors.danger,
    marginBottom: 6,
  },
  warningBody: {
    ...ET.small,
    color: E.colors.danger,
    lineHeight: 20,
  },
  confirmLabel: {
    ...ET.label,
    marginBottom: 6,
  },
  confirmInput: {
    height: 52,
    borderRadius: E.radiusSm,
    borderWidth: 1.5,
    borderColor: E.colors.border,
    backgroundColor: E.colors.bg,
    paddingHorizontal: E.padSm,
    ...ET.body,
    color: E.colors.textPrimary,
  },
  confirmInputError: {
    borderColor: E.colors.danger,
    backgroundColor: E.colors.dangerLight,
  },
  deleteErrorText: {
    ...ET.caption,
    color: E.colors.danger,
    marginTop: 4,
    marginBottom: 4,
  },
  modalActions: {
    flexDirection: 'row',
    gap: E.padSm,
    marginTop: E.pad,
  },
  cancelBtn: {
    flex: 1,
    height: E.tap,
    borderRadius: E.radiusSm,
    borderWidth: 1.5,
    borderColor: E.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: E.colors.surface,
  },
  cancelBtnText: {
    ...ET.bodyBold,
    color: E.colors.textSecondary,
  },
  deleteBtn: {
    flex: 2,
    height: E.tap,
    borderRadius: E.radiusSm,
    backgroundColor: E.colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBtnDisabled: {
    opacity: 0.6,
  },
  deleteBtnText: {
    ...ET.bodyBold,
    color: '#fff',
  },
});