import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';

import { Input } from '@/components/ui';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import PZNSearchInput from '@/components/ehr/PZNSearchInput';
import DosageBuilder, { DosageValue } from '@/components/ehr/DosageBuilder';
import ERezeptFields from '@/components/ehr/ERezeptFields';
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

const DOSAGE_UNIT_OPTIONS: DosageUnit[] = ['Tablette', 'Kapsel', 'ml', 'IE', 'Hub', 'Tropfen'];

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

          <DosageBuilder
            value={draft.dosage}
            unit={draft.dosage_unit}
            onChange={(dosage) => {
              setDraft((p) => ({ ...p, dosage }));
              setErrors((p) => ({ ...p, dosage: '' }));
            }}
            onUnitChange={(unit) => {
              const resolvedUnit = DOSAGE_UNIT_OPTIONS.includes(unit as DosageUnit)
                ? (unit as DosageUnit)
                : draft.dosage_unit;
              setDraft((p) => ({ ...p, dosage_unit: resolvedUnit }));
            }}
          />
          {errors.dosage ? <Text style={styles.errorText}>{errors.dosage}</Text> : null}

          <ERezeptFields
            value={{
              norm_size: draft.norm_size,
              aut_idem: draft.aut_idem,
              coverage: draft.coverage,
              is_chronic: draft.is_chronic,
              duration_days: draft.duration_days.trim() ? Number(draft.duration_days.trim()) : null,
              end_date: draft.end_date.trim() ? draft.end_date : null,
              dosage_note: draft.dosage_note,
            }}
            onChange={(partial) => {
              setDraft((prev) => ({
                ...prev,
                norm_size: partial.norm_size ?? prev.norm_size,
                aut_idem: partial.aut_idem ?? prev.aut_idem,
                coverage: partial.coverage ?? prev.coverage,
                is_chronic: partial.is_chronic ?? prev.is_chronic,
                duration_days:
                  partial.duration_days !== undefined
                    ? (partial.duration_days == null ? '' : String(partial.duration_days))
                    : prev.duration_days,
                end_date: partial.end_date !== undefined ? (partial.end_date ?? '') : prev.end_date,
                dosage_note: partial.dosage_note ?? prev.dosage_note,
              }));

              if (partial.end_date !== undefined || partial.is_chronic !== undefined) {
                setErrors((prev) => ({ ...prev, end_date: '' }));
              }
            }}
          />
          {errors.end_date ? <Text style={styles.errorText}>{errors.end_date}</Text> : null}
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
  errorText: {
    ...typography.small,
    color: colors.danger,
    marginTop: -spacing.xs,
    marginBottom: spacing.sm,
  },
});

export default MedicationPrescriptionPanel;
