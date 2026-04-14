/**
 * Import Bundle Screen
 * Location: mobile/app/(app)/ehr/import-bundle.tsx
 *
 * Patient-facing "Import from doctor" screen for receiving the signed delta
 * bundle after a visit.
 *
 * Flow:
 *   1. Two entry-point cards let the patient collect the two halves of the
 *      encrypted bundle in any order:
 *        a. "Scan QR key"       — opens expo-camera in QR scan mode.
 *        b. "Pick encrypted file" — opens expo-document-picker for the .bin.
 *   2. Once both are ready, fileToBytes() + decryptBundle() is called,
 *      followed by importDeltaBundle() to merge into local SQLite.
 *   3. A summary card shows "Imported: X visits, Y exercises, Z conditions".
 *   4. A "Done" button navigates back to the patient home tab.
 *
 * DSGVO / GDPR: the ciphertext file is meaningless without the QR key and
 * vice-versa.  The decrypted bundle is stored locally only after the patient
 * explicitly triggers the import.
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Alert,
  Modal,
  Pressable,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { fileToBytes, decryptBundle } from '@/utils/fhirCrypto';
import { importDeltaBundle, ImportSummary } from '@/utils/fhirBundleImport';
import { Loading } from '@/components/ui/Loading';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { colors, spacing, typography, borderRadius, shadows } from '@/constants/theme';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ScreenPhase =
  | 'collect'    // waiting for QR and/or file
  | 'processing' // decrypting + importing
  | 'done'       // import succeeded
  | 'error';     // something went wrong

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function ImportBundleScreen() {
  const router = useRouter();

  // ── Collected inputs ────────────────────────────────────────────────────────
  const [qrPayload,  setQrPayload]  = useState<string | null>(null);
  const [fileUri,    setFileUri]    = useState<string | null>(null);

  // ── UI state ────────────────────────────────────────────────────────────────
  const [phase,      setPhase]      = useState<ScreenPhase>('collect');
  const [errorMsg,   setErrorMsg]   = useState<string | null>(null);
  const [summary,    setSummary]    = useState<ImportSummary | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);

  // ── Camera permissions ──────────────────────────────────────────────────────
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  // ── Trigger processing once both inputs are ready ───────────────────────────
  useEffect(() => {
    if (qrPayload && fileUri && phase === 'collect') {
      processBundle(qrPayload, fileUri);
    }
    // processBundle is defined below; disabling exhaustive-deps is intentional
    // because we want this to fire exactly once when both values are set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qrPayload, fileUri]);

  // ── Core: decrypt + import ──────────────────────────────────────────────────

  const processBundle = useCallback(async (qr: string, uri: string) => {
    setPhase('processing');
    setErrorMsg(null);

    try {
      const cipherBytes = await fileToBytes(uri);

      let bundleJson: string;
      try {
        bundleJson = await decryptBundle(cipherBytes, qr);
      } catch {
        // Any crypto failure means the QR does not match this file.
        throw new DecryptionError('Wrong QR code for this file');
      }

      let result: ImportSummary;
      try {
        result = await importDeltaBundle(bundleJson);
      } catch (err: unknown) {
        // importDeltaBundle / validateBundle throws on malformed bundles.
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('[fhirBundleImport]')) {
          throw new BundleValidationError('File does not appear to be a Morafek bundle');
        }
        throw err;
      }

      setSummary(result);
      setPhase('done');
    } catch (err: unknown) {
      if (err instanceof DecryptionError || err instanceof BundleValidationError) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'An unexpected error occurred.');
      }
      setPhase('error');
    }
  }, []);

  // ── QR scanner ──────────────────────────────────────────────────────────────

  const openScanner = useCallback(async () => {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        Alert.alert(
          'Camera permission required',
          'Please allow camera access in Settings to scan the QR key.',
        );
        return;
      }
    }
    setScannerOpen(true);
  }, [cameraPermission, requestCameraPermission]);

  const handleQrScanned = useCallback(({ data }: { data: string }) => {
    if (!data) return;
    setScannerOpen(false);
    setQrPayload(data);
  }, []);

  // ── File picker ─────────────────────────────────────────────────────────────

  const pickFile = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });

      if (result.canceled) return;

      const asset = result.assets?.[0];
      if (!asset?.uri) return;

      setFileUri(asset.uri);
    } catch (err: unknown) {
      Alert.alert('File picker error', err instanceof Error ? err.message : 'Unknown error');
    }
  }, []);

  // ── Done handler ─────────────────────────────────────────────────────────────

  const handleDone = useCallback(() => {
    router.replace('/(app)/(tabs)/');
  }, [router]);

  // ── Reset (try again) ───────────────────────────────────────────────────────

  const handleReset = useCallback(() => {
    setQrPayload(null);
    setFileUri(null);
    setSummary(null);
    setErrorMsg(null);
    setPhase('collect');
  }, []);

  // ── Render helpers ──────────────────────────────────────────────────────────

  const qrDone   = !!qrPayload;
  const fileDone = !!fileUri;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Import from Doctor' }} />

      {/* ── QR scanner modal ─────────────────────────────────────────────── */}
      <Modal
        visible={scannerOpen}
        animationType="slide"
        onRequestClose={() => setScannerOpen(false)}
      >
        <SafeAreaView style={styles.scannerSafeArea}>
          <View style={styles.scannerHeader}>
            <Text style={styles.scannerTitle}>Scan QR key</Text>
            <Pressable
              onPress={() => setScannerOpen(false)}
              style={styles.scannerClose}
              accessibilityLabel="Close scanner"
              accessibilityRole="button"
            >
              <Text style={styles.scannerCloseText}>✕ Close</Text>
            </Pressable>
          </View>

          <CameraView
            style={styles.camera}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={handleQrScanned}
          />

          <View style={styles.scannerHint}>
            <Text style={styles.scannerHintText}>
              Point the camera at the QR code shown by the doctor.
            </Text>
          </View>
        </SafeAreaView>
      </Modal>

      {/* ── Main content ──────────────────────────────────────────────────── */}
      {phase === 'processing' ? (
        <Loading fullScreen text="Decrypting and importing your health record…" />
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>

          {/* ── Info banner (always shown unless done) ───────────────────── */}
          {phase !== 'done' && (
            <View style={styles.infoBanner}>
              <Text style={styles.infoBannerIcon}>📥</Text>
              <Text style={styles.infoBannerText}>
                Collect the encrypted file and the QR key from your doctor — in
                any order — then your record will be imported automatically.
              </Text>
            </View>
          )}

          {/* ── Error banner ─────────────────────────────────────────────── */}
          {phase === 'error' && errorMsg && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorBannerIcon}>⚠️</Text>
              <Text style={styles.errorBannerText}>{errorMsg}</Text>
            </View>
          )}

          {/* ── Entry-point cards (collect + error phases) ───────────────── */}
          {(phase === 'collect' || phase === 'error') && (
            <>
              {/* QR card */}
              <Card
                variant={qrDone ? 'filled' : 'outlined'}
                padding="medium"
                onPress={qrDone ? undefined : openScanner}
              >
                <View style={styles.entryCardRow}>
                  <View style={styles.entryCardIcon}>
                    <Text style={styles.entryCardIconText}>
                      {qrDone ? '✅' : '🔑'}
                    </Text>
                  </View>
                  <View style={styles.entryCardBody}>
                    <Text style={styles.entryCardTitle}>
                      {qrDone ? 'QR key scanned' : 'Scan QR key'}
                    </Text>
                    <Text style={styles.entryCardSubtitle}>
                      {qrDone
                        ? 'Decryption key captured.'
                        : 'Ask your doctor to show the QR code, then tap to scan.'}
                    </Text>
                  </View>
                  {!qrDone && (
                    <Text style={styles.entryCardChevron}>›</Text>
                  )}
                </View>
                {!qrDone && (
                  <Button
                    title="Open Camera"
                    variant="outline"
                    size="small"
                    onPress={openScanner}
                    style={styles.entryCardButton}
                    accessibilityLabel="Open camera to scan QR key"
                  />
                )}
              </Card>

              {/* File card */}
              <Card
                variant={fileDone ? 'filled' : 'outlined'}
                padding="medium"
                onPress={fileDone ? undefined : pickFile}
              >
                <View style={styles.entryCardRow}>
                  <View style={styles.entryCardIcon}>
                    <Text style={styles.entryCardIconText}>
                      {fileDone ? '✅' : '📂'}
                    </Text>
                  </View>
                  <View style={styles.entryCardBody}>
                    <Text style={styles.entryCardTitle}>
                      {fileDone ? 'File selected' : 'Pick encrypted file'}
                    </Text>
                    <Text style={styles.entryCardSubtitle}>
                      {fileDone
                        ? 'Encrypted bundle ready.'
                        : 'Tap to pick the .bin file shared by your doctor.'}
                    </Text>
                  </View>
                  {!fileDone && (
                    <Text style={styles.entryCardChevron}>›</Text>
                  )}
                </View>
                {!fileDone && (
                  <Button
                    title="Browse Files"
                    variant="outline"
                    size="small"
                    onPress={pickFile}
                    style={styles.entryCardButton}
                    accessibilityLabel="Browse files to pick encrypted bundle"
                  />
                )}
              </Card>

              {/* Progress indicator */}
              <View style={styles.progressRow}>
                <Text style={styles.progressText}>
                  {qrDone && fileDone
                    ? '⏳ Processing…'
                    : `${[qrDone, fileDone].filter(Boolean).length} / 2 steps complete`}
                </Text>
              </View>

              {/* Reset while in error phase */}
              {phase === 'error' && (
                <Button
                  title="Try again"
                  variant="outline"
                  fullWidth
                  onPress={handleReset}
                  accessibilityLabel="Try again"
                />
              )}
            </>
          )}

          {/* ── Import summary (done phase) ──────────────────────────────── */}
          {phase === 'done' && summary && (
            <>
              <View style={styles.successBanner}>
                <Text style={styles.successBannerIcon}>🎉</Text>
                <Text style={styles.successBannerText}>
                  Your health record has been updated successfully!
                </Text>
              </View>

              <Card variant="elevated" padding="large">
                <Text style={styles.summaryTitle}>Import Summary</Text>

                <View style={styles.summaryGrid}>
                  <SummaryItem
                    icon="🏥"
                    label="Visits"
                    value={summary.encounters}
                  />
                  <SummaryItem
                    icon="🏋️"
                    label="Exercises"
                    value={summary.exercises}
                  />
                  <SummaryItem
                    icon="🩺"
                    label="Conditions"
                    value={summary.conditions}
                  />
                  {summary.messages > 0 && (
                    <SummaryItem
                      icon="💬"
                      label="Messages"
                      value={summary.messages}
                    />
                  )}
                </View>

                {summary.skipped > 0 && (
                  <Text style={styles.skippedNote}>
                    {summary.skipped} unrecognized{' '}
                    {summary.skipped === 1 ? 'entry' : 'entries'} skipped.
                  </Text>
                )}
              </Card>

              <Button
                title="Done"
                variant="primary"
                size="large"
                fullWidth
                onPress={handleDone}
                accessibilityLabel="Done — go to home"
              />
            </>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function SummaryItem({
  icon,
  label,
  value,
}: {
  icon: string;
  label: string;
  value: number;
}) {
  return (
    <View style={summaryItemStyles.container}>
      <Text style={summaryItemStyles.icon}>{icon}</Text>
      <Text style={summaryItemStyles.value}>{value}</Text>
      <Text style={summaryItemStyles.label}>{label}</Text>
    </View>
  );
}

const summaryItemStyles = StyleSheet.create({
  container: {
    alignItems: 'center',
    minWidth: 72,
    gap: spacing.xs,
  },
  icon:  { fontSize: 28 },
  value: {
    ...typography.h2,
    color: colors.primary,
    fontWeight: '700',
  },
  label: {
    ...typography.caption,
    color: colors.text.secondary,
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Typed error classes
// ─────────────────────────────────────────────────────────────────────────────

class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

class BundleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleValidationError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },

  // ── Scroll layout ────────────────────────────────────────────────────────────
  scroll: { flex: 1 },
  content: {
    padding: spacing.md,
    paddingBottom: 40,
    gap: spacing.md,
  },

  // ── Info banner ──────────────────────────────────────────────────────────────
  infoBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.primary + '15',
    borderRadius: borderRadius.md,
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
    padding: spacing.md,
    gap: spacing.sm,
  },
  infoBannerIcon: { fontSize: 20, marginTop: 2 },
  infoBannerText: {
    ...typography.body,
    color: colors.text.primary,
    flex: 1,
    fontWeight: '600',
  },

  // ── Error banner ─────────────────────────────────────────────────────────────
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.danger + '15',
    borderRadius: borderRadius.md,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
    padding: spacing.md,
    gap: spacing.sm,
  },
  errorBannerIcon: { fontSize: 20, marginTop: 2 },
  errorBannerText: {
    ...typography.body,
    color: colors.danger,
    flex: 1,
    fontWeight: '600',
  },

  // ── Success banner ────────────────────────────────────────────────────────────
  successBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.success + '15',
    borderRadius: borderRadius.md,
    borderLeftWidth: 4,
    borderLeftColor: colors.success,
    padding: spacing.md,
    gap: spacing.sm,
  },
  successBannerIcon: { fontSize: 20, marginTop: 2 },
  successBannerText: {
    ...typography.body,
    color: colors.successDark,
    flex: 1,
    fontWeight: '600',
  },

  // ── Entry cards ───────────────────────────────────────────────────────────────
  entryCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  entryCardIcon: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.full,
    backgroundColor: colors.primary + '15',
    alignItems: 'center',
    justifyContent: 'center',
  },
  entryCardIconText: { fontSize: 20 },
  entryCardBody: { flex: 1 },
  entryCardTitle: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '700',
  },
  entryCardSubtitle: {
    ...typography.caption,
    color: colors.text.secondary,
    marginTop: 2,
  },
  entryCardChevron: {
    ...typography.h2,
    color: colors.text.secondary,
    lineHeight: 28,
  },
  entryCardButton: {
    marginTop: spacing.sm,
  },

  // ── Progress row ─────────────────────────────────────────────────────────────
  progressRow: {
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  progressText: {
    ...typography.caption,
    color: colors.text.secondary,
  },

  // ── Import summary ────────────────────────────────────────────────────────────
  summaryTitle: {
    ...typography.h3,
    color: colors.text.primary,
    fontWeight: '700',
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-around',
    gap: spacing.md,
  },
  skippedNote: {
    ...typography.caption,
    color: colors.text.secondary,
    marginTop: spacing.sm,
    textAlign: 'center',
  },

  // ── QR scanner modal ──────────────────────────────────────────────────────────
  scannerSafeArea: {
    flex: 1,
    backgroundColor: '#000',
  },
  scannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: '#000',
  },
  scannerTitle: {
    ...typography.h3,
    color: '#fff',
    fontWeight: '700',
  },
  scannerClose: {
    padding: spacing.sm,
  },
  scannerCloseText: {
    ...typography.body,
    color: colors.primary,
    fontWeight: '600',
  },
  camera: {
    flex: 1,
  },
  scannerHint: {
    padding: spacing.md,
    backgroundColor: '#000',
    alignItems: 'center',
  },
  scannerHintText: {
    ...typography.body,
    color: '#fff',
    textAlign: 'center',
  },
});
