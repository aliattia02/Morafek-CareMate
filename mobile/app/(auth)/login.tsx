/**
 * Login Screen — Redesigned
 * Location: mobile/app/(auth)/login.tsx
 */

import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Link, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, Input, Card } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { E, ET } from '@/constants/elderlyTheme';

// ─── Types ────────────────────────────────────────────────────────────────────

type UserType = 'patient' | 'doctor';

// ─── Wake-up progress banner ──────────────────────────────────────────────────

function WakeUpBanner({ message, percent }: { message: string; percent: number }) {
  return (
    <View style={wakeStyles.container}>
      <Text style={wakeStyles.message}>{message}</Text>
      <View style={wakeStyles.track}>
        <View style={[wakeStyles.fill, { width: `${percent}%` as any }]} />
      </View>
    </View>
  );
}

const wakeStyles = StyleSheet.create({
  container: {
    backgroundColor: E.colors.primaryLight,
    borderRadius: E.radiusSm,
    padding: E.padSm,
    marginBottom: E.padSm,
  },
  message: {
    ...ET.caption,
    color: E.colors.primary,
    fontWeight: '600',
    marginBottom: 6,
    textAlign: 'center',
  },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: E.colors.border,
    overflow: 'hidden',
  },
  fill: {
    height: '100%' as any,
    borderRadius: 3,
    backgroundColor: E.colors.primary,
  },
});

// ─── Trust item ───────────────────────────────────────────────────────────────

function TrustItem({ color, label }: { color: string; label: string }) {
  return (
    <View style={trustStyles.item}>
      <View style={[trustStyles.dot, { backgroundColor: color }]} />
      <Text style={trustStyles.label}>{label}</Text>
    </View>
  );
}

