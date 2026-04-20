import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';

import { Input, Button } from '@/components/ui';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import PZNSearchInput from '@/components/ehr/PZNSearchInput';
import DosageBuilder, { DosageValue } from '@/components/ehr/DosageBuilder';
import ERezeptFields, { ERezeptValue } from '@/components/ehr/ERezeptFields';
import { PZNEntry } from '@/constants/pzn_data';
import {
  prescribeMedication,
  type DosageUnit,
  type MedicationRecord,
  type CreateDoctorMedicationRequest,
} from '@/services/api/medications';

export type Medication = MedicationRecord;

export interface MedicationPrescriptionPanelProps {
  patientId: string;
  visitId?: string;
  onMedicationAdded?: (med: Medication) => void;
}

interface PrescriptionListItem {
  localId: string;
  payload: CreateDoctorMedicationRequest;
  saved: boolean;
  saveError?: string;
  savedMedication?: Medication;
}

const DOSAGE_UNIT_OPTIONS: DosageUnit[] = ['Tablette', 'Kapsel', 'ml', 'IE', 'Hub', 'Tropfen'];

const todayISO = (): string => new Date().toISOString().split('T')[0];

const defaultDosage = (): DosageValue => ({ morning: 0, noon: 0, evening: 0, night: 0 });

const defaultERezept = (): ERezeptValue => ({
  norm_size: 'N1',
  aut_idem: false,
  coverage: 'GKV',
  is_chronic: true,
  duration_days: null,
  end_date: null,
  dosage_note: '',
});

function toDosageUnit(unit: string, fallback: DosageUnit): DosageUnit {
  return DOSAGE_UNIT_OPTIONS.includes(unit as DosageUnit) ? (unit as DosageUnit) : fallback;
}

function getDosageTotal(v: DosageValue): number {
  return v.morning + v.noon + v.evening + v.night;
}

