import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';

import { Input } from '@/components/ui';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import PZNSearchInput from '@/components/ehr/PZNSearchInput';
import DosageBuilder, { DosageValue } from '@/components/ehr/DosageBuilder';
import { CreateDoctorMedicationRequest, CoverageType, DosageUnit, NormSize } from '@/services/api/medications';
import { PZNEntry } from '@/constants/pzn_data';

interface Props {
  startDateDefault?: string;
}

interface FieldErrors {
  pzn?: string;
  trade_name?: string;
  active_substance?: string;
  form?: string;
  strength?: string;
  start_date?: string;
  end_date?: string;
  dosage?: string;
}

interface Draft {
  pzn: string;
  trade_name: string;
  active_substance: string;
  form: string;
  strength: string;
  norm_size: NormSize;
  aut_idem: boolean;
  coverage: CoverageType;
  is_chronic: boolean;
  start_date: string;
  end_date: string;
  duration_days: string;
  dosage: DosageValue;
  dosage_unit: DosageUnit;
  dosage_note: string;
}

export interface MedicationPrescriptionPanelRef {
  hasEnabledPrescription: () => boolean;
  getPayload: () => CreateDoctorMedicationRequest | null;
}

const COVERAGE_OPTIONS: CoverageType[] = ['GKV', 'PKV', 'Selbstzahler'];
const NORM_OPTIONS: NormSize[] = ['N1', 'N2', 'N3'];
const DOSAGE_UNIT_OPTIONS: DosageUnit[] = ['Tablette', 'ml', 'IE', 'Hub', 'Tropfen'];

const todayISO = () => new Date().toISOString().split('T')[0];

function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

