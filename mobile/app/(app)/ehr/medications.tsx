import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import { E, ET } from '@/constants/elderlyTheme';
import AdherenceHeatmap from '@/components/ehr/AdherenceHeatmap';
import DailySlotCard from '@/components/ehr/DailySlotCard';
import MedicationDetailModal from '@/components/ehr/MedicationDetailModal';
import {
  confirmMedicationIntake,
  getMedicationAdherence,
  getMyMedications,
  getTodayMedications,
  type MedicationAdherenceResponse,
  type MedicationRecord,
  type TodayMedicationResponse,
  type TodayMedicationSlotItem,
} from '@/services/api/medications';
import {
  deletePendingMedicationIntake,
  getPendingMedicationIntakes,
  initDB,
  queueMedicationIntake,
} from '@/services/offline/db';

type SlotKey = keyof TodayMedicationResponse['slots'];

const SLOT_META: Record<SlotKey, { label: string; icon: string; hour: number; minute: number }> = {
  morning: { label: 'Morning', icon: '🌅', hour: 8, minute: 0 },
  noon: { label: 'Noon', icon: '☀️', hour: 12, minute: 0 },
  evening: { label: 'Evening', icon: '🌇', hour: 18, minute: 0 },
  night: { label: 'Night', icon: '🌙', hour: 21, minute: 0 },
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

function summarizeSlots(slots: TodayMedicationResponse['slots']) {
  const values = Object.values(slots).flat();
  return {
    total: values.length,
    taken: values.filter((it) => it.status === 'taken').length,
    pending: values.filter((it) => it.status === 'pending').length,
    skipped: values.filter((it) => it.status === 'skipped').length,
  };
}

function patchSlotStatus(
  slots: TodayMedicationResponse['slots'],
  intakeId: string,
  status: 'taken' | 'skipped'
): TodayMedicationResponse['slots'] {
  return {
    morning: slots.morning.map((i) => (i.intake_id === intakeId ? { ...i, status } : i)),
    noon: slots.noon.map((i) => (i.intake_id === intakeId ? { ...i, status } : i)),
    evening: slots.evening.map((i) => (i.intake_id === intakeId ? { ...i, status } : i)),
    night: slots.night.map((i) => (i.intake_id === intakeId ? { ...i, status } : i)),
  };
}

export default function MedicationsScreen() {
  const [medications, setMedications] = useState<MedicationRecord[]>([]);
  const [today, setToday] = useState<TodayMedicationResponse | null>(null);
  const [adherence, setAdherence] = useState<MedicationAdherenceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatingIntake, setUpdatingIntake] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedMedication, setSelectedMedication] = useState<MedicationRecord | null>(null);
  const [showMedicationDetails, setShowMedicationDetails] = useState(false);

  const medsById = useMemo(
    () =>
      Object.fromEntries(
        medications.map((m) => [String(m.id ?? m._id), m])
      ) as Record<string, MedicationRecord>,
    [medications]
  );

  const syncPendingIntakes = useCallback(async () => {
    const pending = getPendingMedicationIntakes();
    if (pending.length === 0) return 0;

    let synced = 0;
    for (const item of pending) {
      try {
        await confirmMedicationIntake(item.intake_id, {
          status: item.status,
          note: item.note ?? undefined,
        });
        deletePendingMedicationIntake(item.local_id);
        synced += 1;
      } catch {
        break;
      }
    }
    return synced;
  }, []);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const synced = await syncPendingIntakes();
      if (synced > 0) {
        setNotice(`Synced ${synced} offline medication update${synced > 1 ? 's' : ''}.`);
      }
      const [myMeds, todayData, adherenceData] = await Promise.all([
        getMyMedications(),
        getTodayMedications(),
        getMedicationAdherence({ period_days: 28 }),
      ]);
      setMedications(myMeds);
      setToday(todayData);
      setAdherence(adherenceData);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load medications');
    } finally {
      setLoading(false);
    }
  }, [syncPendingIntakes]);

  useEffect(() => {
    initDB();
    loadData();
  }, [loadData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  const handleConfirm = useCallback(
    async (item: TodayMedicationSlotItem, status: 'taken' | 'skipped') => {
      if (!today) return;
      setNotice(null);
      setUpdatingIntake(item.intake_id);

      const nextSlots = patchSlotStatus(today.slots, item.intake_id, status);
      setToday({
        ...today,
        slots: nextSlots,
        summary: summarizeSlots(nextSlots),
      });

      try {
        await confirmMedicationIntake(item.intake_id, { status });
        const nextAdherence = await getMedicationAdherence({ period_days: 28 });
        setAdherence(nextAdherence);
      } catch {
        queueMedicationIntake({ intake_id: item.intake_id, status });
        setNotice('Saved offline. This update will sync when network is available.');
      } finally {
        setUpdatingIntake(null);
      }
    },
    [today]
  );

  const handleOpenDetails = useCallback(
    (item: TodayMedicationSlotItem) => {
      const medicationId = item.medication.id;
      setSelectedMedication(medsById[medicationId] ?? null);
      setShowMedicationDetails(true);
    },
    [medsById]
  );

  const scheduleDailyReminders = useCallback(async () => {
    if (!today) return;

    if (Platform.OS === 'web') {
      setNotice('Reminder scheduling is only available on mobile devices.');
      return;
    }

    const existing = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      existing
        .filter((item) => item.content.data?.kind === 'medication-reminder')
        .map((item) => Notifications.cancelScheduledNotificationAsync(item.identifier))
    );

    const permission = await Notifications.getPermissionsAsync();
    let granted = permission.granted || permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    if (!granted) {
      const requested = await Notifications.requestPermissionsAsync();
      granted = requested.granted || requested.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    }
    if (!granted) {
      setNotice('Notifications permission is required for reminders.');
      return;
    }

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('medication-reminders', {
        name: 'Medication reminders',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }

    let scheduled = 0;
    for (const slot of Object.keys(SLOT_META) as SlotKey[]) {
      const items = today.slots[slot];
      if (items.length === 0) continue;

      const meta = SLOT_META[slot];
      await Notifications.scheduleNotificationAsync({
        content: {
          title: `${meta.icon} Medication reminder`,
          body: `You have ${items.length} medication ${items.length === 1 ? 'dose' : 'doses'} for ${meta.label.toLowerCase()}.`,
          data: { kind: 'medication-reminder', slot },
          sound: true,
        },
        trigger: {
          hour: meta.hour,
          minute: meta.minute,
          repeats: true,
          channelId: Platform.OS === 'android' ? 'medication-reminders' : undefined,
        } as Notifications.NotificationTriggerInput,
      });
      scheduled += 1;
    }

    setNotice(
      scheduled > 0
        ? `Scheduled ${scheduled} daily reminder${scheduled > 1 ? 's' : ''}.`
        : 'No reminders scheduled because no doses are planned for today.'
    );
  }, [today]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'My Medications' }} />

      {loading ? (
        <ActivityIndicator color={E.colors.primary} size="large" style={styles.loader} />
      ) : (
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

          {notice ? (
            <View style={styles.noticeBanner}>
              <Text style={styles.noticeText}>{notice}</Text>
            </View>
          ) : null}

          <View style={styles.summaryCard}>
            <Text style={styles.summaryTitle}>💊 Medication overview</Text>
            <Text style={styles.summaryText}>Active medications: {medications.length}</Text>
            <Text style={styles.summaryText}>Today: {today?.summary.taken ?? 0} taken / {today?.summary.total ?? 0} total</Text>
            <TouchableOpacity style={styles.reminderButton} onPress={scheduleDailyReminders}>
              <Text style={styles.reminderText}>🔔 Schedule daily reminders</Text>
            </TouchableOpacity>
          </View>

          {adherence ? <AdherenceHeatmap days={adherence.days} overallRate={adherence.overall_rate} /> : null}

          {(Object.keys(SLOT_META) as SlotKey[]).map((slot) => {
            const items = today?.slots[slot] ?? [];
            const meta = SLOT_META[slot];
            return (
              <View key={slot} style={styles.slotSection}>
                <View style={styles.slotHeader}>
                  <Text style={styles.slotTitle}>{meta.icon} {meta.label}</Text>
                  <Text style={styles.slotCount}>{items.length}</Text>
                </View>
                {items.length === 0 ? (
                  <View style={styles.emptySlot}>
                    <Text style={styles.emptySlotText}>No medications for this slot.</Text>
                  </View>
                ) : (
                  <View style={styles.cards}>
                    {items.map((item) => (
                      <DailySlotCard
                        key={item.intake_id}
                        item={item}
                        onOpenDetails={handleOpenDetails}
                        onConfirm={handleConfirm}
                        isUpdating={updatingIntake === item.intake_id}
                      />
                    ))}
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}

      <MedicationDetailModal
        visible={showMedicationDetails}
        medication={selectedMedication}
        onClose={() => setShowMedicationDetails(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: E.colors.bg,
  },
  loader: {
    flex: 1,
    marginTop: 40,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: E.padSm,
    gap: 12,
    paddingBottom: 40,
  },
  summaryCard: {
    backgroundColor: E.colors.surface,
    borderWidth: 1,
    borderColor: E.colors.border,
    borderRadius: E.radius,
    padding: E.padSm,
    gap: 6,
  },
  summaryTitle: {
    ...ET.h3,
  },
  summaryText: {
    ...ET.body,
  },
  reminderButton: {
    marginTop: 6,
    borderRadius: E.radiusSm,
    backgroundColor: E.colors.primaryLight,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reminderText: {
    ...ET.bodyBold,
    color: E.colors.primaryDark,
  },
  slotSection: {
    gap: 8,
  },
  slotHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  slotTitle: {
    ...ET.bodyBold,
  },
  slotCount: {
    ...ET.small,
    color: E.colors.textSecondary,
    fontWeight: '700',
  },
  cards: {
    gap: 8,
  },
  emptySlot: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: E.colors.border,
    borderRadius: E.radiusSm,
    padding: E.padSm,
    backgroundColor: E.colors.surfaceAlt,
  },
  emptySlotText: {
    ...ET.small,
    color: E.colors.textSecondary,
  },
  errorBanner: {
    backgroundColor: E.colors.dangerLight,
    borderRadius: E.radiusSm,
    padding: E.padSm,
  },
  errorText: {
    ...ET.body,
    color: E.colors.danger,
  },
  noticeBanner: {
    backgroundColor: E.colors.warningLight,
    borderRadius: E.radiusSm,
    padding: E.padSm,
  },
  noticeText: {
    ...ET.body,
    color: E.colors.warning,
  },
});
