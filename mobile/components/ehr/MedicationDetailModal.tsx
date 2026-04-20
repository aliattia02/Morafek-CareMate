import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { E, ET } from '@/constants/elderlyTheme';
import type { MedicationRecord } from '@/services/api/medications';

interface MedicationDetailModalProps {
  visible: boolean;
  medication: MedicationRecord | null;
  onClose: () => void;
}

function Field({ label, value }: { label: string; value?: string | number | null }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{String(value)}</Text>
    </View>
  );
}

export default function MedicationDetailModal({ visible, medication, onClose }: MedicationDetailModalProps) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.title}>Medication details</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeText}>✕</Text>
            </TouchableOpacity>
          </View>

          {!medication ? (
            <Text style={styles.empty}>Medication data not available.</Text>
          ) : (
            <ScrollView contentContainerStyle={styles.content}>
              <Field label="Name" value={medication.trade_name} />
              <Field label="Active substance" value={medication.active_substance} />
              <Field label="Strength" value={medication.strength} />
              <Field label="Form" value={medication.form} />
              <Field label="PZN" value={medication.pzn} />
              <Field label="Dosage" value={medication.dosage_label} />
              <Field label="Start date" value={medication.start_date} />
              <Field label="End date" value={medication.end_date} />
              <Field label="Note" value={medication.dosage_note} />
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: '#00000066',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: E.colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '78%',
    padding: E.pad,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: E.padSm,
  },
  title: {
    ...ET.h3,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: E.radiusFull,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: E.colors.surfaceAlt,
  },
  closeText: {
    ...ET.bodyBold,
  },
  content: {
    gap: 12,
    paddingBottom: 24,
  },
  field: {
    borderWidth: 1,
    borderColor: E.colors.border,
    borderRadius: E.radiusSm,
    padding: E.padSm,
    backgroundColor: E.colors.bg,
  },
  fieldLabel: {
    ...ET.label,
    marginBottom: 4,
  },
  fieldValue: {
    ...ET.body,
  },
  empty: {
    ...ET.body,
    color: E.colors.textSecondary,
  },
});