function formatDose(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function buildDosageLabel(dose: DosageValue, unit: string): string {
  const schedule = `${formatDose(dose.morning)}-${formatDose(dose.noon)}-${formatDose(dose.evening)}-${formatDose(dose.night)}`;
  const printableUnit = unit === 'Tablette' ? 'Tabletten' : unit === 'Kapsel' ? 'Kapseln' : unit;
  return `${schedule} ${printableUnit}`;
}

export default function MedicationPrescriptionPanel({
  patientId,
  visitId,
  onMedicationAdded,
}: MedicationPrescriptionPanelProps) {
  const [currentDrug, setCurrentDrug] = useState<PZNEntry | null>(null);
  const [currentDosage, setCurrentDosage] = useState<DosageValue>(defaultDosage());
  const [currentUnit, setCurrentUnit] = useState<DosageUnit>('Tablette');
  const [currentERezept, setCurrentERezept] = useState<ERezeptValue>(defaultERezept());
  const [currentStartDate, setCurrentStartDate] = useState<string>(todayISO());
  const [prescriptionList, setPrescriptionList] = useState<PrescriptionListItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canAddCurrent = useMemo(
    () => !!currentDrug && getDosageTotal(currentDosage) > 0,
    [currentDrug, currentDosage]
  );

  const unsavedCount = useMemo(() => prescriptionList.filter((item) => !item.saved).length, [prescriptionList]);

  const applyPZNSelection = (entry: PZNEntry) => {
    setCurrentDrug(entry);
    setCurrentUnit(toDosageUnit(entry.dosage_unit, currentUnit));
    setCurrentERezept((prev) => ({ ...prev, norm_size: entry.norm_size }));
    setError(null);
  };

  const clearSelection = () => {
    setCurrentDrug(null);
    setCurrentDosage(defaultDosage());
  };

  const addCurrentToList = () => {
    if (!currentDrug) {
      setError('Bitte wählen Sie zuerst ein Medikament aus.');
      return;
    }

    if (getDosageTotal(currentDosage) <= 0) {
      setError('Mindestens ein Dosierungs-Slot muss größer als 0 sein.');
      return;
    }

    const payload: CreateDoctorMedicationRequest = {
      pzn: currentDrug.pzn,
      trade_name: currentDrug.trade_name,
      active_substance: currentDrug.active_substance,
      form: currentDrug.form,
      strength: currentDrug.strength,
      norm_size: currentERezept.norm_size,
      aut_idem: currentERezept.aut_idem,
      coverage: currentERezept.coverage,
      is_chronic: currentERezept.is_chronic,
      start_date: currentStartDate,
      end_date: currentERezept.is_chronic ? undefined : (currentERezept.end_date ?? undefined),
      duration_days: currentERezept.duration_days ?? undefined,
      dosage_morning: currentDosage.morning,
      dosage_noon: currentDosage.noon,
      dosage_evening: currentDosage.evening,
      dosage_night: currentDosage.night,
      dosage_unit: currentUnit,
      dosage_note: currentERezept.dosage_note || undefined,
      visit_id: visitId,
      is_active: true,
    };

    setPrescriptionList((prev) => [
      ...prev,
      {
        localId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        payload,
        saved: false,
      },
    ]);

    setCurrentDrug(null);
    setCurrentDosage(defaultDosage());
    setError(null);
  };

  const removeFromList = (localId: string) => {
    if (saving) return;
    setPrescriptionList((prev) => prev.filter((item) => item.localId !== localId));
  };

  const saveAll = async () => {
    const pending = prescriptionList.filter((item) => !item.saved);
    if (pending.length === 0 || saving) return;

    if (!patientId) {
      setError('Patienten-ID fehlt.');
      return;
    }

    if (!visitId) {
      setError('Bitte zuerst den Besuch speichern, damit die Verordnungen dem Besuch zugeordnet werden.');
      return;
    }

    setSaving(true);
    setError(null);

    for (const item of pending) {
      try {
        const saved = await prescribeMedication(patientId, {
          ...item.payload,
          visit_id: visitId,
        });

        setPrescriptionList((prev) => prev.map((row) => (
          row.localId === item.localId
            ? { ...row, saved: true, saveError: undefined, savedMedication: saved }
            : row
        )));

        onMedicationAdded?.(saved);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Fehler beim Speichern der Medikation';
        setPrescriptionList((prev) => prev.map((row) => (
          row.localId === item.localId
            ? { ...row, saveError: message }
            : row
        )));
        setError('Mindestens eine Medikation konnte nicht gespeichert werden. Bitte erneut versuchen.');
      }
    }

    setSaving(false);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.panelTitle}>Medikation hinzufügen</Text>

      <View style={styles.searchWrapper}>
        <PZNSearchInput onSelect={applyPZNSelection} disabled={saving} />
      </View>

      {currentDrug && (
        <View style={styles.drugCard}>
          <View style={styles.drugMain}>
            <Text style={styles.drugTitle}>{currentDrug.trade_name}</Text>
            <Text style={styles.drugSubtitle}>{currentDrug.active_substance} • {currentDrug.strength}</Text>
            <View style={styles.pznBadge}>
              <Text style={styles.pznText}>{currentDrug.pzn}</Text>
            </View>
          </View>

          <TouchableOpacity
            onPress={clearSelection}
            style={styles.clearButton}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel="Auswahl löschen"
          >
            <Text style={styles.clearButtonText}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      <DosageBuilder
        value={currentDosage}
        unit={currentUnit}
        onChange={setCurrentDosage}
        onUnitChange={(unit) => setCurrentUnit(toDosageUnit(unit, currentUnit))}
        disabled={saving || !currentDrug}
      />

      <ERezeptFields
        value={currentERezept}
        onChange={(partial) => setCurrentERezept((prev) => ({ ...prev, ...partial }))}
        disabled={saving || !currentDrug}
      />

      <Input
        label="Startdatum"
        value={currentStartDate}
        onChangeText={setCurrentStartDate}
        placeholder="JJJJ-MM-TT"
        editable={!saving}
      />

      <Button
        title="Zur Verordnungsliste hinzufügen"
        onPress={addCurrentToList}
        disabled={!canAddCurrent || saving}
        fullWidth
      />

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {prescriptionList.length > 0 && (
        <View style={styles.listSection}>
          <Text style={styles.sectionTitle}>Verordnungen in diesem Besuch</Text>

          {prescriptionList.map((item) => {
            const doseLabel = buildDosageLabel({
              morning: item.payload.dosage_morning,
              noon: item.payload.dosage_noon,
              evening: item.payload.dosage_evening,
              night: item.payload.dosage_night,
            }, item.payload.dosage_unit);

            return (
              <View key={item.localId} style={styles.listRow}>
                <View style={styles.listMain}>
                  <Text style={styles.listTrade}>{item.payload.trade_name}</Text>
                  <Text style={styles.listDose}>{doseLabel}</Text>
                  {item.saved ? <Text style={styles.savedText}>Gespeichert</Text> : null}
                  {item.saveError ? <Text style={styles.rowErrorText}>{item.saveError}</Text> : null}
                </View>

                <TouchableOpacity
                  onPress={() => removeFromList(item.localId)}
                  disabled={saving}
                  style={styles.trashButton}
                  accessibilityRole="button"
                  accessibilityLabel={`Verordnung ${item.payload.trade_name} entfernen`}
                >
                  <Text style={styles.trashText}>🗑️</Text>
                </TouchableOpacity>
              </View>
            );
          })}

          {!visitId && unsavedCount > 0 ? (
            <Text style={styles.helperText}>Bitte zuerst den Besuch speichern, danach können Verordnungen gespeichert werden.</Text>
          ) : null}

          <Button
            title={saving ? 'Speichern…' : `Alle speichern${unsavedCount > 0 ? ` (${unsavedCount})` : ''}`}
            onPress={saveAll}
            loading={saving}
            disabled={saving || unsavedCount === 0 || !visitId}
            fullWidth
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.md,
  },
  panelTitle: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  searchWrapper: {
    zIndex: 12,
    elevation: 12,
  },
  drugCard: {
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    gap: spacing.sm,
  },
  drugMain: {
    flex: 1,
  },
  drugTitle: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '700',
  },
  drugSubtitle: {
    ...typography.small,
    color: colors.text.secondary,
    marginTop: 2,
  },
  pznBadge: {
    alignSelf: 'flex-start',
    marginTop: spacing.xs,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.primary + '14',
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  pznText: {
    ...typography.small,
    color: colors.primary,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  clearButton: {
    width: 28,
    height: 28,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceVariant,
  },
  clearButtonText: {
    ...typography.body,
    color: colors.text.secondary,
    fontWeight: '700',
    lineHeight: 20,
  },
  listSection: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  sectionTitle: {
    ...typography.small,
    color: colors.text.primary,
    fontWeight: '700',
  },
  listRow: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  listMain: {
    flex: 1,
  },
  listTrade: {
    ...typography.small,
    color: colors.text.primary,
    fontWeight: '700',
  },
  listDose: {
    ...typography.small,
    color: colors.text.secondary,
  },
  savedText: {
    ...typography.small,
    color: colors.successDark,
    marginTop: 2,
  },
  rowErrorText: {
    ...typography.small,
    color: colors.danger,
    marginTop: 2,
  },
  trashButton: {
    width: 32,
    height: 32,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceVariant,
  },
  trashText: {
    fontSize: 16,
  },
  helperText: {
    ...typography.small,
    color: colors.text.secondary,
  },
  errorText: {
    ...typography.small,
    color: colors.danger,
    marginTop: spacing.sm,
  },
});
