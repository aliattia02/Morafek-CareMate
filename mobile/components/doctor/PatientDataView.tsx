/**
 * Patient Data View Component
 * Location: mobile/components/doctor/PatientDataView.tsx
 *
 * Tabs: Overview | Visits | Vitals
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  StyleSheet,
} from 'react-native';

import { Card } from '@/components/ui';
import apiClient from '@/services/api/client';
import { API } from '@/services/api/endpoints';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import type { DoctorPatient } from '@/services/api/doctor';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type TabType = 'overview' | 'visits' | 'vitals';

interface Visit {
  id?: string;
  visit_date: string;
  chief_complaint?: string;
  diagnosis_text?: string;
  diagnosis_icd10?: string;
}

interface Vital {
  id?: string;
  timestamp: string;
  systolic?: number;
  diastolic?: number;
  pulse?: number;
  urgent?: boolean;
}

interface PatientDataViewProps {
  patient: DoctorPatient;
  onBack?: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function PatientDataView({ patient, onBack }: PatientDataViewProps) {
  const [activeTab, setActiveTab] = useState<TabType>('overview');

  const [visits, setVisits] = useState<Visit[]>([]);
  const [visitsLoading, setVisitsLoading] = useState(false);
  const [visitsLoaded, setVisitsLoaded] = useState(false);
  const [visitsError, setVisitsError] = useState<string | null>(null);
  const [visitsRefreshing, setVisitsRefreshing] = useState(false);

  const [vitals, setVitals] = useState<Vital[]>([]);
  const [vitalsLoading, setVitalsLoading] = useState(false);
  const [vitalsLoaded, setVitalsLoaded] = useState(false);
  const [vitalsError, setVitalsError] = useState<string | null>(null);
  const [vitalsRefreshing, setVitalsRefreshing] = useState(false);

  const loadVisits = useCallback(async () => {
    try {
      setVisitsError(null);
      const response = await apiClient.get<Visit[]>(API.EHR.PATIENT_VISITS(patient.id));
      setVisits(response.data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load visits';
      setVisitsError(message);
    } finally {
      setVisitsLoading(false);
      setVisitsLoaded(true);
    }
  }, [patient.id]);

  const loadVitals = useCallback(async () => {
    try {
      setVitalsError(null);
      const response = await apiClient.get<Vital[]>(API.EHR.PATIENT_VITALS(patient.id));
      setVitals(response.data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load vitals';
      setVitalsError(message);
    } finally {
      setVitalsLoading(false);
      setVitalsLoaded(true);
    }
  }, [patient.id]);

  useEffect(() => {
    if (activeTab === 'visits' && !visitsLoaded && !visitsLoading) {
      setVisitsLoading(true);
      loadVisits();
    }
  }, [activeTab, loadVisits]);

  useEffect(() => {
    if (activeTab === 'vitals' && !vitalsLoaded && !vitalsLoading) {
      setVitalsLoading(true);
      loadVitals();
    }
  }, [activeTab, loadVitals]);

  const onRefreshVisits = useCallback(async () => {
    setVisitsRefreshing(true);
    await loadVisits();
    setVisitsRefreshing(false);
  }, [loadVisits]);

  const onRefreshVitals = useCallback(async () => {
    setVitalsRefreshing(true);
    await loadVitals();
    setVitalsRefreshing(false);
  }, [loadVitals]);

  const tabs: { key: TabType; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'visits', label: 'Visits' },
    { key: 'vitals', label: 'Vitals' },
  ];

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        {onBack && (
          <TouchableOpacity onPress={onBack} style={styles.backButton}>
            <Text style={styles.backText}>‹ Back</Text>
          </TouchableOpacity>
        )}
        <Text style={styles.patientName}>
          {patient.firstName} {patient.lastName}
        </Text>
      </View>

      {/* Tab Bar */}
      <View style={styles.tabBar}>
        {tabs.map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <ScrollView contentContainerStyle={styles.content}>
          <Card variant="outlined" padding="medium" style={styles.card}>
            <Text style={styles.fieldLabel}>First Name</Text>
            <Text style={styles.fieldValue}>{patient.firstName}</Text>
            <Text style={styles.fieldLabel}>Last Name</Text>
            <Text style={styles.fieldValue}>{patient.lastName}</Text>
            <Text style={styles.fieldLabel}>Email</Text>
            <Text style={styles.fieldValue}>{patient.email}</Text>
          </Card>
        </ScrollView>
      )}

      {/* Visits Tab */}
      {activeTab === 'visits' && (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={visitsRefreshing}
              onRefresh={onRefreshVisits}
              colors={[colors.primary]}
            />
          }
        >
          {visitsLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.loader} />
          ) : visitsError ? (
            <Text style={styles.errorText}>⚠️ {visitsError}</Text>
          ) : visits.length === 0 ? (
            <Text style={styles.emptyText}>No visits found.</Text>
          ) : (
            visits.map((visit, index) => (
              <Card key={visit.id ?? index} variant="outlined" padding="medium" style={styles.card}>
                <Text style={styles.dateText}>{visit.visit_date}</Text>
                {visit.chief_complaint ? (
                  <>
                    <Text style={styles.fieldLabel}>Chief Complaint</Text>
                    <Text style={styles.fieldValue}>{visit.chief_complaint}</Text>
                  </>
                ) : null}
                {visit.diagnosis_text ? (
                  <>
                    <Text style={styles.fieldLabel}>Diagnosis</Text>
                    <Text style={styles.fieldValue}>{visit.diagnosis_text}</Text>
                  </>
                ) : null}
                {visit.diagnosis_icd10 ? (
                  <>
                    <Text style={styles.fieldLabel}>ICD-10</Text>
                    <Text style={styles.fieldValue}>{visit.diagnosis_icd10}</Text>
                  </>
                ) : null}
              </Card>
            ))
          )}
        </ScrollView>
      )}

      {/* Vitals Tab */}
      {activeTab === 'vitals' && (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={vitalsRefreshing}
              onRefresh={onRefreshVitals}
              colors={[colors.primary]}
            />
          }
        >
          {vitalsLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.loader} />
          ) : vitalsError ? (
            <Text style={styles.errorText}>⚠️ {vitalsError}</Text>
          ) : vitals.length === 0 ? (
            <Text style={styles.emptyText}>No vitals found.</Text>
          ) : (
            vitals.map((vital, index) => (
              <Card key={vital.id ?? index} variant="outlined" padding="medium" style={styles.card}>
                <View style={styles.vitalHeader}>
                  <Text style={styles.dateText}>{vital.timestamp}</Text>
                  {vital.urgent && <Text style={styles.urgentText}>⚠️ URGENT</Text>}
                </View>
                {vital.systolic != null && vital.diastolic != null ? (
                  <>
                    <Text style={styles.fieldLabel}>Blood Pressure</Text>
                    <Text style={styles.fieldValue}>{vital.systolic}/{vital.diastolic} mmHg</Text>
                  </>
                ) : null}
                {vital.pulse != null ? (
                  <>
                    <Text style={styles.fieldLabel}>Pulse</Text>
                    <Text style={styles.fieldValue}>{vital.pulse} bpm</Text>
                  </>
                ) : null}
              </Card>
            ))
          )}
        </ScrollView>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backButton: {
    marginBottom: spacing.xs,
  },
  backText: {
    ...typography.body,
    color: colors.primary,
    fontWeight: '600',
  },
  patientName: {
    ...typography.h2,
    color: colors.text.primary,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tab: {
    flex: 1,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: colors.primary,
  },
  tabText: {
    ...typography.body,
    color: colors.text.secondary,
  },
  tabTextActive: {
    color: colors.primary,
    fontWeight: '600',
  },
  content: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  card: {
    marginBottom: spacing.md,
  },
  loader: {
    marginTop: spacing.xl,
  },
  errorText: {
    ...typography.body,
    color: colors.danger,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
  emptyText: {
    ...typography.body,
    color: colors.text.secondary,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
  fieldLabel: {
    ...typography.small,
    color: colors.text.secondary,
    marginTop: spacing.sm,
  },
  fieldValue: {
    ...typography.body,
    color: colors.text.primary,
  },
  dateText: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  vitalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  urgentText: {
    ...typography.body,
    color: colors.danger,
    fontWeight: '700',
  },
});
