/**
 * FHIR Export Screen
 * Location: mobile/app/(app)/ehr/fhir-export.tsx
 *
 * Standard (identified) FHIR R4 document Bundle export.
 * Intended for direct EHR / KIS integration — always available to
 * authenticated patients regardless of research consent status.
 *
 * Endpoint: GET /api/patient/fhir-export
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXPORT TYPES — summary of the two separate paths in this app:
 *
 *   A) STANDARD FHIR export  (this screen)
 *      • Route:   GET /api/patient/fhir-export
 *      • Who:     Any authenticated patient
 *      • Purpose: Sending full identified record to your GP / KIS / hospital
 *      • Consent: NOT required
 *
 *   B) PSEUDONYMISED export   (consent.tsx)
 *      • Route:   GET /api/patient/fhir-export/pseudonymised
 *      • Who:     Patients with active gICS research consent
 *      • Purpose: Research data sharing — identity replaced by gPAS pseudonym
 *      • Consent: REQUIRED — managed on the Data Sharing screen
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * German compliance profiles included in the export:
 *   FHIR R4 · ISiK Stage 1 · de.basisprofil.r4 · KBV ERP
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

import { fetchStandardFhirBundle } from '@/services/api/consent';
import { E, ET } from '@/constants/elderlyTheme';

// ─────────────────────────────────────────────────────────────────────────────
// Static resource manifest (mirrors ehr_routes.py export logic)
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
    description: 'Structured e-prescription (E-Rezept) for each active medication. Encounter reference included when the linked visit is in the bundle.',
    profiles:    ['KBV_PR_ERP_Prescription'],
    accentColor: '#D48B2F',
  },
  {
    icon:        '📆',
    type:        'MedicationStatement',
    label:       'Intake history',
    description: 'Actual intake records from the last 90 days, one MedicationStatement per dose. Supports adherence tracking.',
    profiles:    ['HL7 FHIR R4 MedicationStatement'],
    accentColor: '#8F6BBE',
  },
];

const COMPLIANCE_BADGES = [
  { label: 'FHIR R4',           color: '#1565C0', bg: '#E3F2FD' },
  { label: 'ISiK Stage 1',      color: '#1B5E20', bg: '#E8F5E9' },
  { label: 'de.basisprofil.r4', color: '#4A148C', bg: '#F3E5F5' },
  { label: 'KBV ERP',           color: '#BF360C', bg: '#FBE9E7' },
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
  // Standard FHIR export has NO pseudonym gate — always available.
  const [exporting, setExporting] = useState(false);
  const [bundle,    setBundle]    = useState<FhirBundle | null>(null);
  const [error,     setError]     = useState<string | null>(null);

  // ── Trigger export ──────────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    try {
      setExporting(true);
      setError(null);
      setBundle(null);
      const data = await fetchStandardFhirBundle<FhirBundle>();
      setBundle(data);
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

    const path = `${FileSystem.documentDirectory}${filename}`;
    await FileSystem.writeAsStringAsync(path, json, { encoding: 'utf8' });
    const canShare = await Sharing.isAvailableAsync();
    if (canShare) {
      await Sharing.shareAsync(path, {
        mimeType:    'application/json',
        dialogTitle: 'Share FHIR R4 Bundle',
        UTI:         'public.json',
      });
    }
  }, [bundle]);

  const entries = bundle?.entry ?? [];

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'FHIR Export' }} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Hero ── */}
        <View style={styles.hero}>
          <Text style={styles.heroEmoji}>📦</Text>
          <View style={styles.heroText}>
            <Text style={styles.heroTitle}>Standard FHIR R4 Export</Text>
            <Text style={styles.heroSub}>
              Your full identified health record · for GP, hospital, or KIS
            </Text>
          </View>
        </View>

        {/* ── "Always available" notice ── */}
        <View style={styles.availabilityBanner}>
          <Text style={styles.availabilityIcon}>✅</Text>
          <View style={styles.availabilityText}>
            <Text style={styles.availabilityTitle}>Always available</Text>
            <Text style={styles.availabilityBody}>
              This export is available at any time and does not require research
              consent. For the anonymised research export, visit the{' '}
              <Text style={styles.availabilityLink}>Data Sharing</Text> screen.
            </Text>
          </View>
        </View>

        {/* ── Compliance badges ── */}
        <View style={styles.badgeRow}>
          {COMPLIANCE_BADGES.map((b) => (
            <ComplianceBadge key={b.label} {...b} />
          ))}
        </View>

        {/* ── Resource manifest ── */}
        <Text style={styles.sectionHeading}>What's included</Text>
        <Text style={styles.sectionCaption}>
          All data is encoded in FHIR R4 with German ISiK / MIO profiles.
        </Text>
        {RESOURCE_MANIFEST.map((info) => (
          <ResourceCard key={info.type} info={info} />
        ))}

        {/* ── Data quality note ── */}
        <View style={styles.noteBox}>
          <Text style={styles.noteTitle}>ℹ️ Data quality note</Text>
          <Text style={styles.noteItem}>• Only data entered by your doctor is included.</Text>
          <Text style={styles.noteItem}>• Diagnoses without a valid ICD-10-GM code are omitted.</Text>
          <Text style={styles.noteItem}>• Documents are referenced by URL, not embedded in the bundle.</Text>
          <Text style={styles.noteItem}>• Medication intake records cover the last 90 days.</Text>
        </View>

        {/* ── Export button ── */}
        <TouchableOpacity
          style={[styles.exportBtn, exporting && styles.exportBtnLoading]}
          onPress={handleExport}
          disabled={exporting}
          activeOpacity={0.85}
        >
          {exporting
            ? <ActivityIndicator color={E.colors.textInverse} />
            : <Text style={styles.exportBtnText}>⬇️  Export my FHIR bundle</Text>}
        </TouchableOpacity>

        {/* ── Error ── */}
        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>⚠️ {error}</Text>
          </View>
        )}

        {/* ── Bundle summary ── */}
        {bundle && entries.length > 0 && (
          <BundleSummaryCard entries={entries} />
        )}

        {/* ── Share / re-export ── */}
        {bundle && (
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.shareBtn, { flex: 2 }]}
              onPress={handleShare}
              activeOpacity={0.85}
            >
              <Text style={styles.shareBtnText}>📤  Share / Save JSON</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.reExportBtn, { flex: 1 }]}
              onPress={handleExport}
              disabled={exporting}
              activeOpacity={0.85}
            >
              <Text style={styles.reExportBtnText}>↺  Re-export</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── bottom padding ── */}
        <View style={{ height: 32 }} />
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
  scroll:  { flex: 1 },
  content: {
    padding: E.padSm,
    gap: E.padSm,
  },

  // ── Hero ──
  hero: {
    backgroundColor: E.colors.primary,
    borderRadius: E.radius,
    padding: E.pad,
    flexDirection: 'row',
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

  // ── Availability banner ──
  availabilityBanner: {
    backgroundColor: '#E8F5E9',
    borderRadius: E.radius,
    borderWidth: 1,
    borderColor: '#A5D6A7',
    padding: E.padSm,
    flexDirection: 'row',
    gap: E.padXs,
    alignItems: 'flex-start',
  },
  availabilityIcon: { fontSize: 18, lineHeight: 24 },
  availabilityText: { flex: 1, gap: 4 },
  availabilityTitle: {
    ...ET.bodyBold,
    color: '#1B5E20',
    fontWeight: '700',
  },
  availabilityBody: {
    ...ET.small,
    color: '#2E7D32',
    lineHeight: 18,
  },
  availabilityLink: {
    fontWeight: '700',
    textDecorationLine: 'underline',
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

  // ── Data quality note ──
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
  exportBtnLoading: {
    opacity: 0.7,
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

  // ── Share / re-export ──
  actionRow: {
    flexDirection: 'row',
    gap: E.padXs,
  },
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