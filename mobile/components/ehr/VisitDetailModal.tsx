/**
 * VisitDetailModal
 * Location: mobile/components/ehr/VisitDetailModal.tsx
 *
 * A slide-up bottom sheet that displays the full detail of a single visit.
 * Used by both the patient-facing visits.tsx screen and the doctor-facing
 * PatientDataView.tsx medications/visits tab.
 *
 * Props
 * ─────
 * visit      — the visit to display, or null when closed
 * onClose    — called when the user dismisses the sheet
 * doctorName — optional human-readable doctor label (doctor view can pass it)
 */

import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import type { Medication as MedicationRecord } from '@/services/api/medications';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface VisitDetail {
  id:                string;
  encounter_fhir_id?: string;
  doctor_id?:        string;
  chief_complaint?:  string;
  diagnosis_icd10?:  string;
  diagnosis_text?:   string;
  visit_date?:       string;
  notes?:            string;
}

interface VisitDetailModalProps {
  visit:         VisitDetail | null;
  onClose:       () => void;
  /** Optional readable label shown in the "Treating Doctor" field. */
  doctorName?:   string;
  /** Medications prescribed during this visit (filtered by visit_id). */
  medications?:  MedicationRecord[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      weekday: 'long',
      day:     'numeric',
      month:   'long',
      year:    'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionDivider} />
    </View>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
}) {
  if (!value) return null;
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, mono && styles.detailValueMono]}>
        {value}
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal
// ─────────────────────────────────────────────────────────────────────────────

