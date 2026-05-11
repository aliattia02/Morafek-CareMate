/**
 * FHIR Export Screen
 * Location: mobile/app/(app)/ehr/fhir-export.tsx
 *
 * Dedicated page for the patient's full FHIR R4 document Bundle export.
 * Explains the document structure, the German compliance profiles used,
 * and lets the patient trigger GET /api/patient/fhir-export.
 *
 * After a successful export the screen shows a per-resource summary and
 * offers a Share sheet so the patient can send the JSON to their GP / KIS.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { apiClient } from '@/services/api/client';
import { E, ET } from '@/constants/elderlyTheme';

// ─────────────────────────────────────────────────────────────────────────────
// Static document-structure data (mirrors ehr_routes.py export logic)
// ─────────────────────────────────────────────────────────────────────────────

interface ResourceInfo {
  icon:        string;
  type:        string;
  label:       string;
  description: string;
  profiles:    string[];
  accentColor: string;
}

const RESOURCE_MANIFEST: ResourceInfo[] = [
  {
    icon:        '👤',
    type:        'Patient',
    label:       'Patient demographics',
    description: 'Your name, date of birth, gender, GKV Krankenversichertennummer, and address.',
    profiles:    ['de.basisprofil.r4 Patient', 'ISiKPatient'],
    accentColor: '#4A90D9',
  },
  {
    icon:        '🩺',
    type:        'Observation',
    label:       'Vital-sign observations',
    description: 'Blood pressure (systolic + diastolic) and pulse, each as a separate Observation. Coded with LOINC. UCUM units (mmHg, /min).',
    profiles:    ['ISiKLebenszeichen', 'de Observation vital-sign'],
    accentColor: '#E8734A',
  },
  {
    icon:        '🏥',
    type:        'Encounter',
    label:       'Clinical visits',
    description: 'Every recorded doctor visit, including diagnosis, visit reason, and date. Identified by an Aufnahmenummer.',
    profiles:    ['ISiKKontaktGesundheitseinrichtung', 'de.basisprofil.r4 Encounter'],
    accentColor: '#7B61FF',
  },
  {
    icon:        '🔬',
    type:        'Condition',
    label:       'Diagnoses',
    description: 'ICD-10-GM coded diagnoses linked to the corresponding visit Encounter. Only conditions with a valid ICD code are included.',
    profiles:    ['ISiKDiagnose', 'de.basisprofil.r4 Condition'],
    accentColor: '#E05D5D',
  },
  {
    icon:        '📄',
    type:        'DocumentReference',
    label:       'Clinical documents',
    description: 'Lab reports (LOINC 11502-2), imaging reports (18748-4), prescriptions, and other uploads. Binary content via Cloudinary URL.',
    profiles:    ['ISiKDokumentenInformationen'],
    accentColor: '#5D9E6E',
  },
  {
    icon:        '💊',
    type:        'Medication',
    label:       'Medication resources',
    description: 'Each active medication as a KBV_PR_ERP_Medication_PZN resource, identified by Pharmazentralnummer (PZN).',
    profiles:    ['KBV_PR_ERP_Medication_PZN'],
    accentColor: '#3AAA8E',
  },
  {
    icon:        '📋',
    type:        'MedicationRequest',
    label:       'Prescriptions',
    description: 'Structured e-prescription (E-Rezept) resource for each active medication. Encounter reference is included only when the linked visit is also in the bundle.',
    profiles:    ['KBV_PR_ERP_Prescription'],
    accentColor: '#D48B2F',
  },
  {
    icon:        '📆',
    type:        'MedicationStatement',
    label:       'Intake history',
    description: `Actual intake records from the last 90 days, one MedicationStatement per recorded dose. Supports adherence tracking.`,
    profiles:    ['HL7 FHIR R4 MedicationStatement'],
    accentColor: '#8F6BBE',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Compliance badges
// ─────────────────────────────────────────────────────────────────────────────

const COMPLIANCE_BADGES = [
  { label: 'FHIR R4',            color: '#1565C0', bg: '#E3F2FD' },
  { label: 'ISiK Stage 1',       color: '#1B5E20', bg: '#E8F5E9' },
  { label: 'de.basisprofil.r4',  color: '#4A148C', bg: '#F3E5F5' },
  { label: 'KBV ERP',            color: '#BF360C', bg: '#FBE9E7' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function ComplianceBadge({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: bg, borderColor: color + '55' }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

function ResourceCard({ info }: { info: ResourceInfo }) {
  return (
    <View style={[styles.resourceCard, { borderLeftColor: info.accentColor }]}>
      <View style={styles.resourceHeader}>
        <View style={[styles.resourceIconBg, { backgroundColor: info.accentColor + '20' }]}>
          <Text style={styles.resourceIcon}>{info.icon}</Text>
        </View>
        <View style={styles.resourceTitleGroup}>
          <Text style={styles.resourceType}>{info.type}</Text>
          <Text style={styles.resourceLabel}>{info.label}</Text>
        </View>
      </View>
      <Text style={styles.resourceDesc}>{info.description}</Text>
      <View style={styles.profilePillRow}>
        {info.profiles.map((p) => (
          <View key={p} style={styles.profilePill}>
            <Text style={styles.profilePillText}>{p}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function BundleSummaryCard({ entries }: { entries: BundleEntry[] }) {
  const counts: Record<string, number> = {};
  for (const e of entries) {
    const rt = e.resource?.resourceType ?? 'Unknown';
    counts[rt] = (counts[rt] ?? 0) + 1;
  }
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  return (
    <View style={styles.summaryCard}>
      <Text style={styles.summaryTitle}>✅ Bundle exported</Text>
      <Text style={styles.summarySubtitle}>{entries.length} total resources</Text>
      <View style={styles.summaryTable}>
        {rows.map(([rt, count]) => (
          <View key={rt} style={styles.summaryRow}>
            <Text style={styles.summaryRt}>{rt}</Text>
            <View style={styles.summaryCountBg}>
              <Text style={styles.summaryCount}>{count}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface BundleEntry {
  fullUrl?:  string;
  resource?: { resourceType?: string; [key: string]: unknown };
}

interface FhirBundle {
  resourceType: string;
  type:         string;
  entry?:       BundleEntry[];
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function FhirExportScreen() {
  const [exporting,  setExporting]  = useState(false);
  const [bundle,     setBundle]     = useState<FhirBundle | null>(null);
  const [error,      setError]      = useState<string | null>(null);

  // ── Trigger export ──────────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    try {
      setExporting(true);
      setError(null);
      setBundle(null);

      const res = await apiClient.get<FhirBundle>('/api/patient/fhir-export');
      setBundle(res.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  }, []);

  // ── Download / share bundle JSON ────────────────────────────────────────────
  const handleShare = useCallback(async () => {
    if (!bundle) return;
    const json     = JSON.stringify(bundle, null, 2);
    const filename = `fhir-export-${new Date().toISOString().slice(0, 10)}.json`;

    if (Platform.OS === 'web') {
      const blob = new Blob([json], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return;
    }

    const path = `${FileSystem.cacheDirectory}${filename}`;
    await FileSystem.writeAsStringAsync(path, json, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    const canShare = await Sharing.isAvailableAsync();
    if (canShare) {
      await Sharing.shareAsync(path, {
        mimeType:    'application/json',
        dialogTitle: 'Save or share your FHIR export',
        UTI:         'public.json',
      });
    }
  }, [bundle]);

  const entries = bundle?.entry ?? [];

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'FHIR Data Export' }} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
      >

        {/* ── Header banner ── */}
        <View style={styles.heroBanner}>
          <Text style={styles.heroEmoji}>🗂️</Text>
          <View style={styles.heroText}>
            <Text style={styles.heroTitle}>Your health data as FHIR R4</Text>
            <Text style={styles.heroSub}>
              Export a complete, interoperable snapshot of your medical record
              in the format used by German hospitals and insurers.
            </Text>
          </View>
        </View>

        {/* ── Compliance badges ── */}
        <View style={styles.badgeRow}>
          {COMPLIANCE_BADGES.map((b) => (
            <ComplianceBadge key={b.label} {...b} />
          ))}
        </View>

        {/* ── What's in the bundle ── */}
        <Text style={styles.sectionHeading}>What's included in the bundle</Text>
        <Text style={styles.sectionCaption}>
          The exported file is a FHIR <Text style={styles.mono}>document</Text> Bundle.
          Each section below becomes one or more resources inside that bundle.
        </Text>

        {RESOURCE_MANIFEST.map((info) => (
          <ResourceCard key={info.type} info={info} />
        ))}

        {/* ── Data-quality notes ── */}
        <View style={styles.noteBox}>
          <Text style={styles.noteTitle}>📌 What gets filtered out</Text>
          <Text style={styles.noteItem}>
            · Conditions without an ICD-10-GM code are omitted (ISiKDiagnose requires at least one valid coding).
          </Text>
          <Text style={styles.noteItem}>
            · MedicationRequest encounter references are dropped if the linked visit is not present in the bundle.
          </Text>
          <Text style={styles.noteItem}>
            · Medication intake history covers the last 90 days only.
          </Text>
          <Text style={styles.noteItem}>
            · <Text style={styles.mono}>Bundle.total</Text> is not set — this is a <Text style={styles.mono}>document</Text> bundle, not a searchset.
          </Text>
        </View>

        {/* ── Export button / result ── */}
        {!bundle ? (
          <TouchableOpacity
            style={[styles.exportBtn, exporting && styles.exportBtnDisabled]}
            onPress={handleExport}
            disabled={exporting}
            activeOpacity={0.8}
          >
            {exporting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.exportBtnText}>⬇️  Export my FHIR bundle</Text>
            )}
          </TouchableOpacity>
        ) : (
          <>
            <BundleSummaryCard entries={entries} />

            <TouchableOpacity
              style={styles.shareBtn}
              onPress={handleShare}
              activeOpacity={0.8}
            >
              <Text style={styles.shareBtnText}>📤  Share JSON</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.reExportBtn}
              onPress={handleExport}
              disabled={exporting}
              activeOpacity={0.8}
            >
              {exporting
                ? <ActivityIndicator color={E.colors.primary} />
                : <Text style={styles.reExportBtnText}>↺  Re-export</Text>
              }
            </TouchableOpacity>
          </>
        )}

        {/* ── Error state ── */}
        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>⚠️ {error}</Text>
          </View>
        ) : null}

      </ScrollView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: E.colors.bg,
  },
  scroll: { flex: 1 },
  content: {
    padding: E.padSm,
    paddingBottom: 48,
    gap: E.padSm,
  },

  // ── Hero banner ──
  heroBanner: {
    flexDirection: 'row',
    backgroundColor: E.colors.primary,
    borderRadius: E.radius,
    padding: E.pad,
    gap: E.padSm,
    alignItems: 'flex-start',
    ...E.shadow,
  },
  heroEmoji: { fontSize: 36, lineHeight: 44 },
  heroText:  { flex: 1 },
  heroTitle: {
    ...ET.h3,
    color: E.colors.textInverse,
    fontWeight: '700',
    marginBottom: 4,
  },
  heroSub: {
    ...ET.small,
    color: E.colors.primaryLight,
    lineHeight: 18,
  },

  // ── Compliance badges ──
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  badge: {
    borderRadius: E.radiusFull,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: {
    ...ET.caption,
    fontWeight: '700',
    fontSize: 11,
  },

  // ── Section headings ──
  sectionHeading: {
    ...ET.h3,
    fontWeight: '700',
    marginBottom: -4,
  },
  sectionCaption: {
    ...ET.small,
    color: E.colors.textSecondary,
    lineHeight: 18,
    marginBottom: 2,
  },
  mono: {
    fontFamily: 'Courier New',
    fontSize: 12,
    color: E.colors.textSecondary,
  },

  // ── Resource card ──
  resourceCard: {
    backgroundColor: E.colors.surface,
    borderRadius: E.radius,
    borderWidth: 1,
    borderColor: E.colors.border,
    borderLeftWidth: 4,
    padding: E.padSm,
    gap: 8,
    ...E.shadowSm,
  },
  resourceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: E.padXs,
  },
  resourceIconBg: {
    width: 36,
    height: 36,
    borderRadius: E.radiusXs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resourceIcon: { fontSize: 18 },
  resourceTitleGroup: { flex: 1 },
  resourceType: {
    ...ET.bodyBold,
    fontWeight: '700',
    fontFamily: 'Courier New',
    fontSize: 13,
  },
  resourceLabel: {
    ...ET.caption,
    color: E.colors.textSecondary,
  },
  resourceDesc: {
    ...ET.small,
    color: E.colors.textSecondary,
    lineHeight: 18,
  },
  profilePillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  profilePill: {
    backgroundColor: E.colors.bg,
    borderRadius: E.radiusFull,
    borderWidth: 1,
    borderColor: E.colors.border,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  profilePillText: {
    ...ET.caption,
    color: E.colors.textSecondary,
    fontSize: 10,
  },

  // ── Data-quality note ──
  noteBox: {
    backgroundColor: '#FFFDE7',
    borderRadius: E.radius,
    borderWidth: 1,
    borderColor: '#F9A825' + '55',
    padding: E.padSm,
    gap: 6,
  },
  noteTitle: {
    ...ET.bodyBold,
    fontWeight: '700',
    color: '#E65100',
    marginBottom: 2,
  },
  noteItem: {
    ...ET.small,
    color: '#5D4037',
    lineHeight: 18,
  },

  // ── Export button ──
  exportBtn: {
    backgroundColor: E.colors.primary,
    borderRadius: E.radius,
    paddingVertical: E.pad,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    ...E.shadow,
  },
  exportBtnDisabled: {
    opacity: 0.6,
  },
  exportBtnText: {
    ...ET.bodyBold,
    color: E.colors.textInverse,
    fontWeight: '700',
    fontSize: 16,
  },

  // ── Bundle summary ──
  summaryCard: {
    backgroundColor: '#E8F5E9',
    borderRadius: E.radius,
    borderWidth: 1,
    borderColor: '#A5D6A7',
    padding: E.padSm,
    gap: 8,
  },
  summaryTitle: {
    ...ET.h3,
    fontWeight: '700',
    color: '#1B5E20',
  },
  summarySubtitle: {
    ...ET.small,
    color: '#2E7D32',
    marginTop: -6,
  },
  summaryTable: { gap: 4 },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#C8E6C9',
  },
  summaryRt: {
    ...ET.body,
    fontFamily: 'Courier New',
    fontSize: 13,
    color: '#1B5E20',
  },
  summaryCountBg: {
    backgroundColor: '#2E7D32',
    borderRadius: E.radiusFull,
    minWidth: 26,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  summaryCount: {
    ...ET.caption,
    color: '#fff',
    fontWeight: '700',
  },

  // ── Share / re-export buttons ──
  shareBtn: {
    backgroundColor: E.colors.accent,
    borderRadius: E.radius,
    paddingVertical: E.padSm,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    ...E.shadowSm,
  },
  shareBtnText: {
    ...ET.bodyBold,
    color: E.colors.textInverse,
    fontWeight: '700',
  },
  reExportBtn: {
    borderRadius: E.radius,
    paddingVertical: E.padSm,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    borderWidth: 1,
    borderColor: E.colors.border,
  },
  reExportBtnText: {
    ...ET.body,
    color: E.colors.textSecondary,
  },

  // ── Error ──
  errorBox: {
    backgroundColor: '#FFEBEE',
    borderRadius: E.radius,
    borderWidth: 1,
    borderColor: '#EF9A9A',
    padding: E.padSm,
  },
  errorText: {
    ...ET.body,
    color: '#B71C1C',
  },
});