const trustStyles = StyleSheet.create({
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {
    fontSize: 11,
    color: E.colors.textMuted,
    fontWeight: '500',
  },
});

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function LoginScreen() {
  const router = useRouter();
  const { login, isLoading, isWakingUp, wakeProgress, error, clearError } = useAuth();

  const [username,          setUsername]         = useState('');
  const [password,          setPassword]         = useState('');
  const [userType,          setUserType]         = useState<UserType>('patient');
  const [showPassword,      setShowPassword]     = useState(false);
  const [validationErrors,  setValidationErrors] = useState<Record<string, string>>({});
  const passwordRef = useRef<any>(null);

  const busy = isLoading || isWakingUp;

  const validateForm = () => {
    const errors: Record<string, string> = {};
    if (!username.trim()) errors.username = 'Username is required';
    if (!password)        errors.password = 'Password is required';
    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleLogin = async () => {
    if (!validateForm()) return;
    clearError();
    try {
      await login({ username: username.trim(), password, user_type: userType });
    } catch (err: any) {
      const isNetworkIssue =
        err?.code === 'ERR_NETWORK' ||
        err?.message?.includes('Network Error') ||
        err?.message?.includes('did not respond');

      Alert.alert(
        isNetworkIssue ? 'Server Starting Up' : 'Login Failed',
        isNetworkIssue
          ? 'The server is waking up. Please wait a moment and try again.'
          : error || err?.message || 'Please check your credentials and try again.',
      );
    }
  };

  const welcomeLine = userType === 'doctor' ? ' Welcome, Doctor'              : ' Welcome back';
  const welcomeSub  = userType === 'doctor' ? ' Sign in to your doctor account' : ' Sign in to your patient account';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* ── HERO SECTION ─────────────────────────────────────────────── */}
          <View style={styles.hero}>
            {/* Pulse line decoration */}
            <View style={styles.pulseDecoration} pointerEvents="none">
              <View style={styles.pulseLine} />
            </View>

            {/* Secure badge */}
            <View style={styles.secureBadge}>
              <View style={styles.secureBadgeDot} />
              <Text style={styles.secureBadgeText}>Secure Health Platform</Text>
            </View>

            {/* Logo */}
            <View style={styles.logoRow}>
              <View style={styles.logoIcon}>
                <Text style={styles.logoIconText}>+</Text>
              </View>
              <Text style={styles.logoText}>Morafek</Text>
            </View>
            <Text style={styles.heroSub}>Your personal health companion</Text>

            {/* Role chips — Patient / Doctor */}
            <View style={styles.roleChips}>
              {(['patient', 'doctor'] as UserType[]).map((type) => (
                <TouchableOpacity
                  key={type}
                  style={[styles.roleChip, userType === type && styles.roleChipActive]}
                  onPress={() => setUserType(type)}
                  disabled={busy}
                  activeOpacity={0.8}
                >
                  <Text style={styles.roleChipIcon}>
                    {type === 'patient' ? '🧑' : '👨‍⚕️'}
                  </Text>
                  <Text style={[
                    styles.roleChipLabel,
                    userType === type ? styles.roleChipLabelActive : styles.roleChipLabelInactive,
                  ]}>
                    {type === 'patient' ? 'Patient' : 'Doctor'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Wave bottom edge */}
            <View style={styles.heroWave} />
          </View>

          {/* ── FORM SECTION ─────────────────────────────────────────────── */}
          <View style={styles.formBody}>
            <Text style={styles.welcomeLine}>{welcomeLine}</Text>
            <Text style={styles.welcomeSub}>{welcomeSub}</Text>

            {/* ── Username ── */}
            <View style={styles.fieldWrapper}>
              <Text style={styles.fieldLabel}>UserName</Text>
              <View style={[styles.inputBox, validationErrors.username ? styles.inputBoxError : null]}>
                <input
                  style={webInputStyle}
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    setValidationErrors((p) => ({ ...p, username: '' }));
                  }}
                  placeholder="Enter your username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  disabled={busy}
                  onKeyDown={(e) => e.key === 'Enter' && passwordRef.current?.focus()}
                />
              </View>
              {validationErrors.username ? (
                <Text style={styles.fieldError}>{validationErrors.username}</Text>
              ) : null}
            </View>

            {/* ── Password ── */}
            <View style={styles.fieldWrapper}>
              <Text style={styles.fieldLabel}>Password</Text>
              <View style={[styles.inputBox, validationErrors.password ? styles.inputBoxError : null, styles.inputBoxRow]}>
                <input
                  ref={passwordRef}
                  style={{ ...webInputStyle, flex: 1 }}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setValidationErrors((p) => ({ ...p, password: '' }));
                  }}
                  placeholder="Enter your password"
                  type={showPassword ? 'text' : 'password'}
                  disabled={busy}
                  onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                />
                <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={styles.showBtn}>
                  <Text style={styles.showPasswordText}>{showPassword ? 'Hide' : 'Show'}</Text>
                </TouchableOpacity>
              </View>
              {validationErrors.password ? (
                <Text style={styles.fieldError}>{validationErrors.password}</Text>
              ) : null}
            </View>

            {/* Forgot password */}
            <View style={styles.forgotRow}>
              <Link href="/(auth)/forgot-password" asChild>
                <TouchableOpacity disabled={busy}>
                  <Text style={styles.forgotText}>Forgot password?</Text>
                </TouchableOpacity>
              </Link>
            </View>

            {/* ── Test Credentials ── */}
            <TouchableOpacity
              style={testCredStyles.box}
              onPress={() => {
                setUsername(userType === 'doctor' ? 'testd1' : 'test1');
                setPassword('4444');
                setValidationErrors({});
              }}
              activeOpacity={0.75}
              disabled={busy}
            >
              <View style={testCredStyles.row}>
                <Text style={testCredStyles.title}>
                  🧪 Demo {userType === 'doctor' ? 'Doctor' : 'Patient'} Account
                </Text>
                <View style={testCredStyles.fillBadge}>
                  <Text style={testCredStyles.fillBadgeText}>Tap to fill</Text>
                </View>
              </View>
              <Text style={testCredStyles.cred}>
                Username: <Text style={testCredStyles.credVal}>{userType === 'doctor' ? 'testd1' : 'test1'}</Text>
                {'   '}Password: <Text style={testCredStyles.credVal}>4444</Text>
              </Text>
            </TouchableOpacity>

            {/* Wake-up banner */}
            {isWakingUp && (
              <WakeUpBanner message={wakeProgress.message} percent={wakeProgress.percent} />
            )}

            {/* Auth error */}
            {error && !isWakingUp && (
              <View style={styles.errorBox}>
                <Text style={styles.errorBoxText}>{error}</Text>
              </View>
            )}

            {/* Sign In button */}
            <TouchableOpacity
              style={[styles.signInBtn, busy && styles.signInBtnDisabled]}
              onPress={handleLogin}
              disabled={busy}
              activeOpacity={0.85}
            >
              {isWakingUp ? (
                <Text style={styles.signInBtnText}>Starting server…</Text>
              ) : (
                <>
                  <Text style={styles.signInBtnText}>Sign In</Text>
                  <Text style={styles.signInArrow}>→</Text>
                </>
              )}
            </TouchableOpacity>

            {/* Divider + Register */}
            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>New to Morafek?</Text>
              <View style={styles.dividerLine} />
            </View>

            <View style={styles.registerRow}>
              <Text style={styles.registerText}>Don't have an account? </Text>
              <Link href="/(auth)/register" asChild>
                <TouchableOpacity disabled={busy}>
                  <Text style={styles.registerLink}>Create account →</Text>
                </TouchableOpacity>
              </Link>
            </View>
          </View>

          {/* ── TRUST BAR ────────────────────────────────────────────────── */}
          <View style={styles.trustBar}>
            <TrustItem color={E.colors.success} label="DSGVO compliant" />
            <TrustItem color={E.colors.primary}  label="End-to-end encrypted" />
            <TrustItem color={E.colors.accent}   label="FHIR R4" />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Test credentials box ─────────────────────────────────────────────────────

