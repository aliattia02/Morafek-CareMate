/**
 * Consent Screen
 * Location: mobile/app/(app)/ehr/consent.tsx
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  getConsentStatus,
  grantConsent,
  revokeConsent,
  type ConsentStatus,
} from '@/services/api/consent';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

export default function ConsentScreen() {
  const [status, setStatus] = useState<ConsentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setError(null);
      const data = await getConsentStatus();
      setStatus(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load consent status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleGrant = async () => {
    try {
      setWorking(true);
      setError(null);
      setMessage(null);
      const result = await grantConsent();
      if (result.pseudonym_assigned) {
        setMessage('A pseudonym has been assigned to your data.');
      } else {
        setMessage('Consent recorded — pseudonym will be assigned shortly.');
      }
      const refreshed = await getConsentStatus();
      setStatus(refreshed);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to grant consent');
    } finally {
      setWorking(false);
    }
  };

  const handleRevoke = async () => {
    try {
      setWorking(true);
      setError(null);
      setMessage(null);
      await revokeConsent();
      setMessage('Consent revoked.');
      const refreshed = await getConsentStatus();
      setStatus(refreshed);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to revoke consent');
    } finally {
      setWorking(false);
    }
  };

  const currentStatus = status?.status ?? 'none';
  const isGranted = currentStatus === 'granted';

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Data Sharing' }} />

      {loading ? (
        <ActivityIndicator color={colors.primary} size="large" style={styles.loader} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {error && (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>⚠️ {error}</Text>
            </View>
          )}
          {message && (
            <View style={styles.messageCard}>
              <Text style={styles.messageText}>{message}</Text>
            </View>
          )}

          <View style={styles.card}>
            <View style={[styles.badge, isGranted ? styles.badgeSuccess : styles.badgeInactive]}>
              <Text style={[styles.badgeText, isGranted ? styles.badgeTextSuccess : styles.badgeTextInactive]}>
                {isGranted ? 'Data sharing active' : 'Data sharing inactive'}
              </Text>
            </View>

            {isGranted ? (
              <View style={styles.details}>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Pseudonym</Text>
                  <Text style={styles.rowValue}>{status?.pseudonym_masked ?? '—'}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>Granted on</Text>
                  <Text style={styles.rowValue}>{formatDate(status?.granted_at)}</Text>
                </View>
              </View>
            ) : null}

            {isGranted ? (
              <TouchableOpacity
                style={[styles.button, styles.revokeButton, working && styles.buttonDisabled]}
                onPress={handleRevoke}
                disabled={working}
              >
                {working ? (
                  <ActivityIndicator color={colors.text.inverse} />
                ) : (
                  <Text style={styles.buttonText}>Revoke consent</Text>
                )}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.button, styles.grantButton, working && styles.buttonDisabled]}
                onPress={handleGrant}
                disabled={working}
              >
                {working ? (
                  <ActivityIndicator color={colors.text.inverse} />
                ) : (
                  <Text style={styles.buttonText}>Allow pseudonymised data sharing</Text>
                )}
              </TouchableOpacity>
            )}
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loader: {
    flex: 1,
    marginTop: 40,
  },
  content: {
    padding: spacing.md,
    gap: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.md,
  },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  badgeSuccess: {
    backgroundColor: colors.success + '22',
  },
  badgeInactive: {
    backgroundColor: colors.divider,
  },
  badgeText: {
    ...typography.body,
    fontWeight: '600',
  },
  badgeTextSuccess: {
    color: colors.successDark,
  },
  badgeTextInactive: {
    color: colors.text.secondary,
  },
  details: {
    gap: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  rowLabel: {
    ...typography.caption,
    color: colors.text.secondary,
    width: 96,
  },
  rowValue: {
    ...typography.body,
    color: colors.text.primary,
    flex: 1,
  },
  button: {
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  grantButton: {
    backgroundColor: colors.success,
  },
  revokeButton: {
    backgroundColor: colors.danger,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    ...typography.button,
    color: colors.text.inverse,
  },
  errorCard: {
    backgroundColor: colors.dangerLight,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
  },
  errorText: {
    ...typography.body,
    color: colors.danger,
  },
  messageCard: {
    backgroundColor: colors.success + '1A',
    borderRadius: borderRadius.md,
    padding: spacing.md,
    borderLeftWidth: 4,
    borderLeftColor: colors.success,
  },
  messageText: {
    ...typography.body,
    color: colors.successDark,
  },
});
