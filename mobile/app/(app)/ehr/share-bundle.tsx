/**
 * Share Bundle Screen
 * Location: mobile/app/(app)/ehr/share-bundle.tsx
 *
 * Patient-facing "Share with doctor" screen.
 *
 * On mount it:
 *   1. Builds a FHIR R4 Bundle from the local SQLite cache.
 *   2. Encrypts it with AES-256-GCM via encryptBundle().
 *   3. Writes the ciphertext to FileSystem.cacheDirectory + "morafek_share.bin".
 *
 * The patient can then:
 *   • Tap "Share encrypted file" to send the .bin file via the OS share sheet.
 *   • Tap "Show QR key" to display the decryption key as a QR code to show
 *     their doctor in person.
 *
 * DSGVO / GDPR: the .bin file is worthless without the QR key, and the QR key
 * is worthless without the .bin file.  Neither alone reveals any PHI.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import QRCode from 'react-native-qrcode-svg';

import { buildLocalFhirBundle } from '@/utils/fhirBundleExport';
import { encryptBundle, bundleToFile } from '@/utils/fhirCrypto';
import { useAuthStore } from '@/store/auth.store';
import { Loading } from '@/components/ui/Loading';
import { colors, spacing, typography, borderRadius, shadows } from '@/constants/theme';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BUNDLE_FILENAME = 'morafek_share.bin';

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function ShareBundleScreen() {
  const user = useAuthStore((s) => s.user);

  const [fileUri,    setFileUri]    = useState<string | null>(null);
  const [qrPayload,  setQrPayload]  = useState<string | null>(null);
  const [showQr,     setShowQr]     = useState(false);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);

  // ── Build + encrypt bundle on mount ────────────────────────────────────────

  const buildAndEncrypt = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setShowQr(false);

      if (!user) {
        throw new Error('No authenticated user found.');
      }

      // Map auth store User → UserParam required by buildLocalFhirBundle
      const userParam = {
        id:            user._id ?? '',
        first_name:    user.firstName ?? '',
        last_name:     user.lastName  ?? '',
        // date_of_birth is not stored in the JWT / auth store; omitted here.
        // buildLocalFhirBundle() accepts an empty string and simply omits the
        // FHIR Patient.birthDate field rather than failing, so the bundle is
        // still valid — it just lacks a birth date.  If this field becomes
        // available in the auth store in the future, wire it in here.
        date_of_birth: '',
        user_type:     user.user_type ?? 'patient',
      };

      const bundleJson = await buildLocalFhirBundle(userParam);
      const { cipherBytes, qrPayload: qr } = await encryptBundle(bundleJson);
      const uri = await bundleToFile(cipherBytes, BUNDLE_FILENAME);

      setFileUri(uri);
      setQrPayload(qr);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to prepare bundle.');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { buildAndEncrypt(); }, [buildAndEncrypt]);

  // ── Share handler ───────────────────────────────────────────────────────────

  const handleShare = useCallback(async () => {
    if (!fileUri) return;
    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        Alert.alert('Sharing not available', 'Your device does not support file sharing.');
        return;
      }
      await Sharing.shareAsync(fileUri, {
        mimeType:    'application/octet-stream',
        dialogTitle: 'Share encrypted health record',
        UTI:         'public.data',
      });
    } catch (err: unknown) {
      Alert.alert('Share failed', err instanceof Error ? err.message : 'Unknown error');
    }
  }, [fileUri]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Share with Doctor' }} />

      {loading ? (
        <Loading
          fullScreen
          text="Preparing your encrypted health record…"
        />
      ) : error ? (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>⚠️ {error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={buildAndEncrypt}>
            <Text style={styles.retryButtonText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
        >
          {/* ── Info banner ──────────────────────────────────────────────── */}
          <View style={styles.infoBanner}>
            <Text style={styles.infoBannerIcon}>🔒</Text>
            <Text style={styles.infoBannerText}>
              The file is encrypted. The QR code is the only key. Share the file
              freely — only show the QR to your doctor in person.
            </Text>
          </View>

          {/* ── Header card ──────────────────────────────────────────────── */}
          <View style={styles.headerCard}>
            <Text style={styles.headerTitle}>📤 Your health record is ready</Text>
            <Text style={styles.headerSubtitle}>
              An encrypted copy of your FHIR health bundle has been created. Use
              the actions below to share it with your doctor.
            </Text>
          </View>

          {/* ── Action buttons ────────────────────────────────────────────── */}
          <TouchableOpacity
            style={[styles.actionButton, styles.actionButtonPrimary]}
            onPress={handleShare}
            accessibilityRole="button"
            accessibilityLabel="Share encrypted file"
          >
            <Text style={styles.actionButtonPrimaryText}>📎 Share encrypted file</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionButton, styles.actionButtonSecondary]}
            onPress={() => setShowQr((prev) => !prev)}
            accessibilityRole="button"
            accessibilityLabel={showQr ? 'Hide QR key' : 'Show QR key'}
          >
            <Text style={styles.actionButtonSecondaryText}>
              {showQr ? '🔽 Hide QR key' : '🔑 Show QR key'}
            </Text>
          </TouchableOpacity>

          {/* ── QR code ─────────────────────────────────────────────────── */}
          {showQr && qrPayload ? (
            <View style={styles.qrContainer}>
              <Text style={styles.qrLabel}>Show this QR code to your doctor</Text>
              <View style={styles.qrWrapper}>
                <QRCode
                  value={qrPayload}
                  size={240}
                  color={colors.text.primary}
                  backgroundColor={colors.surface}
                />
              </View>
              <Text style={styles.qrCaption}>
                🔐 This QR code is the decryption key. Never share it digitally.
              </Text>
            </View>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },

  // ── Error state ─────────────────────────────────────────────────────────────
  errorContainer: {
    flex: 1,
    padding: spacing.lg,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.md,
  },
  errorText: {
    ...typography.body,
    color: colors.danger,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  retryButtonText: {
    ...typography.button,
    color: colors.text.inverse,
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
  infoBannerIcon: {
    fontSize: 20,
    marginTop: 2,
  },
  infoBannerText: {
    ...typography.body,
    color: colors.text.primary,
    flex: 1,
    fontWeight: '600',
  },

  // ── Header card ──────────────────────────────────────────────────────────────
  headerCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.sm,
  },
  headerTitle: {
    ...typography.h3,
    color: colors.text.primary,
    fontWeight: '700',
  },
  headerSubtitle: {
    ...typography.body,
    color: colors.text.secondary,
  },

  // ── Action buttons ───────────────────────────────────────────────────────────
  actionButton: {
    borderRadius: borderRadius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.sm,
  },
  actionButtonPrimary: {
    backgroundColor: colors.primary,
  },
  actionButtonPrimaryText: {
    ...typography.button,
    color: colors.text.inverse,
  },
  actionButtonSecondary: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.primary,
  },
  actionButtonSecondaryText: {
    ...typography.button,
    color: colors.primary,
  },

  // ── QR code panel ────────────────────────────────────────────────────────────
  qrContainer: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.md,
    ...shadows.md,
  },
  qrLabel: {
    ...typography.h3,
    color: colors.text.primary,
    textAlign: 'center',
    fontWeight: '700',
  },
  qrWrapper: {
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  qrCaption: {
    ...typography.caption,
    color: colors.text.secondary,
    textAlign: 'center',
    paddingHorizontal: spacing.sm,
  },
});
