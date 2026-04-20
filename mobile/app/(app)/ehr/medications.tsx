import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  ToastAndroid,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import { E, ET } from '@/constants/elderlyTheme';
import AdherenceHeatmap from '@/components/ehr/AdherenceHeatmap';
import DailySlotCard from '@/components/ehr/DailySlotCard';
import MedicationDetailModal from '@/components/ehr/MedicationDetailModal';
import {
  confirmIntake,
  getMedicationAdherence,
  getMyMedications,
  getTodayMedications,
  type MedicationAdherenceResponse,
  type MedicationRecord,
  type TodayMedicationResponse,
} from '@/services/api/medications';
import {
  cacheTodayMedications,
  deletePendingMedicationIntake,
  getCachedTodayMedications,
  getPendingMedicationIntakes,
  initDB,
  queueMedicationIntake,
} from '@/services/offline/db';

type SlotKey = keyof TodayMedicationResponse['slots'];
type MedicationsTab = 'today' | 'my-medications';
const TOAST_DURATION_MS = 2400;

const SLOT_META: Record<SlotKey, { label: string }> = {
  morning: { label: 'Morgens' },
  noon: { label: 'Mittags' },
  evening: { label: 'Abends' },
  night: { label: 'Nachts' },
};

function progressColor(rate: number) {
  if (rate < 0.5) return E.colors.danger;
  if (rate < 0.8) return E.colors.warning;
  return E.colors.success;
}

function normalizeDate(date?: string | null): string {
  if (!date) return '—';
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return date;
  return value.toLocaleDateString();
}

function coverageLabel(value: MedicationRecord['coverage']) {
  return value ?? '—';
}

function syncedToastMessage(count: number) {
  return `Synced ${count} offline confirmation${count > 1 ? 's' : ''}`;
}

function slotTargetDate(dateString: string, slot: SlotKey): Date {
  const date = new Date(dateString);
  date.setSeconds(0, 0);
  if (slot === 'morning') {
    date.setHours(8, 0, 0, 0);
  } else if (slot === 'noon') {
    date.setHours(12, 0, 0, 0);
  } else if (slot === 'evening') {
    date.setHours(18, 0, 0, 0);
  } else {
    date.setHours(21, 0, 0, 0);
  }
  return date;
}

function computeSummary(slots: TodayMedicationResponse['slots']) {
  const allItems = Object.values(slots).flat();
  return {
    total: allItems.length,
    taken: allItems.filter((item) => item.status === 'taken').length,
    pending: allItems.filter((item) => item.status === 'pending').length,
    skipped: allItems.filter((item) => item.status === 'skipped').length,
  };
}

function patchIntakeStatus(
  prev: TodayMedicationResponse,
  intakeId: string,
  status: 'pending' | 'taken' | 'skipped'
): TodayMedicationResponse {
  const nextSlots = {
    morning: prev.slots.morning.map((item) => (item.intake_id === intakeId ? { ...item, status } : item)),
    noon: prev.slots.noon.map((item) => (item.intake_id === intakeId ? { ...item, status } : item)),
    evening: prev.slots.evening.map((item) => (item.intake_id === intakeId ? { ...item, status } : item)),
    night: prev.slots.night.map((item) => (item.intake_id === intakeId ? { ...item, status } : item)),
  };

  return {
    ...prev,
    slots: nextSlots,
    summary: computeSummary(nextSlots),
  };
}

