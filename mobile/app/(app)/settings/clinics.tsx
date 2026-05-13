/**
 * Clinic Management Screen (Doctor)
 * Location: mobile/app/(app)/settings/clinics.tsx
 *
 * Doctors can:
 *   - View all clinics they belong to
 *   - Create a new clinic (auto-joins as creator)
 *   - Edit clinics they created (name, address, phone, description)
 *   - Leave any clinic they're a member of
 *
 * FIX: user?.id → user?._id (store User interface uses _id, not id)
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  Platform,
  ActivityIndicator,
  KeyboardAvoidingView,
  LayoutAnimation,
  UIManager,
} from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ClinicCard, type ClinicEditPayload } from '@/components/doctor/ClinicCard';
import { Card } from '@/components/ui';
import {
  getMyClinics,
  createClinic,
  updateClinic,
  leaveClinic,
  type Clinic,
} from '@/services/api/clinics';
import { useAuthStore } from '@/store/auth.store';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-platform alert helpers
// ─────────────────────────────────────────────────────────────────────────────

const showAlert = (title: string, message: string) => {
  if (Platform.OS === 'web') window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
};

const showConfirm = (
  title: string,
  message: string,
  onConfirm: () => void,
  confirmLabel = 'Confirm',
  destructive = false,
) => {
  if (Platform.OS === 'web') {
    if (window.confirm(`${title}\n\n${message}`)) onConfirm();
  } else {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: confirmLabel, style: destructive ? 'destructive' : 'default', onPress: onConfirm },
    ]);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Create-clinic inline form
// ─────────────────────────────────────────────────────────────────────────────

interface CreateFormProps {
  onSubmit: (payload: { name: string; address: string; phone: string; description: string }) => Promise<void>;
  onCancel: () => void;
}

function CreateClinicForm({ onSubmit, onCancel }: CreateFormProps) {
  const [name,        setName]        = useState('');
  const [address,     setAddress]     = useState('');
  const [phone,       setPhone]       = useState('');
  const [description, setDescription] = useState('');
  const [nameError,   setNameError]   = useState('');
  const [submitting,  setSubmitting]  = useState(false);

  const handleSubmit = async () => {
    if (!name.trim()) { setNameError('Clinic name is required'); return; }
    setSubmitting(true);
    try {
      await onSubmit({ name: name.trim(), address: address.trim(), phone: phone.trim(), description: description.trim() });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card variant="outlined" padding="medium" style={formStyles.card}>
      <Text style={formStyles.heading}>🏥  New Clinic</Text>

      <Text style={formStyles.label}>Clinic Name *</Text>
      <TextInput
        style={[formStyles.input, !!nameError && formStyles.inputError]}
        value={name}
        onChangeText={v => { setName(v); setNameError(''); }}
        placeholder="e.g. Cairo Heart Center"
        placeholderTextColor={colors.text.disabled}
        autoFocus
      />
      {!!nameError && <Text style={formStyles.error}>{nameError}</Text>}

      <Text style={formStyles.label}>Address</Text>
      <TextInput
        style={formStyles.input}
        value={address}
        onChangeText={setAddress}
        placeholder="Street, City"
        placeholderTextColor={colors.text.disabled}
      />

      <Text style={formStyles.label}>Phone</Text>
      <TextInput
        style={formStyles.input}
        value={phone}
        onChangeText={setPhone}
        placeholder="+20 2 1234 5678"
        placeholderTextColor={colors.text.disabled}
        keyboardType="phone-pad"
      />

      <Text style={formStyles.label}>Description</Text>
      <TextInput
        style={[formStyles.input, formStyles.multiline]}
        value={description}
        onChangeText={setDescription}
        placeholder="Brief description of the clinic"
        placeholderTextColor={colors.text.disabled}
        multiline
        numberOfLines={3}
      />

      <View style={formStyles.btnRow}>
        <TouchableOpacity style={[formStyles.btn, formStyles.cancelBtn]} onPress={onCancel} disabled={submitting}>
          <Text style={formStyles.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[formStyles.btn, formStyles.submitBtn]} onPress={handleSubmit} disabled={submitting}>
          {submitting
            ? <ActivityIndicator size="small" color={colors.text.inverse} />
            : <Text style={formStyles.submitText}>Create Clinic</Text>
          }
        </TouchableOpacity>
      </View>
    </Card>
  );
}

const formStyles = StyleSheet.create({
  card: {
    marginBottom: spacing.md,
    borderColor: colors.primary,
    borderWidth: 2,
  },
  heading: {
    ...typography.h3,
    color: colors.primary,
    marginBottom: spacing.md,
  },
  label: {
    ...typography.caption,
    color: colors.text.secondary,
    fontWeight: '600',
    marginBottom: 4,
    marginTop: spacing.sm,
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    ...typography.body,
    color: colors.text.primary,
  },
  inputError: {
    borderColor: colors.danger,
  },
  multiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  error: {
    ...typography.caption,
    color: colors.danger,
    marginTop: 3,
  },
  btnRow: {
    flexDirection: 'row',
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  btn: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  cancelBtn: {
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelText: {
    ...typography.small,
    color: colors.text.secondary,
    fontWeight: '600',
  },
  submitBtn: {
    backgroundColor: colors.primary,
  },
  submitText: {
    ...typography.small,
    color: colors.text.inverse,
    fontWeight: '600',
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function ClinicManagementScreen() {
  const { user } = useAuthStore();
  // FIX: was user?.id — store User interface declares _id, not id
  const currentUserId = user?._id ?? '';

  const [clinics,       setClinics]       = useState<Clinic[]>([]);
  const [isLoading,     setIsLoading]     = useState(true);
  const [isProcessing,  setIsProcessing]  = useState(false);
  const [showCreateForm,setShowCreateForm]= useState(false);
  const [error,         setError]         = useState<string | null>(null);

  // ── load ───────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await getMyClinics();
      setClinics(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load clinics');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── create ─────────────────────────────────────────────────────────────────

  const handleCreate = async (payload: { name: string; address: string; phone: string; description: string }) => {
    try {
      await createClinic(payload);
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setShowCreateForm(false);
      await load();
      showAlert('Success', `"${payload.name}" has been created and you've been added as its first doctor.`);
    } catch (err: any) {
      showAlert('Error', err?.response?.data?.error || err.message || 'Failed to create clinic');
    }
  };

  // ── edit ───────────────────────────────────────────────────────────────────

  const handleSaveEdit = async (clinicId: string, payload: ClinicEditPayload) => {
    await updateClinic(clinicId, payload);
    // Optimistically update local state so the card snaps to new values instantly
    setClinics(prev =>
      prev.map(c => c.id === clinicId ? { ...c, ...payload } : c)
    );
  };

  // ── leave ──────────────────────────────────────────────────────────────────

  const handleLeave = (clinicId: string) => {
    const clinic = clinics.find(c => c.id === clinicId);
    if (!clinic) return;

    const isCreator = clinic.created_by === currentUserId;
    const message   = isCreator
      ? `You created "${clinic.name}". Leaving will remove you as a member but the clinic will remain. Are you sure?`
      : `You will no longer appear as a doctor at "${clinic.name}".`;

    showConfirm(
      'Leave Clinic',
      message,
      async () => {
        setIsProcessing(true);
        try {
          await leaveClinic(clinicId);
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setClinics(prev => prev.filter(c => c.id !== clinicId));
        } catch (err: any) {
          showAlert('Error', err?.response?.data?.error || err.message || 'Failed to leave clinic');
        } finally {
          setIsProcessing(false);
        }
      },
      'Leave',
      true,
    );
  };

  // ── render ─────────────────────────────────────────────────────────────────

  const createdClinics = clinics.filter(c => c.created_by === currentUserId);
  const joinedClinics  = clinics.filter(c => c.created_by !== currentUserId);

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'My Clinics', headerShown: true }} />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={styles.container}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── Top action bar ── */}
          {!showCreateForm && (
            <TouchableOpacity
              style={styles.createButton}
              onPress={() => {
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                setShowCreateForm(true);
              }}
            >
              <Text style={styles.createButtonText}>＋  Create New Clinic</Text>
            </TouchableOpacity>
          )}

          {/* ── Create form ── */}
          {showCreateForm && (
            <CreateClinicForm
              onSubmit={handleCreate}
              onCancel={() => {
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                setShowCreateForm(false);
              }}
            />
          )}

          {/* ── Error ── */}
          {error && (
            <Card variant="outlined" padding="medium" style={styles.errorCard}>
              <Text style={styles.errorText}>⚠️ {error}</Text>
            </Card>
          )}

          {/* ── Loading ── */}
          {isLoading ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator color={colors.primary} size="large" />
              <Text style={styles.loadingText}>Loading your clinics…</Text>
            </View>
          ) : (
            <>
              {/* ── Stats bar ── */}
              {clinics.length > 0 && (
                <View style={styles.statsRow}>
                  <View style={styles.statItem}>
                    <Text style={styles.statValue}>{clinics.length}</Text>
                    <Text style={styles.statLabel}>Total</Text>
                  </View>
                  <View style={styles.statDivider} />
                  <View style={styles.statItem}>
                    <Text style={styles.statValue}>{createdClinics.length}</Text>
                    <Text style={styles.statLabel}>Created by you</Text>
                  </View>
                  <View style={styles.statDivider} />
                  <View style={styles.statItem}>
                    <Text style={styles.statValue}>{joinedClinics.length}</Text>
                    <Text style={styles.statLabel}>Joined</Text>
                  </View>
                </View>
              )}

              {/* ── Clinics you created ── */}
              {createdClinics.length > 0 && (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Created by You</Text>
                  <Text style={styles.sectionSubtitle}>
                    You can edit the details of these clinics
                  </Text>
                  {createdClinics.map(clinic => (
                    <ClinicCard
                      key={clinic.id}
                      clinic={clinic}
                      currentUserId={currentUserId}
                      onLeave={handleLeave}
                      onSaveEdit={handleSaveEdit}
                      isProcessing={isProcessing}
                    />
                  ))}
                </View>
              )}

              {/* ── Clinics you joined ── */}
              {joinedClinics.length > 0 && (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Clinics You've Joined</Text>
                  <Text style={styles.sectionSubtitle}>
                    You appear as a doctor in these clinics
                  </Text>
                  {joinedClinics.map(clinic => (
                    <ClinicCard
                      key={clinic.id}
                      clinic={clinic}
                      currentUserId={currentUserId}
                      onLeave={handleLeave}
                      onSaveEdit={handleSaveEdit}
                      isProcessing={isProcessing}
                    />
                  ))}
                </View>
              )}

              {/* ── Empty state ── */}
              {clinics.length === 0 && !showCreateForm && (
                <View style={styles.emptyState}>
                  <Text style={styles.emptyIcon}>🏥</Text>
                  <Text style={styles.emptyTitle}>No clinics yet</Text>
                  <Text style={styles.emptyBody}>
                    Create your first clinic or ask a clinic admin to add you. Patients
                    will be able to find you when they browse by clinic.
                  </Text>
                  <TouchableOpacity
                    style={styles.emptyCreateBtn}
                    onPress={() => {
                      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                      setShowCreateForm(true);
                    }}
                  >
                    <Text style={styles.emptyCreateBtnText}>＋  Create a Clinic</Text>
                  </TouchableOpacity>
                </View>
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  content: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },

  // Create button
  createButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  createButtonText: {
    ...typography.body,
    color: colors.text.inverse,
    fontWeight: '700',
  },

  // Error
  errorCard: {
    borderColor: colors.danger,
    marginBottom: spacing.md,
  },
  errorText: {
    ...typography.small,
    color: colors.danger,
  },

  // Loading
  loadingBox: {
    alignItems: 'center',
    paddingVertical: spacing.xl * 2,
  },
  loadingText: {
    ...typography.body,
    color: colors.text.secondary,
    marginTop: spacing.md,
  },

  // Stats bar
  statsRow: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.lg,
    paddingVertical: spacing.md,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    ...typography.h2,
    color: colors.primary,
    fontWeight: '700',
  },
  statLabel: {
    ...typography.caption,
    color: colors.text.secondary,
    textAlign: 'center',
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.xs,
  },

  // Sections
  section: {
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    ...typography.h3,
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  sectionSubtitle: {
    ...typography.small,
    color: colors.text.secondary,
    marginBottom: spacing.md,
  },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xl * 2,
    paddingHorizontal: spacing.lg,
  },
  emptyIcon: {
    fontSize: 56,
    marginBottom: spacing.md,
  },
  emptyTitle: {
    ...typography.h2,
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  emptyBody: {
    ...typography.body,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  emptyCreateBtn: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
  },
  emptyCreateBtnText: {
    ...typography.body,
    color: colors.text.inverse,
    fontWeight: '700',
  },
});