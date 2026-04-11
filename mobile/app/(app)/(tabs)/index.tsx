/**
 * Patient Home Screen
 * Location: mobile/app/(app)/(tabs)/index.tsx
 *
 * Patients only — doctors are redirected to doctor-dashboard.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuthStore } from '@/store/auth.store';
import { E, ET } from '@/constants/elderlyTheme';
import { getMyVitals, getMyVisits, type VitalResponse, type VisitResponse } from '@/services/api/ehr';
import { initDB, cacheVitals, getCachedVitals } from '@/services/offline/db';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function PatientHomeScreen() {
  const router = useRouter();
  const { user } = useAuthStore();

  const [vital, setVital] = useState<VitalResponse | null>(null);
  const [visit, setVisit] = useState<VisitResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [usingCache, setUsingCache] = useState(false);

  // Redirect doctors immediately
  useEffect(() => {
    if (user?.user_type === 'doctor' || user?.user_type === 'admin') {
      router.replace('/(app)/(tabs)/doctor-dashboard');
    }
  }, [user?.user_type]);

  // Initialise local DB once
  useEffect(() => {
    initDB();
  }, []);

  if (user?.user_type === 'doctor' || user?.user_type === 'admin') {
    return <View style={{ flex: 1, backgroundColor: E.colors.bg }} />;
  }

  const loadData = useCallback(async () => {
    try {
      setError(null);
      setUsingCache(false);
      const [vitals, visits] = await Promise.all([getMyVitals(1), getMyVisits()]);
      setVital(vitals[0] ?? null);
      setVisit(visits[0] ?? null);
      // Cache the latest vitals for offline use
      if (vitals.length > 0) {
        cacheVitals(vitals);
      }
    } catch (err: unknown) {
      // Fall back to cached data when network is unavailable
      const cached = getCachedVitals();
      if (cached.length > 0) {
        setVital(cached[0]);
        setUsingCache(true);
      } else {
        const message = err instanceof Error ? err.message : 'Failed to load data';
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      {/* ── HEADER BAR ── */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerGreeting}>{greeting()}</Text>
          <Text style={styles.headerName}>{user?.firstName || 'Patient'}</Text>
        </View>
        <TouchableOpacity
          style={styles.sosButton}
          onPress={() => Linking.openURL('tel:112')}
          accessibilityLabel="SOS emergency call"
        >
          <Text style={styles.sosIcon}>🆘</Text>
          <Text style={styles.sosText}>SOS</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[E.colors.primary]}
          />
        }
      >
        {/* Error */}
        {error && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>⚠️ {error}</Text>
          </View>
        )}

        {/* Cached data banner */}
        {usingCache && (
          <View style={styles.cacheBanner}>
            <Text style={styles.cacheBannerText}>⚠️ Showing cached data</Text>
          </View>
        )}

        {/* ── BLOOD PRESSURE CARD ── */}
        <View style={styles.card}>
          <View style={styles.cardTopAccent} />
          {/* Row 1: title + timestamp */}
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>💓 Blood Pressure</Text>
            {vital && (
              <Text style={styles.cardTimestamp}>{vital.timestamp}</Text>
            )}
          </View>

          {loading ? (
            <ActivityIndicator color={E.colors.primary} style={{ marginVertical: 12 }} />
          ) : vital ? (
            <>
              {/* Row 2: BP values */}
              <View style={styles.bpRow}>
                <View style={styles.bpLeft}>
                  <Text style={styles.bpDisplay}>{vital.systolic}/{vital.diastolic}</Text>
                  <Text style={styles.bpUnit}>mmHg</Text>
                </View>
                <View style={styles.bpDivider} />
                <View style={styles.bpRight}>
                  <Text style={styles.bpPulse}>{vital.pulse}</Text>
                  <Text style={styles.bpUnit}>/min</Text>
                </View>
              </View>

              {/* Row 3: BP status badge */}
              {(() => {
                const sys = vital.systolic ?? 0;
                const dia = vital.diastolic ?? 0;
                let bg: string, fg: string, label: string;
                if (sys >= 180 || dia >= 120) {
                  bg = E.colors.dangerLight; fg = E.colors.danger;
                  label = '⚠️ Crisis — Contact Doctor Now';
                } else if (sys >= 130 || dia > 80) {
                  bg = E.colors.dangerLight; fg = E.colors.danger;
                  label = '🔴 High Blood Pressure';
                } else if (sys >= 120) {
                  bg = E.colors.warningLight; fg = E.colors.warning;
                  label = '🟠 Elevated';
                } else {
                  bg = E.colors.successLight; fg = E.colors.success;
                  label = '🟢 Normal';
                }
                return (
                  <View style={[styles.statusBadge, { backgroundColor: bg }]}>
                    <Text style={[styles.statusBadgeText, { color: fg }]}>{label}</Text>
                  </View>
                );
              })()}
            </>
          ) : (
            <Text style={styles.emptyText}>No readings yet</Text>
          )}

          {/* Row 4: Add Reading button */}
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => router.push('/(app)/log/vitals')}
          >
            <Text style={styles.primaryButtonText}>➕  Add Reading</Text>
          </TouchableOpacity>
        </View>

        {/* ── LAST VISIT CARD ── */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>🏥 Last Visit</Text>
          </View>
          {loading ? (
            <ActivityIndicator color={E.colors.primary} style={{ marginVertical: 12 }} />
          ) : visit ? (
            <>
              <Text style={styles.visitDate}>{visit.visit_date}</Text>
              {visit.diagnosis_text ? (
                <Text style={styles.visitDiagnosis}>{visit.diagnosis_text}</Text>
              ) : null}
            </>
          ) : (
            <Text style={styles.emptyTextSecondary}>No visits recorded</Text>
          )}
        </View>

        {/* ── ACTION TILES ── */}
        <View style={styles.tilesGrid}>
          {[
            { icon: '📋', title: 'My Visits',    sub: 'History',   route: '/(app)/ehr/visits',    color: '#E6F4F6', accent: E.colors.primary   },
            { icon: '💬', title: 'Messages',     sub: 'Chat',      route: '/(app)/ehr/messages',  color: '#FEF3DC', accent: E.colors.accent     },
            { icon: '📁', title: 'My Documents', sub: 'Files',     route: '/(app)/ehr/documents', color: '#E6F5EE', accent: E.colors.success    },
            { icon: '🏋️', title: 'My Exercises', sub: 'Workouts',  route: '/(app)/ehr/exercises', color: '#F0F4F5', accent: E.colors.textSecondary },
          ].map((tile) => (
            <TouchableOpacity
              key={tile.route}
              style={[styles.tile, { backgroundColor: tile.color }]}
              onPress={() => router.push(tile.route as any)}
            >
              <Text style={styles.tileIcon}>{tile.icon}</Text>
              <Text style={styles.tileTitle}>{tile.title}</Text>
              <Text style={[styles.tileSub, { color: tile.accent }]}>{tile.sub}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── SENSORS CARD (placeholder) ── */}
        <View style={styles.sensorsCard}>
          <Text style={styles.cardTitle}>📡  Connected Sensors</Text>
          <Text style={styles.emptyTextSecondary}>No sensors connected</Text>
          <Text style={styles.sensorsSmall}>Heart rate monitor, CGM, and SpO2 coming soon</Text>
        </View>
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
  // Header
  header: {
    height: 80,
    backgroundColor: E.colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: E.pad,
  },
  headerLeft: {
    flex: 1,
  },
  headerGreeting: {
    ...ET.body,
    color: E.colors.textInverse,
  },
  headerName: {
    ...ET.h2,
    color: E.colors.textInverse,
    fontWeight: '700',
  },
  sosButton: {
    width: 64,
    height: 64,
    borderRadius: E.radiusFull,
    backgroundColor: E.colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sosIcon: {
    fontSize: 22,
  },
  sosText: {
    ...ET.caption,
    color: E.colors.textInverse,
    fontWeight: '700',
  },
  // Scroll
  container: {
    flex: 1,
    backgroundColor: E.colors.bg,
  },
  content: {
    paddingBottom: 32,
  },
  // Banners
  errorBanner: {
    margin: 16,
    padding: E.pad,
    backgroundColor: E.colors.dangerLight,
    borderRadius: E.radius,
  },
  errorBannerText: {
    ...ET.bodyBold,
    color: E.colors.danger,
  },
  cacheBanner: {
    margin: 16,
    padding: E.pad,
    backgroundColor: E.colors.warningLight,
    borderRadius: E.radius,
  },
  cacheBannerText: {
    ...ET.bodyBold,
    color: E.colors.warning,
  },
  // Cards
  card: {
    backgroundColor: E.colors.surface,
    borderRadius: E.radius,
    margin: 16,
    overflow: 'hidden',
    ...E.shadow,
  },
  cardTopAccent: {
    height: 4,
    backgroundColor: E.colors.primary,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    paddingHorizontal: E.pad,
    paddingTop: E.padSm,
  },
  cardTitle: {
    ...ET.h3,
  },
  cardTimestamp: {
    ...ET.small,
  },
  // BP values
  bpRow: {
    flexDirection: 'row',
    marginBottom: 12,
    paddingHorizontal: E.pad,
    alignItems: 'center',
  },
  bpLeft: {
    flex: 1,
  },
  bpDivider: {
    width: 1,
    height: 60,
    backgroundColor: E.colors.border,
    marginHorizontal: E.padSm,
  },
  bpRight: {
    flex: 1,
    alignItems: 'flex-start',
    paddingLeft: E.padSm,
  },
  bpDisplay: {
    ...ET.display,
  },
  bpPulse: {
    ...ET.h2,
  },
  bpUnit: {
    ...ET.unit,
  },
  // Status badge
  statusBadge: {
    height: 56,
    borderRadius: E.radiusSm,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    marginHorizontal: E.pad,
  },
  statusBadgeText: {
    ...ET.bodyBold,
  },
  // Primary button
  primaryButton: {
    height: E.tapXL,
    backgroundColor: E.colors.primary,
    borderRadius: 0,
    borderBottomLeftRadius: E.radius,
    borderBottomRightRadius: E.radius,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  primaryButtonText: {
    ...ET.btnPrimary,
  },
  // Visit card
  visitDate: {
    ...ET.bodyBold,
    marginBottom: 4,
    paddingHorizontal: E.pad,
  },
  visitDiagnosis: {
    ...ET.body,
    paddingHorizontal: E.pad,
    paddingBottom: E.padSm,
  },
  // Empty states
  emptyText: {
    ...ET.body,
    textAlign: 'center',
    marginBottom: 12,
    paddingHorizontal: E.pad,
  },
  emptyTextSecondary: {
    ...ET.body,
    color: E.colors.textSecondary,
    paddingHorizontal: E.pad,
    paddingBottom: E.padSm,
  },
  // Action tiles — 2-column grid
  tilesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: 16,
    gap: 12,
  },
  tile: {
    width: '47%',
    minHeight: E.tap,
    borderRadius: E.radius,
    padding: E.padSm,
    justifyContent: 'center',
    ...E.shadowSm,
  },
  tileIcon: {
    fontSize: 28,
    marginBottom: 6,
  },
  tileTitle: {
    ...ET.bodyBold,
    marginBottom: 2,
  },
  tileSub: {
    ...ET.small,
    fontWeight: '600',
  },
  // Sensors card
  sensorsCard: {
    backgroundColor: E.colors.surfaceAlt,
    borderRadius: E.radius,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: E.colors.border,
    margin: 16,
    padding: E.pad,
  },
  sensorsSmall: {
    ...ET.small,
    marginTop: 4,
  },
});