export default function MedicationsScreen() {
  const [activeTab, setActiveTab] = useState<MedicationsTab>('today');
  const [todayData, setTodayData] = useState<TodayMedicationResponse | null>(null);
  const [myMedications, setMyMedications] = useState<MedicationRecord[]>([]);
  const [adherence, setAdherence] = useState<MedicationAdherenceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatingIntakeId, setUpdatingIntakeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usingCache, setUsingCache] = useState(false);
  const [selectedMedication, setSelectedMedication] = useState<MedicationRecord | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [expandedSlots, setExpandedSlots] = useState<Record<SlotKey, boolean>>({
    morning: true,
    noon: true,
    evening: true,
    night: true,
  });

  const medicationsById = useMemo(
    () => Object.fromEntries(myMedications.map((m) => [String(m.id ?? m._id), m])) as Record<string, MedicationRecord>,
    [myMedications]
  );

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMessage(message);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), TOAST_DURATION_MS);

    try {
      ToastAndroid.show(message, ToastAndroid.SHORT);
    } catch {
      // no-op outside Android
    }
  }, []);

  const syncPendingIntakes = useCallback(async () => {
    const pending = getPendingMedicationIntakes();
    let syncedCount = 0;

    for (const item of pending) {
      if (item.type !== 'intake_confirm') continue;
      try {
        await confirmIntake(item.intakeId, item.status);
        deletePendingMedicationIntake(item.local_id);
        syncedCount += 1;
      } catch {
        // Keep failed item for next retry
      }
    }

    return syncedCount;
  }, []);

  const scheduleMedicationNotifications = useCallback(async (today: TodayMedicationResponse) => {
    try {
      const settings = await Notifications.getPermissionsAsync();
      let granted = settings.granted;

      if (!granted) {
        const request = await Notifications.requestPermissionsAsync();
        granted = request.granted;
      }
      if (!granted) return;

      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('medications', {
          name: 'Medication reminders',
          importance: Notifications.AndroidImportance.HIGH,
        });
      }

      await Notifications.cancelAllScheduledNotificationsAsync();

      const now = new Date();
      for (const slot of Object.keys(today.slots) as SlotKey[]) {
        for (const item of today.slots[slot]) {
          if (item.status !== 'pending') continue;

          const triggerDate = slotTargetDate(today.date, slot);
          if (triggerDate <= now) continue;

          await Notifications.scheduleNotificationAsync({
            content: {
              title: 'Medikament einnehmen',
              body: `${item.medication.trade_name}: ${item.dosage} ${item.unit}`,
              data: {
                screen: 'medications',
                intakeId: item.intake_id,
              },
            },
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.DATE,
              date: triggerDate,
              channelId: Platform.OS === 'android' ? 'medications' : undefined,
            },
          });
        }
      }
    } catch {
      // Skip silently; reminders must never block UI.
    }
  }, []);

  const loadTodayData = useCallback(async () => {
    setUsingCache(false);
    try {
      const today = await getTodayMedications();
      setTodayData(today);
      cacheTodayMedications(today);
      void scheduleMedicationNotifications(today);
    } catch (err: unknown) {
      const cached = getCachedTodayMedications();
      if (cached) {
        setTodayData(cached);
        setUsingCache(true);
        void scheduleMedicationNotifications(cached);
      } else {
        throw err;
      }
    }
  }, [scheduleMedicationNotifications]);

  const loadMyMedications = useCallback(async () => {
    const [medications, adherenceData] = await Promise.all([
      getMyMedications(),
      getMedicationAdherence({ period_days: 28 }),
    ]);
    setMyMedications(medications.filter((med) => med.is_active !== false));
    setAdherence(adherenceData);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const synced = await syncPendingIntakes();
      if (synced > 0) {
        showToast(syncedToastMessage(synced));
      }
      await Promise.all([loadTodayData(), loadMyMedications()]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load medications');
    } finally {
      setLoading(false);
    }
  }, [loadMyMedications, loadTodayData, showToast, syncPendingIntakes]);

  useEffect(() => {
    initDB();
    loadAll();
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, [loadAll]);

  useFocusEffect(
    useCallback(() => {
      let active = true;

      const drainQueue = async () => {
        const synced = await syncPendingIntakes();
        if (!active || synced === 0) return;
        showToast(syncedToastMessage(synced));
        await loadTodayData();
      };

      drainQueue();
      return () => {
        active = false;
      };
    }, [loadTodayData, showToast, syncPendingIntakes])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setError(null);
      if (activeTab === 'today') {
        await loadTodayData();
      } else {
        await loadMyMedications();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }, [activeTab, loadMyMedications, loadTodayData]);

  const handleConfirm = useCallback(
    async (intakeId: string, status: 'taken' | 'skipped') => {
      setUpdatingIntakeId(intakeId);

      setTodayData((prev) => (prev ? patchIntakeStatus(prev, intakeId, status) : prev));

      try {
        await confirmIntake(intakeId, status);
      } catch {
        setTodayData((prev) => (prev ? patchIntakeStatus(prev, intakeId, 'pending') : prev));
        queueMedicationIntake({
          type: 'intake_confirm',
          intakeId,
          status,
          timestamp: new Date().toISOString(),
        });
        showToast('Saved offline. Will sync when connection is restored.');
      } finally {
        setUpdatingIntakeId(null);
      }
    },
    [showToast]
  );

  const toggleSlot = useCallback((slot: SlotKey) => {
    setExpandedSlots((prev) => ({ ...prev, [slot]: !prev[slot] }));
  }, []);

  const openMedicationDetail = useCallback(
    (medicationId?: string) => {
      if (!medicationId) return;
      setSelectedMedication(medicationsById[medicationId] ?? null);
    },
    [medicationsById]
  );

  const summaryRate = useMemo(() => {
    if (!todayData?.summary.total) return 0;
    return todayData.summary.taken / todayData.summary.total;
  }, [todayData]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'My Medications' }} />

      <View style={styles.tabRow}>
        <TouchableOpacity
          style={[styles.tabPill, activeTab === 'today' && styles.tabPillActive]}
          onPress={() => setActiveTab('today')}
        >
          <Text style={[styles.tabText, activeTab === 'today' && styles.tabTextActive]}>Today</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabPill, activeTab === 'my-medications' && styles.tabPillActive]}
          onPress={() => setActiveTab('my-medications')}
        >
          <Text style={[styles.tabText, activeTab === 'my-medications' && styles.tabTextActive]}>My Medications</Text>
        </TouchableOpacity>
      </View>

      {toastMessage ? (
        <View style={styles.toast}>
          <Text style={styles.toastText}>{toastMessage}</Text>
        </View>
      ) : null}

      {loading ? (
        <ActivityIndicator color={E.colors.primary} style={styles.loader} size="large" />
      ) : activeTab === 'today' ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[E.colors.primary]} />}
        >
          {error ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>⚠️ {error}</Text>
            </View>
          ) : null}

          {usingCache ? (
            <View style={styles.cacheBanner}>
              <Text style={styles.cacheText}>⚠️ Showing cached data</Text>
            </View>
          ) : null}

          <View style={styles.summaryCard}>
            <Text style={styles.summaryTitle}>
              {todayData?.summary.taken ?? 0} of {todayData?.summary.total ?? 0} taken today
            </Text>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  {
                    width: `${Math.max(0, Math.min(100, Math.round(summaryRate * 100)))}%`,
                    backgroundColor: progressColor(summaryRate),
                  },
                ]}
              />
            </View>
          </View>

          {(Object.keys(SLOT_META) as SlotKey[]).map((slot) => {
            const items = todayData?.slots[slot] ?? [];
            if (items.length === 0) return null;

            const taken = items.filter((item) => item.status === 'taken').length;
            const expanded = expandedSlots[slot];

            return (
              <View key={slot} style={styles.section}>
                <TouchableOpacity style={styles.sectionHeader} onPress={() => toggleSlot(slot)}>
                  <Text style={styles.sectionTitle}>{SLOT_META[slot].label}</Text>
                  <View style={styles.sectionRight}>
                    <Text style={styles.badgeText}>
                      {taken} / {items.length} taken
                    </Text>
                    <Text style={styles.chevron}>{expanded ? '⌃' : '⌄'}</Text>
                  </View>
                </TouchableOpacity>

                {expanded ? (
                  <View style={styles.sectionCards}>
                    {items.map((item) => (
                      <DailySlotCard
                        key={item.intake_id}
                        medicationName={item.medication.trade_name}
                        activeSubstance={item.medication.active_substance || '—'}
                        dosage={item.dosage}
                        unit={item.unit}
                        intakeId={item.intake_id}
                        status={item.status}
                        onConfirm={handleConfirm}
                        disabled={item.status !== 'pending' || updatingIntakeId === item.intake_id}
                      />
                    ))}
                  </View>
                ) : null}
              </View>
            );
          })}
        </ScrollView>
      ) : (
        <FlatList
          style={styles.scroll}
          contentContainerStyle={styles.content}
          data={myMedications}
          keyExtractor={(item) => String(item.id ?? item._id)}
          refreshing={refreshing}
          onRefresh={onRefresh}
          renderItem={({ item }) => {
            const medicationId = item.id ?? item._id;
            return (
              <TouchableOpacity
                style={styles.medicationCard}
                onPress={() => openMedicationDetail(medicationId)}
              >
                <Text style={styles.medicationName}>{item.trade_name}</Text>
                <Text style={styles.medicationSubline}>
                  {item.active_substance} • {item.strength} • {item.form}
                </Text>

                <View style={styles.pillsRow}>
                  <View style={styles.dosageBadge}>
                    <Text style={styles.dosageBadgeText}>{item.dosage_label ?? '—'}</Text>
                  </View>
                  <View style={styles.coverageBadge}>
                    <Text style={styles.coverageBadgeText}>{coverageLabel(item.coverage)}</Text>
                  </View>
                </View>

                <Text style={styles.dateLine}>
                  Start: {normalizeDate(item.start_date)} •{' '}
                  {item.is_chronic ? 'Dauermedikation' : `Ende: ${normalizeDate(item.end_date)}`}
                </Text>
              </TouchableOpacity>
            );
          }}
          ListHeaderComponent={
            error ? (
              <View style={styles.errorBanner}>
                <Text style={styles.errorText}>⚠️ {error}</Text>
              </View>
            ) : null
          }
          ListFooterComponent={
            adherence ? (
              <View style={styles.heatmapWrapper}>
                <AdherenceHeatmap days={adherence.days} overallRate={adherence.overall_rate} />
              </View>
            ) : null
          }
        />
      )}

      <MedicationDetailModal medication={selectedMedication} onClose={() => setSelectedMedication(null)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: E.colors.bg,
  },
  loader: {
    marginTop: 40,
  },
  tabRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: E.padSm,
    paddingTop: E.padSm,
  },
  tabPill: {
    flex: 1,
    minHeight: 44,
    borderRadius: E.radiusFull,
    borderWidth: 1,
    borderColor: E.colors.border,
    backgroundColor: E.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabPillActive: {
    backgroundColor: E.colors.primary,
    borderColor: E.colors.primary,
  },
  tabText: {
    ...ET.bodyBold,
    color: E.colors.textSecondary,
  },
  tabTextActive: {
    color: E.colors.textInverse,
  },
  toast: {
    marginTop: 8,
    marginHorizontal: E.padSm,
    borderRadius: E.radiusSm,
    backgroundColor: E.colors.primaryDark,
    paddingHorizontal: E.padSm,
    paddingVertical: 8,
  },
  toastText: {
    ...ET.small,
    color: E.colors.textInverse,
    fontWeight: '700',
    textAlign: 'center',
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: E.padSm,
    gap: 12,
    paddingBottom: 32,
  },
  errorBanner: {
    borderRadius: E.radiusSm,
    backgroundColor: E.colors.dangerLight,
    padding: E.padSm,
  },
  errorText: {
    ...ET.body,
    color: E.colors.danger,
  },
  cacheBanner: {
    borderRadius: E.radiusSm,
    backgroundColor: E.colors.warningLight,
    padding: E.padSm,
  },
  cacheText: {
    ...ET.bodyBold,
    color: E.colors.warning,
  },
  summaryCard: {
    borderRadius: E.radius,
    borderWidth: 1,
    borderColor: E.colors.border,
    backgroundColor: E.colors.surface,
    padding: E.padSm,
    gap: 8,
  },
  summaryTitle: {
    ...ET.bodyBold,
  },
  progressTrack: {
    height: 12,
    borderRadius: E.radiusFull,
    backgroundColor: E.colors.surfaceAlt,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: E.radiusFull,
  },
  section: {
    borderRadius: E.radius,
    borderWidth: 1,
    borderColor: E.colors.border,
    backgroundColor: E.colors.surface,
    overflow: 'hidden',
  },
  sectionHeader: {
    minHeight: 56,
    paddingHorizontal: E.padSm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: E.colors.surfaceAlt,
  },
  sectionTitle: {
    ...ET.bodyBold,
  },
  sectionRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  badgeText: {
    ...ET.small,
    color: E.colors.textSecondary,
    fontWeight: '700',
  },
  chevron: {
    ...ET.bodyBold,
    color: E.colors.textSecondary,
  },
  sectionCards: {
    padding: E.padSm,
    gap: 8,
  },
  medicationCard: {
    borderRadius: E.radius,
    borderWidth: 1,
    borderColor: E.colors.border,
    backgroundColor: E.colors.surface,
    padding: E.padSm,
    gap: 8,
  },
  medicationName: {
    ...ET.h3,
    fontWeight: '700',
  },
  medicationSubline: {
    ...ET.body,
    color: E.colors.textSecondary,
  },
  pillsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  dosageBadge: {
    borderRadius: E.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: E.colors.primaryLight,
  },
  dosageBadgeText: {
    ...ET.small,
    color: E.colors.primaryDark,
    fontWeight: '700',
  },
  coverageBadge: {
    borderRadius: E.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: E.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: E.colors.border,
  },
  coverageBadgeText: {
    ...ET.small,
    color: E.colors.textPrimary,
    fontWeight: '700',
  },
  dateLine: {
    ...ET.small,
    color: E.colors.textSecondary,
  },
  heatmapWrapper: {
    width: '100%',
  },
});
