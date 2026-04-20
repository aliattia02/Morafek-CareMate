import React, { useEffect, useRef } from 'react';
import { Animated, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { E, ET } from '@/constants/elderlyTheme';
import type { Medication } from '@/services/api/medications';

interface MedicationDetailModalProps {
  medication: Medication | null;
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

export default function MedicationDetailModal({ medication, onClose }: MedicationDetailModalProps) {
  const slide = useRef(new Animated.Value(320)).current;

  useEffect(() => {
    if (!medication) return;
    slide.stopAnimation();
    slide.setValue(320);
    const animation = Animated.timing(slide, {
      toValue: 0,
      duration: 220,
      useNativeDriver: true,
    });
    animation.start();
    return () => {
      animation.stop();
    };
  }, [medication, slide]);

  return (
    <Modal visible={Boolean(medication)} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={styles.dismissLayer} activeOpacity={1} onPress={onClose} />
        <Animated.View style={[styles.sheet, { transform: [{ translateY: slide }] }]}>
          {!medication ? null : (
            <>
              <View style={styles.sheetHeader}>
                <Text style={styles.tradeName}>{medication.trade_name}</Text>
                <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                  <Text style={styles.closeText}>✕</Text>
                </TouchableOpacity>
              </View>

              <ScrollView contentContainerStyle={styles.content}>
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Drug information</Text>
                  <Field label="Active substance" value={medication.active_substance} />
                  <Field label="Form" value={medication.form} />
                  <Field label="Strength" value={medication.strength} />
                  <Field label="PZN" value={medication.pzn} />
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Dosage</Text>
                  <Field label="Dosage label" value={medication.dosage_label} />
                  <Field label="Unit" value={medication.dosage_unit} />
                  <Field label="Note" value={medication.dosage_note} />
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Therapy period</Text>
                  <Field label="Start date" value={medication.start_date} />
                  <Field label="End date" value={medication.is_chronic ? 'Dauermedikation' : medication.end_date} />
                  <Field label="Coverage" value={medication.coverage} />
                </View>
              </ScrollView>
            </>
          )}
        </Animated.View>
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
  dismissLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  sheet: {
    backgroundColor: E.colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '82%',
    padding: E.pad,
    ...E.shadow,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: E.padSm,
    gap: 8,
  },
  tradeName: {
    ...ET.h3,
    flex: 1,
    fontWeight: '700',
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
    paddingBottom: 20,
  },
  section: {
    borderWidth: 1,
    borderColor: E.colors.border,
    borderRadius: E.radiusSm,
    padding: E.padSm,
    backgroundColor: E.colors.bg,
    gap: 8,
  },
  sectionTitle: {
    ...ET.bodyBold,
  },
  field: {
    gap: 2,
  },
  fieldLabel: {
    ...ET.label,
  },
  fieldValue: {
    ...ET.body,
  },
});
