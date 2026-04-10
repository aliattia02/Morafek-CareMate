/**
 * Forgot Password Screen
 * Location: mobile/app/(auth)/forgot-password.tsx
 *
 * Main Function: ForgotPasswordScreen
 * Description: Real 2-step password-reset flow.
 *   Step 1 — Enter email → POST /api/auth/forgot-password
 *   Step 2 — Enter 6-digit code + new password → POST /api/auth/reset-password
 *
 * Follows the same Card + Input + Button pattern as login.tsx.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

// Components
import { Button, Input, Card } from '@/components/ui';

// Services
import apiClient from '@/services/api/client';
import { API } from '@/services/api/endpoints';

// Utils
import { validateEmail } from '@/utils/validation';

// Constants
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// ─── Cross-platform alert helper ─────────────────────────────────────────────

const showAlert = (title: string, message: string, onOk?: () => void) => {
  if (Platform.OS === 'web') {
    window.alert(`${title}\n\n${message}`);
    onOk?.();
  } else {
    Alert.alert(title, message, [{ text: 'OK', onPress: onOk }]);
  }
};

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function ForgotPasswordScreen() {
  const router = useRouter();

  // Step 1 state
  const [email, setEmail]         = useState('');
  const [emailError, setEmailError] = useState('');

  // Step 2 state
  const [code, setCode]               = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPwd, setConfirmPwd]   = useState('');
  const [showPwd, setShowPwd]         = useState(false);
  const [step2Errors, setStep2Errors] = useState<Record<string, string>>({});

  // Shared state
  const [step, setStep]           = useState<1 | 2>(1);
  const [isLoading, setIsLoading] = useState(false);
  const [globalError, setGlobalError] = useState('');

  // ── Step 1: send reset code ───────────────────────────────────────────────

  const handleSendCode = async () => {
    setGlobalError('');
    const validation = validateEmail(email);
    if (!validation.isValid) {
      setEmailError(validation.errors[0] || 'Invalid email');
      return;
    }
    setEmailError('');
    setIsLoading(true);
    try {
      await apiClient.post(API.AUTH.FORGOT_PASSWORD, { email: email.trim().toLowerCase() });
      setStep(2);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Request failed. Please try again.';
      setGlobalError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  // ── Step 2: verify code + set new password ────────────────────────────────

  const handleResetPassword = async () => {
    setGlobalError('');
    const errors: Record<string, string> = {};

    if (!code.trim() || code.trim().length !== 6) {
      errors.code = 'Please enter the 6-digit code';
    }
    if (!newPassword) {
      errors.newPassword = 'New password is required';
    } else if (newPassword.length < 8) {
      errors.newPassword = 'Password must be at least 8 characters';
    }
    if (newPassword !== confirmPwd) {
      errors.confirmPwd = 'Passwords do not match';
    }

    setStep2Errors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsLoading(true);
    try {
      await apiClient.post(API.AUTH.RESET_PASSWORD, {
        email:        email.trim().toLowerCase(),
        code:         code.trim(),
        new_password: newPassword,
      });
      showAlert('Password Updated', 'Your password has been reset successfully.', () => {
        router.replace('/(auth)/login');
      });
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Reset failed. Please try again.';
      setGlobalError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <Card variant="elevated" padding="large" style={styles.card}>

          {step === 1 ? (
            <>
              <Text style={styles.title}>Reset Password</Text>
              <Text style={styles.description}>
                Enter your account email and we will send you a 6-digit reset code.
              </Text>

              <Input
                label="Email Address"
                value={email}
                onChangeText={(text) => { setEmail(text); setEmailError(''); setGlobalError(''); }}
                placeholder="Enter your email"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                error={emailError}
                editable={!isLoading}
              />

              {globalError ? (
                <View style={styles.errorBox}>
                  <Text style={styles.errorBoxText}>{globalError}</Text>
                </View>
              ) : null}

              <Button
                title="Send Reset Code"
                onPress={handleSendCode}
                loading={isLoading}
                fullWidth
                style={styles.primaryButton}
              />

              <TouchableOpacity
                style={styles.backLink}
                onPress={() => router.back()}
                disabled={isLoading}
              >
                <Text style={styles.backLinkText}>← Back to Sign In</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.title}>Enter Reset Code</Text>
              <Text style={styles.description}>
                A 6-digit code has been sent to <Text style={styles.emailHighlight}>{email}</Text>.
                Enter it below along with your new password.
              </Text>

              <Input
                label="6-Digit Code"
                value={code}
                onChangeText={(text) => { setCode(text); setStep2Errors((p) => ({ ...p, code: '' })); setGlobalError(''); }}
                placeholder="123456"
                keyboardType="number-pad"
                maxLength={6}
                error={step2Errors.code}
                editable={!isLoading}
              />

              <Input
                label="New Password"
                value={newPassword}
                onChangeText={(text) => { setNewPassword(text); setStep2Errors((p) => ({ ...p, newPassword: '' })); }}
                placeholder="At least 8 characters"
                secureTextEntry={!showPwd}
                autoCapitalize="none"
                error={step2Errors.newPassword}
                editable={!isLoading}
                rightIcon={<Text style={styles.showPasswordText}>{showPwd ? 'Hide' : 'Show'}</Text>}
                onRightIconPress={() => setShowPwd((p) => !p)}
              />

              <Input
                label="Confirm New Password"
                value={confirmPwd}
                onChangeText={(text) => { setConfirmPwd(text); setStep2Errors((p) => ({ ...p, confirmPwd: '' })); }}
                placeholder="Re-enter your new password"
                secureTextEntry={!showPwd}
                autoCapitalize="none"
                error={step2Errors.confirmPwd}
                editable={!isLoading}
              />

              {globalError ? (
                <View style={styles.errorBox}>
                  <Text style={styles.errorBoxText}>{globalError}</Text>
                </View>
              ) : null}

              <Button
                title="Reset Password"
                onPress={handleResetPassword}
                loading={isLoading}
                fullWidth
                style={styles.primaryButton}
              />

              <TouchableOpacity
                style={styles.backLink}
                onPress={() => { setStep(1); setGlobalError(''); setStep2Errors({}); setCode(''); setNewPassword(''); setConfirmPwd(''); }}
                disabled={isLoading}
              >
                <Text style={styles.backLinkText}>← Back</Text>
              </TouchableOpacity>
            </>
          )}

        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    flexGrow: 1,
    padding: spacing.lg,
  },
  card: {
    marginBottom: spacing.lg,
  },
  title: {
    ...typography.h2,
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  description: {
    ...typography.body,
    color: colors.text.secondary,
    marginBottom: spacing.lg,
    lineHeight: 22,
  },
  emailHighlight: {
    color: colors.primary,
    fontWeight: '600',
  },
  primaryButton: {
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  backLink: {
    alignItems: 'center',
    marginTop: spacing.md,
  },
  backLinkText: {
    ...typography.body,
    color: colors.primary,
    fontWeight: '500',
  },
  showPasswordText: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: '600',
  },
  errorBox: {
    backgroundColor: colors.danger + '10',
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  errorBoxText: {
    ...typography.caption,
    color: colors.danger,
    textAlign: 'center',
  },
});