const MedicationPrescriptionPanel = forwardRef<MedicationPrescriptionPanelRef, Props>(function MedicationPrescriptionPanel(
  { startDateDefault },
  ref
) {
  const [enabled, setEnabled] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const enabledRef = useRef(false);

  const [draft, setDraft] = useState<Draft>({
    pzn: '',
    trade_name: '',
    active_substance: '',
    form: '',
    strength: '',
    norm_size: 'N1',
    aut_idem: false,
    coverage: 'GKV',
    is_chronic: true,
    start_date: startDateDefault ?? todayISO(),
    end_date: '',
    duration_days: '',
    dosage: { morning: 1, noon: 0, evening: 0, night: 0 },
    dosage_unit: 'Tablette',
    dosage_note: '',
  });
  const draftRef = useRef(draft);

  const dosageLabel = useMemo(
    () => `${draft.dosage.morning}-${draft.dosage.noon}-${draft.dosage.evening}-${draft.dosage.night}`,
    [draft.dosage]
  );

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const buildPayload = useCallback((currentDraft: Draft): CreateDoctorMedicationRequest | null => {
    const nextErrors: FieldErrors = {};

    if (!/^\d{8}$/.test(currentDraft.pzn.trim())) nextErrors.pzn = 'PZN muss 8-stellig sein';
    if (!currentDraft.trade_name.trim()) nextErrors.trade_name = 'Handelsname ist erforderlich';
    if (!currentDraft.active_substance.trim()) nextErrors.active_substance = 'Wirkstoff ist erforderlich';
    if (!currentDraft.form.trim()) nextErrors.form = 'Darreichungsform ist erforderlich';
    if (!currentDraft.strength.trim()) nextErrors.strength = 'Stärke ist erforderlich';

    if (!isValidDate(currentDraft.start_date.trim())) {
      nextErrors.start_date = 'Datum im Format JJJJ-MM-TT eingeben';
    }

    const end = currentDraft.end_date.trim();
    if (!currentDraft.is_chronic) {
      if (!end) {
        nextErrors.end_date = 'Enddatum ist erforderlich bei nicht chronischer Verordnung';
      } else if (!isValidDate(end)) {
        nextErrors.end_date = 'Datum im Format JJJJ-MM-TT eingeben';
      }
    }

    const totalDosage =
      currentDraft.dosage.morning +
      currentDraft.dosage.noon +
      currentDraft.dosage.evening +
      currentDraft.dosage.night;
    if (totalDosage <= 0) nextErrors.dosage = 'Mindestens ein Dosierungs-Slot muss > 0 sein';

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return null;

    return {
      pzn: currentDraft.pzn.trim(),
      trade_name: currentDraft.trade_name.trim(),
      active_substance: currentDraft.active_substance.trim(),
      form: currentDraft.form.trim(),
      strength: currentDraft.strength.trim(),
      norm_size: currentDraft.norm_size,
      aut_idem: currentDraft.aut_idem,
      coverage: currentDraft.coverage,
      is_chronic: currentDraft.is_chronic,
      start_date: currentDraft.start_date.trim(),
      end_date: currentDraft.is_chronic ? undefined : end,
      duration_days: currentDraft.duration_days.trim() ? Number(currentDraft.duration_days.trim()) : undefined,
      dosage_morning: currentDraft.dosage.morning,
      dosage_noon: currentDraft.dosage.noon,
      dosage_evening: currentDraft.dosage.evening,
      dosage_night: currentDraft.dosage.night,
      dosage_unit: currentDraft.dosage_unit,
      dosage_note: currentDraft.dosage_note.trim() || undefined,
      is_active: true,
    };
  }, []);

  useImperativeHandle(ref, () => ({
    hasEnabledPrescription: () => enabledRef.current,
    getPayload: () => {
      if (!enabledRef.current) return null;
      return buildPayload(draftRef.current);
    },
  }), [buildPayload]);

  const applyPZNSelection = (selection: PZNEntry) => {
    setDraft((prev) => {
      const resolvedUnit = DOSAGE_UNIT_OPTIONS.includes(selection.dosage_unit as DosageUnit)
        ? (selection.dosage_unit as DosageUnit)
        : prev.dosage_unit;

      return {
        ...prev,
        pzn: selection.pzn,
        trade_name: selection.trade_name,
        active_substance: selection.active_substance,
        form: selection.form,
        strength: selection.strength,
        norm_size: selection.norm_size,
        dosage_unit: resolvedUnit,
      };
    });
    setErrors((prev) => ({ ...prev, pzn: '', trade_name: '', active_substance: '', form: '', strength: '' }));
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.headerTitle}>Medikation (E-Rezept)</Text>
        <TouchableOpacity
          style={[styles.toggleBtn, enabled && styles.toggleBtnEnabled]}
          onPress={() => setEnabled((p) => !p)}
          accessibilityRole="switch"
          accessibilityState={{ checked: enabled }}
          accessibilityLabel="Medikation hinzufügen"
        >
          <Text style={[styles.toggleBtnText, enabled && styles.toggleBtnTextEnabled]}>
            {enabled ? 'Aktiv' : 'Hinzufügen'}
          </Text>
        </TouchableOpacity>
      </View>

      {!enabled ? (
        <Text style={styles.helperText}>Optional: Medikament für diesen Besuch verordnen.</Text>
      ) : (
        <>
          <View style={styles.searchWrapper}>
            <PZNSearchInput onSelect={applyPZNSelection} />
            {errors.pzn ? <Text style={styles.errorText}>{errors.pzn}</Text> : null}
          </View>

          <Input
            label="Handelsname"
            value={draft.trade_name}
            onChangeText={(v) => {
              setDraft((p) => ({ ...p, trade_name: v }));
              setErrors((p) => ({ ...p, trade_name: '' }));
            }}
            error={errors.trade_name}
            required
          />

          <Input
            label="Wirkstoff"
            value={draft.active_substance}
            onChangeText={(v) => {
              setDraft((p) => ({ ...p, active_substance: v }));
              setErrors((p) => ({ ...p, active_substance: '' }));
            }}
            error={errors.active_substance}
            required
          />

          <View style={styles.row2}>
            <View style={styles.flex1}>
              <Input
                label="Form"
                value={draft.form}
                onChangeText={(v) => {
                  setDraft((p) => ({ ...p, form: v }));
                  setErrors((p) => ({ ...p, form: '' }));
                }}
                error={errors.form}
                required
              />
            </View>
            <View style={styles.flex1}>
              <Input
                label="Stärke"
                value={draft.strength}
                onChangeText={(v) => {
                  setDraft((p) => ({ ...p, strength: v }));
                  setErrors((p) => ({ ...p, strength: '' }));
                }}
                error={errors.strength}
                required
              />
            </View>
          </View>

          <Text style={styles.sectionLabel}>Normgröße</Text>
          <View style={styles.optionRow}>
            {NORM_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt}
                style={[styles.optionChip, draft.norm_size === opt && styles.optionChipSelected]}
                onPress={() => setDraft((p) => ({ ...p, norm_size: opt }))}
              >
                <Text style={[styles.optionChipText, draft.norm_size === opt && styles.optionChipTextSelected]}>{opt}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Kostenträger</Text>
          <View style={styles.optionRowWrap}>
            {COVERAGE_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt}
                style={[styles.optionChip, draft.coverage === opt && styles.optionChipSelected]}
                onPress={() => setDraft((p) => ({ ...p, coverage: opt }))}
              >
                <Text style={[styles.optionChipText, draft.coverage === opt && styles.optionChipTextSelected]}>{opt}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Aut-Idem</Text>
          <View style={styles.optionRow}>
            <TouchableOpacity
              style={[styles.optionChip, draft.aut_idem && styles.optionChipSelected]}
              onPress={() => setDraft((p) => ({ ...p, aut_idem: true }))}
            >
              <Text style={[styles.optionChipText, draft.aut_idem && styles.optionChipTextSelected]}>Ja</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.optionChip, !draft.aut_idem && styles.optionChipSelected]}
              onPress={() => setDraft((p) => ({ ...p, aut_idem: false }))}
            >
              <Text style={[styles.optionChipText, !draft.aut_idem && styles.optionChipTextSelected]}>Nein</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.sectionLabel}>Therapieart</Text>
          <View style={styles.optionRow}>
            <TouchableOpacity
              style={[styles.optionChip, draft.is_chronic && styles.optionChipSelected]}
              onPress={() => {
                setDraft((p) => ({ ...p, is_chronic: true, end_date: '' }));
                setErrors((p) => ({ ...p, end_date: '' }));
              }}
            >
              <Text style={[styles.optionChipText, draft.is_chronic && styles.optionChipTextSelected]}>Chronisch</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.optionChip, !draft.is_chronic && styles.optionChipSelected]}
              onPress={() => setDraft((p) => ({ ...p, is_chronic: false }))}
            >
              <Text style={[styles.optionChipText, !draft.is_chronic && styles.optionChipTextSelected]}>Befristet</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.row2}>
            <View style={styles.flex1}>
              <Input
                label="Startdatum"
                value={draft.start_date}
                onChangeText={(v) => {
                  setDraft((p) => ({ ...p, start_date: v }));
                  setErrors((p) => ({ ...p, start_date: '' }));
                }}
                placeholder="JJJJ-MM-TT"
                error={errors.start_date}
                required
              />
            </View>
            <View style={styles.flex1}>
              <Input
                label="Enddatum"
                value={draft.end_date}
                onChangeText={(v) => {
                  setDraft((p) => ({ ...p, end_date: v }));
                  setErrors((p) => ({ ...p, end_date: '' }));
                }}
                placeholder={draft.is_chronic ? 'nicht nötig' : 'JJJJ-MM-TT'}
                error={errors.end_date}
                editable={!draft.is_chronic}
              />
            </View>
          </View>

          <Input
            label="Dauer (Tage, optional)"
            value={draft.duration_days}
            onChangeText={(v) => setDraft((p) => ({ ...p, duration_days: v.replace(/[^0-9]/g, '') }))}
            keyboardType="numeric"
            placeholder="z.B. 30"
          />

          <DosageBuilder
            value={draft.dosage}
            onChange={(dosage) => {
              setDraft((p) => ({ ...p, dosage }));
              setErrors((p) => ({ ...p, dosage: '' }));
            }}
          />
          {errors.dosage ? <Text style={styles.errorText}>{errors.dosage}</Text> : null}

          <Text style={styles.sectionLabel}>Dosierungseinheit</Text>
          <View style={styles.optionRowWrap}>
            {DOSAGE_UNIT_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt}
                style={[styles.optionChip, draft.dosage_unit === opt && styles.optionChipSelected]}
                onPress={() => setDraft((p) => ({ ...p, dosage_unit: opt }))}
              >
                <Text style={[styles.optionChipText, draft.dosage_unit === opt && styles.optionChipTextSelected]}>{opt}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Input
            label="Dosierhinweis"
            value={draft.dosage_note}
            onChangeText={(v) => setDraft((p) => ({ ...p, dosage_note: v }))}
            placeholder="z.B. nach dem Essen"
          />

          <Text style={styles.footerHint}>Schema: {dosageLabel} ({draft.dosage_unit})</Text>
        </>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
    gap: spacing.sm,
  },
  headerTitle: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '700',
    flex: 1,
  },
  toggleBtn: {
    borderWidth: 1,
    borderColor: colors.primary,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surface,
  },
  toggleBtnEnabled: {
    backgroundColor: colors.primary,
  },
  toggleBtnText: {
    ...typography.small,
    color: colors.primary,
    fontWeight: '700',
  },
  toggleBtnTextEnabled: {
    color: '#fff',
  },
  helperText: {
    ...typography.small,
    color: colors.text.secondary,
  },
  searchWrapper: {
    zIndex: 12,
    elevation: 12,
  },
  row2: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  flex1: {
    flex: 1,
  },
  sectionLabel: {
    ...typography.small,
    color: colors.text.primary,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  optionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  optionRowWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  optionChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
  },
  optionChipSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  optionChipText: {
    ...typography.small,
    color: colors.text.primary,
    fontWeight: '600',
  },
  optionChipTextSelected: {
    color: '#fff',
  },
  errorText: {
    ...typography.small,
    color: colors.danger,
    marginTop: -spacing.xs,
    marginBottom: spacing.sm,
  },
  footerHint: {
    ...typography.small,
    color: colors.text.secondary,
  },
});

export default MedicationPrescriptionPanel;
