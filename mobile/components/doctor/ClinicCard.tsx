/**
 * ClinicCard Component
 * Location: mobile/components/doctor/ClinicCard.tsx
 *
 * Displays a single clinic with contextual actions:
 *   - Creator  → Edit button + Leave button
 *   - Member   → Leave button only
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  LayoutAnimation,
  Platform,
  UIManager,
} from 'react-native';
import { Card } from '@/components/ui';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import type { Clinic } from '@/services/api/clinics';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ClinicCardProps {
  clinic:      Clinic;
  currentUserId: string;
  onLeave:     (clinicId: string) => void;
  onSaveEdit:  (clinicId: string, payload: ClinicEditPayload) => Promise<void>;
  isProcessing?: boolean;
}

export interface ClinicEditPayload {
  name:        string;
  address:     string;
  phone:       string;
  description: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function MetaRow({ icon, text }: { icon: string; text: string }) {
  if (!text) return null;
  return (
    <View style={metaStyles.row}>
      <Text style={metaStyles.icon}>{icon}</Text>
      <Text style={metaStyles.text}>{text}</Text>
    </View>
  );
}

const metaStyles = StyleSheet.create({
  row:  { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  icon: { fontSize: 13, marginRight: 6 },
  text: { ...typography.small, color: colors.text.secondary, flex: 1 },
});

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const ClinicCard: React.FC<ClinicCardProps> = ({
  clinic,
  currentUserId,
  onLeave,
  onSaveEdit,
  isProcessing = false,
}) => {
  const isCreator = clinic.created_by === currentUserId;

  const [editing,  setEditing]  = useState(false);
  const [saving,   setSaving]   = useState(false);
  const [editName, setEditName] = useState(clinic.name);
  const [editAddr, setEditAddr] = useState(clinic.address);
  const [editPhone,setEditPhone]= useState(clinic.phone);
  const [editDesc, setEditDesc] = useState(clinic.description);
  const [nameError,setNameError]= useState('');

  const startEdit = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setEditName(clinic.name);
    setEditAddr(clinic.address);
    setEditPhone(clinic.phone);
    setEditDesc(clinic.description);
    setNameError('');
    setEditing(true);
  };

  const cancelEdit = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setEditing(false);
    setNameError('');
  };

  const handleSave = async () => {
    if (!editName.trim()) {
      setNameError('Clinic name is required');
      return;
    }
    setSaving(true);
    try {
      await onSaveEdit(clinic.id, {
        name:        editName.trim(),
        address:     editAddr.trim(),
        phone:       editPhone.trim(),
        description: editDesc.trim(),
      });
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  // ── View mode ───────────────────────────────────────────────────────────────
  if (!editing) {
    return (
      <Card variant="outlined" padding="medium" style={styles.card}>
        {/* Header row */}
        <View style={styles.headerRow}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarText}>
              {clinic.name.charAt(0).toUpperCase()}
            </Text>
          </View>
          <View style={styles.titleBlock}>
            <Text style={styles.clinicName}>{clinic.name}</Text>
            {isCreator && (
              <View style={styles.creatorBadge}>
                <Text style={styles.creatorBadgeText}>✦ Created by you</Text>
              </View>
            )}
          </View>
          <View style={styles.doctorCountBadge}>
            <Text style={styles.doctorCountText}>{clinic.doctor_count}</Text>
            <Text style={styles.doctorCountLabel}>doctors</Text>
          </View>
        </View>

        {/* Meta info */}
        <MetaRow icon="📍" text={clinic.address} />
        <MetaRow icon="📞" text={clinic.phone} />
        <MetaRow icon="📝" text={clinic.description} />

        {/* Actions */}
        <View style={styles.actionRow}>
          {isCreator && (
            <TouchableOpacity
              style={[styles.actionBtn, styles.editBtn]}
              onPress={startEdit}
              disabled={isProcessing}
            >
              <Text style={styles.editBtnText}>✏️  Edit</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.actionBtn, styles.leaveBtn, isCreator && styles.leaveBtnSecondary]}
            onPress={() => onLeave(clinic.id)}
            disabled={isProcessing}
          >
            {isProcessing
              ? <ActivityIndicator size="small" color={isCreator ? colors.danger : colors.text.inverse} />
              : <Text style={[styles.leaveBtnText, isCreator && styles.leaveBtnTextSecondary]}>
                  Leave Clinic
                </Text>
            }
          </TouchableOpacity>
        </View>
      </Card>
    );
  }

  // ── Edit mode ───────────────────────────────────────────────────────────────
  return (
    <Card variant="outlined" padding="medium" style={[styles.card, styles.cardEditing]}>
      <Text style={styles.editingHeading}>Edit Clinic</Text>

      <Text style={styles.fieldLabel}>Clinic Name *</Text>
      <TextInput
        style={[styles.input, !!nameError && styles.inputError]}
        value={editName}
        onChangeText={v => { setEditName(v); setNameError(''); }}
        placeholder="e.g. Cairo Heart Center"
        placeholderTextColor={colors.text.disabled}
      />
      {!!nameError && <Text style={styles.fieldError}>{nameError}</Text>}

      <Text style={styles.fieldLabel}>Address</Text>
      <TextInput
        style={styles.input}
        value={editAddr}
        onChangeText={setEditAddr}
        placeholder="Street, City"
        placeholderTextColor={colors.text.disabled}
      />

      <Text style={styles.fieldLabel}>Phone</Text>
      <TextInput
        style={styles.input}
        value={editPhone}
        onChangeText={setEditPhone}
        placeholder="+20 2 1234 5678"
        placeholderTextColor={colors.text.disabled}
        keyboardType="phone-pad"
      />

      <Text style={styles.fieldLabel}>Description</Text>
      <TextInput
        style={[styles.input, styles.inputMultiline]}
        value={editDesc}
        onChangeText={setEditDesc}
        placeholder="Brief description of the clinic"
        placeholderTextColor={colors.text.disabled}
        multiline
        numberOfLines={3}
      />

      <View style={styles.editActionRow}>
        <TouchableOpacity style={[styles.actionBtn, styles.cancelBtn]} onPress={cancelEdit} disabled={saving}>
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.actionBtn, styles.saveBtn]} onPress={handleSave} disabled={saving}>
          {saving
            ? <ActivityIndicator size="small" color={colors.text.inverse} />
            : <Text style={styles.saveBtnText}>Save Changes</Text>
          }
        </TouchableOpacity>
      </View>
    </Card>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: {
    marginBottom: spacing.md,
  },
  cardEditing: {
    borderColor: colors.primary,
    borderWidth: 2,
  },

  // View mode
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  avatarCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  avatarText: {
    ...typography.h3,
    color: colors.text.inverse,
    fontWeight: '700',
  },
  titleBlock: {
    flex: 1,
  },
  clinicName: {
    ...typography.body,
    fontWeight: '700',
    color: colors.text.primary,
  },
  creatorBadge: {
    marginTop: 3,
    alignSelf: 'flex-start',
    backgroundColor: colors.primary + '18',
    borderRadius: borderRadius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  creatorBadgeText: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: '600',
  },
  doctorCountBadge: {
    alignItems: 'center',
    backgroundColor: colors.surfaceVariant ?? colors.surface,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    minWidth: 52,
  },
  doctorCountText: {
    ...typography.h3,
    color: colors.primary,
    fontWeight: '700',
  },
  doctorCountLabel: {
    ...typography.caption,
    color: colors.text.secondary,
    fontSize: 10,
  },
  actionRow: {
    flexDirection: 'row',
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  editBtn: {
    backgroundColor: colors.primary + '15',
    borderWidth: 1,
    borderColor: colors.primary,
  },
  editBtnText: {
    ...typography.small,
    color: colors.primary,
    fontWeight: '600',
  },
  leaveBtn: {
    backgroundColor: colors.danger,
  },
  leaveBtnSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.danger,
  },
  leaveBtnText: {
    ...typography.small,
    color: colors.text.inverse,
    fontWeight: '600',
  },
  leaveBtnTextSecondary: {
    color: colors.danger,
  },

  // Edit mode
  editingHeading: {
    ...typography.h3,
    color: colors.primary,
    marginBottom: spacing.md,
  },
  fieldLabel: {
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
  inputMultiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  fieldError: {
    ...typography.caption,
    color: colors.danger,
    marginTop: 3,
  },
  editActionRow: {
    flexDirection: 'row',
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  cancelBtn: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  cancelBtnText: {
    ...typography.small,
    color: colors.text.secondary,
    fontWeight: '600',
  },
  saveBtn: {
    backgroundColor: colors.primary,
  },
  saveBtnText: {
    ...typography.small,
    color: colors.text.inverse,
    fontWeight: '600',
  },
});

export default ClinicCard;
