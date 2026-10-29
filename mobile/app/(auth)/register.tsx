/**
 * Registration Screen
 * Location: mobile/app/(auth)/register.tsx
 *
 * Main Function: RegisterScreen
 * Description: User registration screen with form validation and user type selection
 *
 * Features:
 * - User type selection (patient vs doctor)
 * - Multi-field registration form (username, email, password, names, DOB)
 * - Comprehensive form validation
 * - Password confirmation matching
 * - Show/hide password toggle
 * - Real-time validation error display
 * - Loading state during registration
 * - Keyboard handling for smooth UX
 * - Success alert with redirect to login
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

// Components
import { Button, Input, Card } from '@/components/ui';

// Hooks
import { useAuth } from '@/hooks/useAuth';

// Utils
import {
  validateEmail,
  validatePassword,
  validateUsername,
  validateDateOfBirth,
  validateRequired
} from '@/utils/validation';

// Constants
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// Types
type UserType = 'patient' | 'doctor' | 'researcher' | 'admin';

// Placeholder — swap for the real Terms & Conditions URL once published.
const TERMS_URL = 'https://example.com/morafek-terms-and-conditions';

export default function RegisterScreen() {
  const router = useRouter();
  const { register, login, isLoading } = useAuth();

  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    firstName: '',
    lastName: '',
    dateOfBirth: '',
  });
  const [userType, setUserType] = useState<UserType>('patient');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showPassword, setShowPassword] = useState(false);
  const [registerError, setRegisterError] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  const updateField = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: '' }));
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    // Username
    const usernameResult = validateUsername(formData.username);
    if (!usernameResult.isValid) newErrors.username = usernameResult.errors[0] || '';

    // Email
    const emailResult = validateEmail(formData.email);
    if (!emailResult.isValid) newErrors.email = emailResult.errors[0] || '';

    // Password
    const passwordResult = validatePassword(formData.password);
    if (!passwordResult.isValid) newErrors.password = passwordResult.errors[0] || '';

    // Confirm password
    if (formData.password !== formData.confirmPassword) {
      newErrors.confirmPassword = 'Passwords do not match';
    }

    // First name
    const firstNameResult = validateRequired(formData.firstName, 'First name');
    if (!firstNameResult.isValid) newErrors.firstName = firstNameResult.errors[0] || '';

    // Last name
    const lastNameResult = validateRequired(formData.lastName, 'Last name');
    if (!lastNameResult.isValid) newErrors.lastName = lastNameResult.errors[0] || '';

    // Date of birth
    const dobResult = validateDateOfBirth(formData.dateOfBirth);
    if (!dobResult.isValid) newErrors.dateOfBirth = dobResult.errors[0] || '';

    // Terms & conditions
    if (!acceptedTerms) {
      newErrors.terms = 'You must accept the Terms & Conditions to continue';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleRegister = async () => {
    if (!validateForm()) return;
    setRegisterError('');

    try {
      await register({
        username: formData.username.trim(),
        email: formData.email.trim().toLowerCase(),
        password: formData.password,
        firstName: formData.firstName.trim(),
        lastName: formData.lastName.trim(),
        dateOfBirth: formData.dateOfBirth,
        user_type: userType,
      });

      if (userType === 'patient') {
        // Sign the new patient straight in and send them to the research
        // consent screen so they can review mobile-data / research consent
        // right after registering, instead of a separate later visit.
        try {
          await login({
            username: formData.username.trim(),
            password: formData.password,
            user_type: userType,
          });
          router.replace('/(app)/ehr/consent');
          return;
        } catch {
          // Auto-login failed (e.g. cold-start hiccup) — fall through to
          // the normal "go log in" path below rather than stranding the
          // user on a broken screen.
        }
      }

      // Alert.alert doesn't work on Expo web — navigate directly
      router.replace('/(auth)/login');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Registration failed';
      setRegisterError(message);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Card variant="elevated" padding="large" style={styles.card}>
            <Text style={styles.title}>Create Account</Text>
            <Text style={styles.description}>Create your Morafek account</Text>

            {/* User Type Selection */}
            <View style={styles.userTypeSection}>
              <Text style={styles.label}>I am a</Text>
              <View style={styles.userTypeButtons}>
                {([
                  { type: 'patient' as UserType, label: 'Patient' },
                  { type: 'doctor' as UserType, label: 'Doctor' },
                  { type: 'researcher' as UserType, label: 'Researcher' },
                  { type: 'admin' as UserType, label: 'Admin' },
                ]).map(({ type, label }) => (
                  <TouchableOpacity
                    key={type}
                    style={[
                      styles.userTypeButton,
                      userType === type && styles.userTypeButtonActive,
                    ]}
                    onPress={() => setUserType(type)}
                  >
                    <Text
                      style={[
                        styles.userTypeText,
                        userType === type && styles.userTypeTextActive,
                      ]}
                    >
                      {label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.row}>
              <View style={styles.halfInput}>
                <Input
                  label="First Name"
                  value={formData.firstName}
                  onChangeText={(v) => updateField('firstName', v)}
                  placeholder="John"
                  autoCapitalize="words"
                  error={errors.firstName}
                  required
                />
              </View>
              <View style={styles.halfInput}>
                <Input
                  label="Last Name"
                  value={formData.lastName}
                  onChangeText={(v) => updateField('lastName', v)}
                  placeholder="Doe"
                  autoCapitalize="words"
                  error={errors.lastName}
                  required
                />
              </View>
            </View>

            <Input
              label="Username"
              value={formData.username}
              onChangeText={(v) => updateField('username', v)}
              placeholder="johndoe"
              autoCapitalize="none"
              autoCorrect={false}
              error={errors.username}
              required
            />

            <Input
              label="Email"
              value={formData.email}
              onChangeText={(v) => updateField('email', v)}
              placeholder="john@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              error={errors.email}
              required
            />

            <Input
              label="Date of Birth"
              value={formData.dateOfBirth}
              onChangeText={(v) => updateField('dateOfBirth', v)}
              placeholder="YYYY-MM-DD"
              error={errors.dateOfBirth}
              helperText="Format: YYYY-MM-DD"
              required
            />

            <Input
              label="Password"
              value={formData.password}
              onChangeText={(v) => updateField('password', v)}
              placeholder="Create a password"
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              error={errors.password}
              helperText="At least 8 characters with letters and numbers"
              required
              rightIcon={
                <Text style={styles.showPasswordText}>
                  {showPassword ? 'Hide' : 'Show'}
                </Text>
              }
              onRightIconPress={() => setShowPassword(!showPassword)}
            />

            <Input
              label="Confirm Password"
              value={formData.confirmPassword}
              onChangeText={(v) => updateField('confirmPassword', v)}
              placeholder="Confirm your password"
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              error={errors.confirmPassword}
              required
            />

            {/* Terms & Conditions */}
            <TouchableOpacity
              style={styles.termsRow}
              onPress={() => {
                setAcceptedTerms((prev) => !prev);
                setErrors((prev) => ({ ...prev, terms: '' }));
              }}
              activeOpacity={0.75}
            >
              <View style={[styles.checkbox, acceptedTerms && styles.checkboxChecked]}>
                {acceptedTerms ? <Text style={styles.checkboxTick}>✓</Text> : null}
              </View>
              <Text style={styles.termsText}>
                I agree to the{' '}
                <Text
                  style={styles.termsLink}
                  onPress={() => Linking.openURL(TERMS_URL)}
                >
                  Terms &amp; Conditions
                </Text>
              </Text>
            </TouchableOpacity>
            {errors.terms ? (
              <Text style={styles.termsError}>{errors.terms}</Text>
            ) : null}

            {registerError ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorBannerText}>{registerError}</Text>
              </View>
            ) : null}

            <Button
              title="Create Account"
              onPress={handleRegister}
              loading={isLoading}
              fullWidth
              style={styles.registerButton}
            />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  keyboardView: {
    flex: 1,
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
  },
  userTypeSection: {
    marginBottom: spacing.md,
  },
  label: {
    ...typography.caption,
    color: colors.text.primary,
    fontWeight: '500',
    marginBottom: spacing.xs,
  },
  userTypeButtons: {
    flexDirection: 'row',
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  userTypeButton: {
    flex: 1,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    backgroundColor: colors.surface,
  },
  userTypeButtonActive: {
    backgroundColor: colors.primary,
  },
  userTypeText: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '500',
  },
  userTypeTextActive: {
    color: colors.text.inverse,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  halfInput: {
    flex: 1,
  },
  showPasswordText: {
    ...typography.caption,
    color: colors.primary,
    fontWeight: '600',
  },
  registerButton: {
    marginTop: spacing.md,
  },
  termsRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: borderRadius.sm,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkboxChecked: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  checkboxTick: {
    color: colors.text.inverse,
    fontSize: 14,
    fontWeight: '700',
  },
  termsText: {
    ...typography.caption,
    color: colors.text.secondary,
    flex: 1,
  },
  termsLink: {
    color: colors.primary,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  termsError: {
    ...typography.caption,
    color: colors.danger,
    marginTop: spacing.xs,
  },
  errorBanner: {
    backgroundColor: colors.danger + '15',
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  errorBannerText: {
    ...typography.caption,
    color: colors.danger,
    textAlign: 'center',
  },
});