const testCredStyles = StyleSheet.create({
  box: {
    backgroundColor: '#FFF8E1',
    borderWidth: 1,
    borderColor: '#FFD54F',
    borderRadius: E.radiusSm,
    padding: 12,
    marginBottom: E.padSm,
    borderStyle: 'dashed',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  title: {
    fontSize: 12,
    fontWeight: '700',
    color: '#5D4037',
  },
  fillBadge: {
    backgroundColor: '#FFD54F',
    borderRadius: 99,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  fillBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#4E342E',
  },
  cred: {
    fontSize: 12,
    color: '#6D4C41',
  },
  credVal: {
    fontWeight: '700',
    color: '#3E2723',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});

// ─── Web-native input style (plain JS object, not StyleSheet) ─────────────────
// Using a raw <input> guarantees full-width on web regardless of how the
// custom Input wrapper component handles its internal layout.
const webInputStyle: React.CSSProperties = {
  width: '100%',
  height: 52,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  fontSize: 16,
  color: '#1a1a1a',
  fontFamily: 'inherit',
  padding: '0 12px',
  boxSizing: 'border-box',
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:         { flex: 1, backgroundColor: E.colors.primary },
  keyboardView: { flex: 1 },
  scroll:       { flexGrow: 1 },

  // ── Hero
  hero: {
    backgroundColor: E.colors.primary,
    paddingTop: E.pad,
    paddingHorizontal: 24,
    paddingBottom: 0,
    position: 'relative',
    overflow: 'hidden',
  },
  pulseDecoration: {
    position: 'absolute',
    right: 0,
    top: 20,
    opacity: 0.1,
    width: 160,
    height: 50,
  },
  pulseLine: {
    width: '100%',
    height: 2,
    backgroundColor: '#fff',
    marginTop: 24,
  },
  secureBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 10,
    marginBottom: 14,
  },
  secureBadgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: E.colors.success,
  },
  secureBadgeText: {
    fontSize: 12,
    color: E.colors.primaryLight,
    fontWeight: '500',
  },
  logoRow:    { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  logoIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoIconText: { fontSize: 22, color: '#fff', fontWeight: '700', lineHeight: 26 },
  logoText: {
    fontSize: 28,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: 0.5,
  },
  heroSub: {
    fontSize: 14,
    color: '#B3D9DF',
    fontWeight: '400',
    marginBottom: E.pad,
  },
  roleChips: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 0,
    paddingHorizontal: 2,
  },
  roleChip: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 14,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderTopWidth: 2,
    borderTopColor: 'transparent',
    borderLeftWidth: 0,
    borderRightWidth: 0,
    borderBottomWidth: 0,
  },
  roleChipActive: {
    backgroundColor: '#fff',
    borderTopColor: E.colors.accent,
  },
  roleChipIcon:          { fontSize: 20, marginBottom: 4 },
  roleChipLabel:         { fontSize: 13, fontWeight: '600' },
  roleChipLabelActive:   { color: E.colors.primary },
  roleChipLabelInactive: { color: 'rgba(255,255,255,0.75)' },
  heroWave: {
    height: 24,
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    marginTop: 4,
  },

  // ── Form
  formBody: {
    backgroundColor: '#fff',
    paddingHorizontal: 24,
    paddingTop: 4,
    // Ensure the form always fills the full width of the scroll container
    alignSelf: 'stretch',
    width: '100%',
  },
  welcomeLine: { ...ET.h2, marginBottom: 2 },
  welcomeSub:  { ...ET.body, color: E.colors.textSecondary, marginBottom: E.pad },

  // ── Full-width field wrappers (replace the custom Input component on web)
  fieldWrapper: {
    width: '100%',
    marginBottom: E.padSm,
  },
  fieldLabel: {
    ...ET.label,
    marginBottom: 6,
    color: E.colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  inputBox: {
    width: '100%',
    height: 52,
    borderRadius: E.radiusSm,
    borderWidth: 1.5,
    borderColor: E.colors.border,
    backgroundColor: E.colors.bg,
    overflow: 'hidden',
  },
  inputBoxError: {
    borderColor: E.colors.danger,
    backgroundColor: E.colors.dangerLight,
  },
  inputBoxRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  showBtn: {
    paddingHorizontal: 12,
    height: '100%',
    justifyContent: 'center',
  },
  fieldError: {
    ...ET.caption,
    color: E.colors.danger,
    marginTop: 4,
  },

  forgotRow: {
    alignItems: 'flex-end',
    marginBottom: E.padSm,
    marginTop: -E.padXs,
  },
  forgotText: {
    fontSize: 13,
    color: E.colors.primary,
    fontWeight: '500',
  },
  showPasswordText: {
    ...ET.caption,
    color: E.colors.primary,
    fontWeight: '600',
  },
  errorBox: {
    backgroundColor: E.colors.dangerLight,
    borderRadius: E.radiusSm,
    padding: E.padSm,
    marginBottom: E.padSm,
  },
  errorBoxText: {
    ...ET.caption,
    color: E.colors.danger,
    textAlign: 'center',
  },

  // Sign In button
  signInBtn: {
    height: E.tapXL,
    backgroundColor: E.colors.primary,
    borderRadius: E.radius,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: E.pad,
    width: '100%',
  },
  signInBtnDisabled: { opacity: 0.65 },
  signInBtnText:     { ...ET.btnPrimary },
  signInArrow:       { fontSize: 20, color: '#fff', fontWeight: '700' },

  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: E.padSm,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: E.colors.divider },
  dividerText: { ...ET.caption, fontWeight: '500' },

  registerRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: E.pad,
  },
  registerText: { ...ET.body, color: E.colors.textSecondary },
  registerLink: { ...ET.body, color: E.colors.primary, fontWeight: '600' },

  // ── Trust bar
  trustBar: {
    backgroundColor: E.colors.bg,
    borderTopWidth: 1,
    borderTopColor: E.colors.divider,
    paddingVertical: 10,
    paddingHorizontal: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
});