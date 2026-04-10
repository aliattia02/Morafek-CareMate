/**
 * Patient Data View Component
 * Location: mobile/components/doctor/PatientDataView.tsx
 *
 * Tabs: Overview | Visits | Vitals | Messages
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  TextInput,
  Linking,
  Alert,
  StyleSheet,
} from 'react-native';

import { Card } from '@/components/ui';
import { getPatientConstants } from '@/services/api/doctor';
import {
  getDoctorPatientVitals,
  getDoctorPatientVisits,
  getMessageThread,
  getDoctorPatientDocuments,
  getDoctorPatientExercises,
  sendMessage,
  type VitalResponse,
  type VisitResponse,
  type MessageResponse,
  type DocumentResponse,
  type ExerciseResponse,
} from '@/services/api/ehr';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import type { DoctorPatient } from '@/services/api/doctor';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type TabType = 'overview' | 'visits' | 'vitals' | 'documents' | 'exercises' | 'messages';

interface PatientDataViewProps {
  patient: DoctorPatient;
  onBack?: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function PatientDataView({ patient, onBack }: PatientDataViewProps) {
  const [activeTab, setActiveTab] = useState<TabType>('overview');

  const [vitals, setVitals] = useState<VitalResponse[]>([]);
  const [vitalsLoading, setVitalsLoading] = useState(false);
  const [vitalsLoaded, setVitalsLoaded] = useState(false);
  const [vitalsError, setVitalsError] = useState<string | null>(null);
  const [vitalsRefreshing, setVitalsRefreshing] = useState(false);

  const [visits, setVisits] = useState<VisitResponse[]>([]);
  const [visitsLoading, setVisitsLoading] = useState(false);
  const [visitsLoaded, setVisitsLoaded] = useState(false);
  const [visitsError, setVisitsError] = useState<string | null>(null);
  const [visitsRefreshing, setVisitsRefreshing] = useState(false);

  const [messages, setMessages] = useState<MessageResponse[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [messagesRefreshing, setMessagesRefreshing] = useState(false);
  const [messageInput, setMessageInput] = useState('');
  const [messageSending, setMessageSending] = useState(false);

  const [documents, setDocuments] = useState<DocumentResponse[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentsLoaded, setDocumentsLoaded] = useState(false);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [documentsRefreshing, setDocumentsRefreshing] = useState(false);

  const [exercises, setExercises] = useState<ExerciseResponse[]>([]);
  const [exercisesLoading, setExercisesLoading] = useState(false);
  const [exercisesLoaded, setExercisesLoaded] = useState(false);
  const [exercisesError, setExercisesError] = useState<string | null>(null);
  const [exercisesRefreshing, setExercisesRefreshing] = useState(false);

  const loadVitals = useCallback(async () => {
    try {
      setVitalsError(null);
      const data = await getDoctorPatientVitals(patient.id);
      setVitals(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load vitals';
      setVitalsError(message);
    } finally {
      setVitalsLoading(false);
      setVitalsLoaded(true);
    }
  }, [patient.id]);

  const loadVisits = useCallback(async () => {
    try {
      setVisitsError(null);
      const data = await getDoctorPatientVisits(patient.id);
      setVisits(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load visits';
      setVisitsError(message);
    } finally {
      setVisitsLoading(false);
      setVisitsLoaded(true);
    }
  }, [patient.id]);

  const loadMessages = useCallback(async () => {
    try {
      setMessagesError(null);
      const data = await getMessageThread(patient.id);
      setMessages(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load messages';
      setMessagesError(message);
    } finally {
      setMessagesLoading(false);
      setMessagesLoaded(true);
    }
  }, [patient.id]);

  const loadDocuments = useCallback(async () => {
    try {
      setDocumentsError(null);
      const data = await getDoctorPatientDocuments(patient.id);
      setDocuments(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load documents';
      setDocumentsError(message);
    } finally {
      setDocumentsLoading(false);
      setDocumentsLoaded(true);
    }
  }, [patient.id]);

  const loadExercises = useCallback(async () => {
    try {
      setExercisesError(null);
      const data = await getDoctorPatientExercises(patient.id);
      setExercises(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load exercises';
      setExercisesError(message);
    } finally {
      setExercisesLoading(false);
      setExercisesLoaded(true);
    }
  }, [patient.id]);

  useEffect(() => {
    if (activeTab === 'vitals' && !vitalsLoaded && !vitalsLoading) {
      setVitalsLoading(true);
      loadVitals();
    }
  }, [activeTab, loadVitals]);

  useEffect(() => {
    if (activeTab === 'visits' && !visitsLoaded && !visitsLoading) {
      setVisitsLoading(true);
      loadVisits();
    }
  }, [activeTab, loadVisits]);

  useEffect(() => {
    if (activeTab === 'messages' && !messagesLoaded && !messagesLoading) {
      setMessagesLoading(true);
      loadMessages();
    }
  }, [activeTab, loadMessages]);

  useEffect(() => {
    if (activeTab === 'documents' && !documentsLoaded && !documentsLoading) {
      setDocumentsLoading(true);
      loadDocuments();
    }
  }, [activeTab, loadDocuments]);

  useEffect(() => {
    if (activeTab === 'exercises' && !exercisesLoaded && !exercisesLoading) {
      setExercisesLoading(true);
      loadExercises();
    }
  }, [activeTab, loadExercises]);

  const onRefreshVitals = useCallback(async () => {
    setVitalsRefreshing(true);
    await loadVitals();
    setVitalsRefreshing(false);
  }, [loadVitals]);

  const onRefreshVisits = useCallback(async () => {
    setVisitsRefreshing(true);
    await loadVisits();
    setVisitsRefreshing(false);
  }, [loadVisits]);

  const onRefreshMessages = useCallback(async () => {
    setMessagesRefreshing(true);
    await loadMessages();
    setMessagesRefreshing(false);
  }, [loadMessages]);

  const onRefreshDocuments = useCallback(async () => {
    setDocumentsRefreshing(true);
    await loadDocuments();
    setDocumentsRefreshing(false);
  }, [loadDocuments]);

  const onRefreshExercises = useCallback(async () => {
    setExercisesRefreshing(true);
    await loadExercises();
    setExercisesRefreshing(false);
  }, [loadExercises]);

  const handleSendMessage = useCallback(async () => {
    const body = messageInput.trim();
    if (!body || messageSending) return;
    try {
      setMessageSending(true);
      const sent = await sendMessage(patient.id, body);
      setMessages((prev) => [...prev, sent]);
      setMessageInput('');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to send message';
      setMessagesError(message);
    } finally {
      setMessageSending(false);
    }
  }, [messageInput, messageSending, patient.id]);

  const tabs: { key: TabType; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'visits', label: 'Visits' },
    { key: 'vitals', label: 'Vitals' },
    { key: 'documents', label: 'Documents' },
    { key: 'exercises', label: 'Exercises' },
    { key: 'messages', label: 'Messages' },
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
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabBar}
        contentContainerStyle={styles.tabBarContent}
      >
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
      </ScrollView>

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

      {/* Messages Tab */}
      {activeTab === 'messages' && (
        <View style={styles.messagesContainer}>
          <ScrollView
            contentContainerStyle={styles.content}
            refreshControl={
              <RefreshControl
                refreshing={messagesRefreshing}
                onRefresh={onRefreshMessages}
                colors={[colors.primary]}
              />
            }
          >
            {messagesLoading ? (
              <ActivityIndicator color={colors.primary} style={styles.loader} />
            ) : messagesError ? (
              <Text style={styles.errorText}>⚠️ {messagesError}</Text>
            ) : messages.length === 0 ? (
              <Text style={styles.emptyText}>No messages yet.</Text>
            ) : (
              messages.map((msg, index) => {
                const isDoctor = msg.sender_type === 'doctor';
                return (
                  <View
                    key={msg.id ?? index}
                    style={[
                      styles.messageBubble,
                      isDoctor ? styles.messageBubbleDoctor : styles.messageBubblePatient,
                    ]}
                  >
                    <Text style={[styles.messageBody, isDoctor && styles.messageBodyDoctor]}>{msg.body}</Text>
                    <Text style={[styles.messageTime, isDoctor && styles.messageTimeDoctor]}>{msg.created_at}</Text>
                  </View>
                );
              })
            )}
          </ScrollView>

          <View style={styles.messageInputRow}>
            <TextInput
              style={styles.messageInput}
              placeholder="Type a message…"
              placeholderTextColor={colors.text.secondary}
              value={messageInput}
              onChangeText={setMessageInput}
              multiline
            />
            <TouchableOpacity
              style={[styles.sendButton, (!messageInput.trim() || messageSending) && styles.sendButtonDisabled]}
              onPress={handleSendMessage}
              disabled={!messageInput.trim() || messageSending}
            >
              {messageSending ? (
                <ActivityIndicator color={colors.surface} size="small" />
              ) : (
                <Text style={styles.sendButtonText}>Send</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Documents Tab */}
      {activeTab === 'documents' && (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={documentsRefreshing}
              onRefresh={onRefreshDocuments}
              colors={[colors.primary]}
            />
          }
        >
          {documentsLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.loader} />
          ) : documentsError ? (
            <Text style={styles.errorText}>⚠️ {documentsError}</Text>
          ) : documents.length === 0 ? (
            <Text style={styles.emptyText}>No documents found.</Text>
          ) : (
            documents.map((doc, index) => {
              const icons: Record<string, string> = {
                lab_report: '🧪',
                imaging: '🩻',
                prescription: '💊',
                other: '📄',
              };
              const icon = icons[doc.category] ?? '📄';
              return (
                <Card key={doc.id ?? index} variant="outlined" padding="medium" style={styles.card}>
                  <View style={styles.docHeader}>
                    <Text style={styles.docIcon}>{icon}</Text>
                    <View style={styles.docInfo}>
                      <Text style={styles.fieldValue}>{doc.description || '(No description)'}</Text>
                      <Text style={styles.fieldLabel}>{doc.created_at}</Text>
                    </View>
                  </View>
                  <TouchableOpacity
                    style={styles.viewDocButton}
                    onPress={() =>
                      Linking.openURL(doc.url).catch(() =>
                        Alert.alert('Error', 'Unable to open document.')
                      )
                    }
                  >
                    <Text style={styles.viewDocButtonText}>View</Text>
                  </TouchableOpacity>
                </Card>
              );
            })
          )}
        </ScrollView>
      )}

      {/* Exercises Tab */}
      {activeTab === 'exercises' && (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={exercisesRefreshing}
              onRefresh={onRefreshExercises}
              colors={[colors.primary]}
            />
          }
        >
          {exercisesLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.loader} />
          ) : exercisesError ? (
            <Text style={styles.errorText}>⚠️ {exercisesError}</Text>
          ) : exercises.length === 0 ? (
            <Text style={styles.emptyText}>No exercises assigned.</Text>
          ) : (
            exercises.map((ex, index) => (
              <Card key={ex.id ?? index} variant="outlined" padding="medium" style={styles.card}>
                <Text style={styles.fieldValue}>{ex.title}</Text>
                <Text style={styles.fieldLabel}>{ex.category}</Text>
                {ex.description ? (
                  <Text style={styles.fieldValue}>{ex.description}</Text>
                ) : null}
                <View style={styles.exerciseDetails}>
                  <Text style={styles.fieldLabel}>🕐 {ex.frequency}</Text>
                  {ex.duration_minutes != null && (
                    <Text style={styles.fieldLabel}>⏱ {ex.duration_minutes} min</Text>
                  )}
                  {ex.repetitions != null && ex.sets != null && (
                    <Text style={styles.fieldLabel}>🔄 {ex.repetitions}×{ex.sets}</Text>
                  )}
                </View>
                {ex.notes ? (
                  <>
                    <Text style={styles.fieldLabel}>Notes</Text>
                    <Text style={styles.fieldValue}>{ex.notes}</Text>
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
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tabBarContent: {
    flexDirection: 'row',
  },
  tab: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
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
  // Messages
  messagesContainer: {
    flex: 1,
  },
  messageBubble: {
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    maxWidth: '80%',
  },
  messageBubbleDoctor: {
    alignSelf: 'flex-end',
    backgroundColor: colors.primary,
  },
  messageBubblePatient: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  messageBody: {
    ...typography.body,
    color: colors.text.primary,
  },
  messageBodyDoctor: {
    color: colors.surface,
  },
  messageTime: {
    ...typography.small,
    color: colors.text.secondary,
    marginTop: spacing.xs,
  },
  messageTimeDoctor: {
    color: colors.surface,
    opacity: 0.8,
  },
  messageInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  messageInput: {
    flex: 1,
    ...typography.body,
    color: colors.text.primary,
    backgroundColor: colors.background,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginRight: spacing.sm,
    maxHeight: 100,
  },
  sendButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 64,
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  sendButtonText: {
    ...typography.body,
    color: colors.surface,
    fontWeight: '600',
  },
  // Documents tab
  docHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.sm,
  },
  docIcon: {
    fontSize: 22,
    marginRight: spacing.sm,
  },
  docInfo: {
    flex: 1,
  },
  viewDocButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    alignSelf: 'flex-start',
  },
  viewDocButtonText: {
    ...typography.small,
    color: colors.surface,
    fontWeight: '600',
  },
  // Exercises tab
  exerciseDetails: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
});
