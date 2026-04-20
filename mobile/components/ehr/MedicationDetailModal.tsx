import React, { useEffect, useRef } from 'react';
import { Animated, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { E, ET } from '@/constants/elderlyTheme';
import type { Medication as BaseMedication } from '@/services/api/medications';

// Extend the base type with fields added for deactivation/period tracking.
type MedicationPeriod = { start_date: string; end_date: string | null };
type Medication = BaseMedication & {
  deactivated_at?: string | null;
  periods?: MedicationPeriod[];
};

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

function TreatmentPeriods({ periods, isActive, deactivatedAt }: {
  periods?: MedicationPeriod[];
  isActive?: boolean;
  deactivatedAt?: string | null;
}) {
  // Determine what to render: multi-period history, or a simple active/inactive display.
  const hasHistory = periods && periods.length > 1;

  if (!hasHistory) {
    // Single period or legacy doc — show plain start / end fields.
    const singlePeriod = periods?.[0];
    const endLabel = isActive ? null : (deactivatedAt ?? singlePeriod?.end_date ?? '—');
    return (
      <>
        {singlePeriod?.start_date ? (
          <Field label="Start date" value={singlePeriod.start_date} />
        ) : null}
        {!isActive && endLabel ? (
          <Field label="Deactivated on" value={endLabel} />
        ) : null}
      </>
    );
  }

  // Multi-period history.
  return (
    <View style={styles.periodsBlock}>
      <Text style={styles.periodsTitle}>Treatment periods ({periods!.length})</Text>
      {periods!.map((p, idx) => {
        const isOpen = p.end_date === null || p.end_date === undefined;
        return (
          <View key={idx} style={[styles.periodRow, isOpen ? styles.periodRowActive : styles.periodRowInactive]}>
            <View style={styles.periodDot} />
            <View style={styles.periodTextBlock}>
              <Text style={styles.periodRange}>
                {p.start_date} → {isOpen ? 'present' : p.end_date}
              </Text>
              {isOpen ? (
                <Text style={styles.periodStatus}>Active</Text>
              ) : (
                <Text style={[styles.periodStatus, styles.periodStatusInactive]}>Ended</Text>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function DosageSlotPill({
  label,
  amount,
}: {
  label: string;
  amount: number;
}) {
  const active = amount > 0;
  return (
    <View style={[styles.dosePill, active ? styles.dosePillActive : styles.dosePillInactive]}>
      <Text style={[styles.dosePillLabel, active ? styles.dosePillLabelActive : styles.dosePillLabelInactive]}>
        {label}
      </Text>
      <Text style={[styles.dosePillValue, active ? styles.dosePillValueActive : styles.dosePillValueInactive]}>
        {amount}
      </Text>
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
                  <Text style={styles.sectionTitle}>Prescription</Text>
                  <Field label="Dosage label" value={medication.dosage_label} />
                  <Field label="Note" value={medication.dosage_note} />
                  <Field label="Unit" value={medication.dosage_unit} />
                  <Field label="Coverage" value={medication.coverage} />
                  <TreatmentPeriods
                    periods={medication.periods}
                    isActive={medication.is_active}
                    deactivatedAt={medication.deactivated_at}
                  />

                  <View style={styles.scheduleBlock}>
                    <Text style={styles.scheduleTitle}>
                      Dosage schedule ({medication.dosage_morning}-{medication.dosage_noon}-{medication.dosage_evening}-{medication.dosage_night})
                    </Text>
                    <View style={styles.scheduleRow}>
                      <DosageSlotPill label="Mo" amount={medication.dosage_morning} />
                      <DosageSlotPill label="Mi" amount={medication.dosage_noon} />
                      <DosageSlotPill label="Ab" amount={medication.dosage_evening} />
                      <DosageSlotPill label="Na" amount={medication.dosage_night} />
                    </View>
                  </View>
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Prescribing doctor</Text>
                  <Field label="Doctor ID" value={medication.doctor_id ?? '—'} />
                  <Field label="Visit ID" value={medication.visit_id ?? '—'} />
                  <Field label="Prescription type" value={medication.aut_idem ? 'Aut-idem allowed' : 'Fixed brand'} />
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
  scheduleBlock: {
    marginTop: 4,
    gap: 8,
  },
  periodsBlock: {
    marginTop: 4,
    gap: 6,
  },
  periodsTitle: {
    ...ET.small,
    color: E.colors.textSecondary,
    fontWeight: '700',
  },
  periodRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: E.radiusSm,
    borderWidth: 1,
  },
  periodRowActive: {
    backgroundColor: E.colors.successLight,
    borderColor: E.colors.success,
  },
  periodRowInactive: {
    backgroundColor: E.colors.surfaceAlt,
    borderColor: E.colors.border,
  },
  periodDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: E.colors.textSecondary,
  },
  periodTextBlock: {
    flex: 1,
    gap: 1,
  },
  periodRange: {
    ...ET.body,
    fontVariant: ['tabular-nums'],
  },
  periodStatus: {
    ...ET.caption,
    color: E.colors.success,
    fontWeight: '700',
  },
  periodStatusInactive: {
    color: E.colors.textSecondary,
  },
  scheduleTitle: {
    ...ET.small,
    color: E.colors.textSecondary,
    fontWeight: '700',
  },
  scheduleRow: {
    flexDirection: 'row',
    gap: 8,
  },
  dosePill: {
    flex: 1,
    borderRadius: E.radiusSm,
    borderWidth: 1,
    paddingVertical: 8,
    alignItems: 'center',
    gap: 2,
  },
  dosePillActive: {
    backgroundColor: E.colors.successLight,
    borderColor: E.colors.success,
  },
  dosePillInactive: {
    backgroundColor: E.colors.surfaceAlt,
    borderColor: E.colors.border,
  },
  dosePillLabel: {
    ...ET.caption,
    fontWeight: '700',
  },
  dosePillLabelActive: {
    color: E.colors.success,
  },
  dosePillLabelInactive: {
    color: E.colors.textSecondary,
  },
  dosePillValue: {
    ...ET.bodyBold,
  },
  dosePillValueActive: {
    color: E.colors.success,
  },
  dosePillValueInactive: {
    color: E.colors.textSecondary,
  },
});