export default function VisitDetailModal({
  visit,
  onClose,
  doctorName,
  medications,
}: VisitDetailModalProps) {
  const slide = useRef(new Animated.Value(420)).current;

  useEffect(() => {
    if (!visit) return;
    slide.stopAnimation();
    slide.setValue(420);
    const anim = Animated.spring(slide, {
      toValue:         0,
      useNativeDriver: true,
      tension:         80,
      friction:        11,
    });
    anim.start();
    return () => anim.stop();
  }, [visit, slide]);

  const hasNotes = !!visit?.notes?.trim();
  const hasMeds  = medications && medications.length > 0;

  return (
    <Modal
      visible={Boolean(visit)}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        {/* Tap outside to close */}
        <TouchableOpacity
          style={StyleSheet.absoluteFillObject}
          activeOpacity={1}
          onPress={onClose}
        />

        <Animated.View style={[styles.sheet, { transform: [{ translateY: slide }] }]}>
          {!visit ? null : (
            <>
              {/* ── Sheet handle ── */}
              <View style={styles.handleBar} />

              {/* ── Header ── */}
              <View style={styles.sheetHeader}>
                <View style={styles.headerLeft}>
                  <Text style={styles.headerDate}>{formatDate(visit.visit_date)}</Text>
                  <View style={styles.encounterBadge}>
                    <Text style={styles.encounterBadgeText}>Visit Record</Text>
                  </View>
                </View>
                <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                  <Text style={styles.closeBtnText}>✕</Text>
                </TouchableOpacity>
              </View>

              <ScrollView
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
              >
                {/* ── Chief Complaint ── */}
                {visit.chief_complaint ? (
                  <View style={styles.complaintBox}>
                    <Text style={styles.complaintLabel}>Reason for visit</Text>
                    <Text style={styles.complaintText}>{visit.chief_complaint}</Text>
                  </View>
                ) : null}

                {/* ── Diagnosis ── */}
                {(visit.diagnosis_text || visit.diagnosis_icd10) ? (
                  <View style={styles.section}>
                    <SectionHeader title="Diagnosis" />
                    <DetailRow label="Description" value={visit.diagnosis_text} />
                    <DetailRow label="ICD-10 Code" value={visit.diagnosis_icd10} mono />
                  </View>
                ) : null}

                {/* ── Clinical Notes ── */}
                {hasNotes ? (
                  <View style={styles.section}>
                    <SectionHeader title="Clinical Notes" />
                    <View style={styles.notesBox}>
                      <Text style={styles.notesText}>{visit.notes}</Text>
                    </View>
                  </View>
                ) : null}

                {/* ── Visit Metadata ── */}
                <View style={styles.section}>
                  <SectionHeader title="Visit Details" />
                  <DetailRow label="Date" value={formatDate(visit.visit_date)} />
                  {doctorName ? (
                    <DetailRow label="Treating Doctor" value={doctorName} />
                  ) : visit.doctor_id ? (
                    <DetailRow label="Doctor ID" value={visit.doctor_id} mono />
                  ) : null}
                  {visit.encounter_fhir_id ? (
                    <DetailRow
                      label="FHIR Encounter ID"
                      value={visit.encounter_fhir_id}
                      mono
                    />
                  ) : null}
                </View>

                {/* ── Prescribed Medications ── */}
                {hasMeds ? (
                  <View style={styles.section}>
                    <SectionHeader title={`Prescribed Medications (${medications!.length})`} />
                    {medications!.map((med, idx) => (
                      <View
                        key={String(med._id ?? med.id ?? idx)}
                        style={[
                          styles.medCard,
                          med.is_active === false && styles.medCardInactive,
                        ]}
                      >
                        {/* Name + status badge */}
                        <View style={styles.medCardHeader}>
                          <Text style={styles.medTradeName} numberOfLines={1}>
                            {med.trade_name}
                          </Text>
                          <View style={[
                            styles.medBadge,
                            med.is_active === false ? styles.medBadgeInactive : styles.medBadgeActive,
                          ]}>
                            <Text style={[
                              styles.medBadgeText,
                              med.is_active === false ? styles.medBadgeTextInactive : styles.medBadgeTextActive,
                            ]}>
                              {med.is_active === false ? 'Inactive' : 'Active'}
                            </Text>
                          </View>
                        </View>

                        {/* Substance · strength · form */}
                        <Text style={styles.medSubtitle} numberOfLines={1}>
                          {[med.active_substance, med.strength, med.form]
                            .filter(Boolean).join(' · ')}
                        </Text>

                        {/* Dosage schedule pill row */}
                        <View style={styles.medDoseRow}>
                          {(
                            [
                              { label: 'Mo', val: med.dosage_morning },
                              { label: 'Mi', val: med.dosage_noon },
                              { label: 'Ab', val: med.dosage_evening },
                              { label: 'Na', val: med.dosage_night },
                            ] as const
                          ).map(({ label, val }) => {
                            const active = (val ?? 0) > 0;
                            return (
                              <View
                                key={label}
                                style={[styles.dosePill, active ? styles.dosePillActive : styles.dosePillInactive]}
                              >
                                <Text style={[styles.dosePillLabel, active ? styles.dosePillLabelActive : styles.dosePillLabelInactive]}>
                                  {label}
                                </Text>
                                <Text style={[styles.dosePillValue, active ? styles.dosePillValueActive : styles.dosePillValueInactive]}>
                                  {val ?? 0}
                                </Text>
                              </View>
                            );
                          })}
                          {med.dosage_unit ? (
                            <Text style={styles.medUnit}>{med.dosage_unit}</Text>
                          ) : null}
                        </View>

                        {/* Coverage + PZN */}
                        {(med.coverage || med.pzn) ? (
                          <View style={styles.medMeta}>
                            {med.coverage ? (
                              <View style={styles.metaChip}>
                                <Text style={styles.metaChipText}>{med.coverage}</Text>
                              </View>
                            ) : null}
                            {med.pzn ? (
                              <View style={[styles.metaChip, styles.metaChipMono]}>
                                <Text style={[styles.metaChipText, styles.metaChipTextMono]}>
                                  PZN {med.pzn}
                                </Text>
                              </View>
                            ) : null}
                          </View>
                        ) : null}

                        {/* Dosage note */}
                        {med.dosage_note ? (
                          <Text style={styles.medNote} numberOfLines={2}>
                            📝 {med.dosage_note}
                          </Text>
                        ) : null}
                      </View>
                    ))}
                  </View>
                ) : null}
              </ScrollView>
            </>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent:  'flex-end',
  },
  sheet: {
    backgroundColor:    colors.surface,
    borderTopLeftRadius:  20,
    borderTopRightRadius: 20,
    maxHeight:          '88%',
    paddingHorizontal:  spacing.lg,
    paddingBottom:      spacing.xl,
    // Shadow
    shadowColor:   '#000',
    shadowOffset:  { width: 0, height: -3 },
    shadowOpacity: 0.12,
    shadowRadius:  12,
    elevation:     16,
  },
  handleBar: {
    width:           40,
    height:          4,
    borderRadius:    2,
    backgroundColor: colors.border,
    alignSelf:       'center',
    marginTop:       spacing.sm,
    marginBottom:    spacing.sm,
  },

  // ── Header ──
  sheetHeader: {
    flexDirection:  'row',
    alignItems:     'flex-start',
    justifyContent: 'space-between',
    paddingBottom:  spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginBottom:   spacing.md,
    gap:            spacing.sm,
  },
  headerLeft: {
    flex: 1,
    gap:  4,
  },
  headerDate: {
    ...typography.h3,
    color:      colors.text.primary,
    fontWeight: '700',
    flexShrink: 1,
  },
  encounterBadge: {
    alignSelf:        'flex-start',
    backgroundColor:  colors.primary + '15',
    borderRadius:     borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical:  3,
  },
  encounterBadgeText: {
    ...typography.small,
    color:      colors.primary,
    fontWeight: '700',
  },
  closeBtn: {
    width:           32,
    height:          32,
    borderRadius:    16,
    backgroundColor: colors.background,
    borderWidth:     1,
    borderColor:     colors.border,
    alignItems:      'center',
    justifyContent:  'center',
  },
  closeBtnText: {
    ...typography.body,
    color:      colors.text.secondary,
    fontWeight: '700',
    lineHeight: 20,
  },

  // ── Content ──
  content: {
    gap:         spacing.md,
    paddingBottom: spacing.md,
  },

  // ── Chief complaint hero ──
  complaintBox: {
    backgroundColor: colors.primary + '0D',
    borderRadius:    borderRadius.md,
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
    padding:         spacing.md,
    gap:             4,
  },
  complaintLabel: {
    ...typography.small,
    color:          colors.primary,
    fontWeight:     '700',
    textTransform:  'uppercase',
    letterSpacing:  0.5,
  },
  complaintText: {
    ...typography.body,
    color:      colors.text.primary,
    fontWeight: '600',
  },

  // ── Generic section ──
  section: {
    backgroundColor: colors.background,
    borderRadius:    borderRadius.md,
    borderWidth:     1,
    borderColor:     colors.border,
    padding:         spacing.md,
    gap:             spacing.sm,
  },
  sectionHeader: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            spacing.sm,
    marginBottom:   2,
  },
  sectionTitle: {
    ...typography.small,
    color:          colors.text.secondary,
    fontWeight:     '700',
    textTransform:  'uppercase',
    letterSpacing:  0.6,
  },
  sectionDivider: {
    flex:            1,
    height:          1,
    backgroundColor: colors.border,
  },

  // ── Detail row ──
  detailRow: {
    flexDirection: 'row',
    gap:           spacing.sm,
    alignItems:    'flex-start',
  },
  detailLabel: {
    ...typography.small,
    color:      colors.text.secondary,
    fontWeight: '600',
    width:      110,
    flexShrink: 0,
    paddingTop: 2,
  },
  detailValue: {
    ...typography.body,
    color: colors.text.primary,
    flex:  1,
  },
  detailValueMono: {
    fontFamily: 'monospace',
    fontSize:   13,
    color:      colors.primary,
    fontWeight: '600',
  },

  // ── Notes ──
  notesBox: {
    backgroundColor: colors.surface,
    borderRadius:    borderRadius.sm,
    padding:         spacing.sm,
    borderLeftWidth: 3,
    borderLeftColor: colors.border,
  },
  notesText: {
    ...typography.body,
    color:      colors.text.secondary,
    lineHeight: 22,
  },

  // ── Prescribed medications ──
  medCard: {
    backgroundColor: colors.surface,
    borderRadius:    borderRadius.sm,
    borderWidth:     1,
    borderColor:     colors.border,
    padding:         spacing.sm,
    gap:             6,
  },
  medCardInactive: {
    opacity: 0.65,
  },
  medCardHeader: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    gap:            spacing.xs,
  },
  medTradeName: {
    ...typography.body,
    color:      colors.text.primary,
    fontWeight: '700',
    flex:       1,
  },
  medBadge: {
    borderRadius:     borderRadius.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical:  2,
  },
  medBadgeActive: {
    backgroundColor: (colors as any).successLight ?? '#E8F5E9',
  },
  medBadgeInactive: {
    backgroundColor: colors.background,
    borderWidth:     1,
    borderColor:     colors.border,
  },
  medBadgeText: {
    ...typography.small,
    fontWeight: '700',
  },
  medBadgeTextActive: {
    color: (colors as any).success ?? '#2E7D32',
  },
  medBadgeTextInactive: {
    color: colors.text.secondary,
  },
  medSubtitle: {
    ...typography.small,
    color: colors.text.secondary,
  },
  medDoseRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           6,
    flexWrap:      'wrap',
  },
  dosePill: {
    minWidth:      38,
    borderRadius:  borderRadius.sm,
    borderWidth:   1,
    paddingVertical: 5,
    alignItems:    'center',
    gap:           2,
  },
  dosePillActive: {
    backgroundColor: (colors as any).successLight ?? '#E8F5E9',
    borderColor:     (colors as any).success ?? '#2E7D32',
  },
  dosePillInactive: {
    backgroundColor: colors.background,
    borderColor:     colors.border,
  },
  dosePillLabel: {
    ...typography.small,
    fontWeight: '700',
    fontSize:   10,
  },
  dosePillLabelActive: {
    color: (colors as any).success ?? '#2E7D32',
  },
  dosePillLabelInactive: {
    color: colors.text.secondary,
  },
  dosePillValue: {
    ...typography.body,
    fontWeight: '700',
    fontSize:   13,
  },
  dosePillValueActive: {
    color: (colors as any).success ?? '#2E7D32',
  },
  dosePillValueInactive: {
    color: colors.text.secondary,
  },
  medUnit: {
    ...typography.small,
    color:      colors.text.secondary,
    marginLeft: 4,
  },
  medMeta: {
    flexDirection: 'row',
    gap:           6,
    flexWrap:      'wrap',
  },
  metaChip: {
    backgroundColor:   colors.primary + '12',
    borderRadius:      borderRadius.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical:   2,
  },
  metaChipMono: {
    backgroundColor: colors.background,
    borderWidth:     1,
    borderColor:     colors.border,
  },
  metaChipText: {
    ...typography.small,
    color:      colors.primary,
    fontWeight: '600',
  },
  metaChipTextMono: {
    color:      colors.text.secondary,
    fontFamily: 'monospace',
  },
  medNote: {
    ...typography.small,
    color:      colors.text.secondary,
    lineHeight: 18,
  },
});