/**
 * EHR Messages Screen
 * Location: mobile/app/(app)/ehr/messages.tsx
 *
 * Two modes:
 *   • No params        → Conversations list (fetched from /api/messages/conversations)
 *   • other_user_id    → Full chat thread with that user
 *
 * Fixes vs previous version:
 *  1. ChatThread now uses getMessages() (generic /api/messages/<id>) instead of
 *     getMessageThread() which was a doctor-only proxied endpoint — patients were
 *     getting 403s.
 *  2. Patients can start new conversations via a "+" button that shows their
 *     authorized doctors.
 *  3. Conversation list shows "Dr." prefix and role badge.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  StyleSheet,
  Platform,
  KeyboardAvoidingView,
  Modal,
  FlatList,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

// ✅ FIX: use the generic getMessages() — works for both patients and doctors.
// getMessageThread() was an alias for getPatientMessages() which hits the
// doctor-proxied endpoint and returns 403 for patients.
import { getMessages, sendMessage, type MessageResponse } from '@/services/api/ehr';
import { apiClient } from '@/services/api/client';
import { useAuthStore } from '@/store/auth.store';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ConversationSummary {
  other_user_id:   string;
  other_user_name: string;
  other_user_type: string;
  last_message:    string;
  last_message_at: string;
  unread_count:    number;
}

interface AuthorizedDoctor {
  id:        string;
  firstName: string;
  lastName:  string;
  email:     string;
}

const SCROLL_DELAY_MS = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Helper — format display name with role prefix
// ─────────────────────────────────────────────────────────────────────────────

function displayName(name: string, userType: string): string {
  if (userType === 'doctor' && !name.startsWith('Dr.')) {
    return `Dr. ${name}`;
  }
  return name;
}

function formatTime(isoString: string): string {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    const now = new Date();
    const isToday =
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear();
    if (isToday) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return isoString.slice(0, 10);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// New Conversation Modal (patient only)
// ─────────────────────────────────────────────────────────────────────────────

function NewConversationModal({
  visible,
  onClose,
  onSelect,
}: {
  visible:  boolean;
  onClose:  () => void;
  onSelect: (doctor: AuthorizedDoctor) => void;
}) {
  const [doctors, setDoctors]   = useState<AuthorizedDoctor[]>([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setError(null);
    apiClient
      .get<AuthorizedDoctor[]>('/api/patient/authorized-doctors')
      .then((res) => setDoctors(res.data))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Failed to load doctors')
      )
      .finally(() => setLoading(false));
  }, [visible]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={modal.safe}>
        {/* Header */}
        <View style={modal.header}>
          <Text style={modal.title}>New Message</Text>
          <TouchableOpacity onPress={onClose} style={modal.closeBtn}>
            <Text style={modal.closeText}>✕</Text>
          </TouchableOpacity>
        </View>

        <Text style={modal.subtitle}>Select a doctor to message</Text>

        {loading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
        ) : error ? (
          <Text style={modal.error}>⚠️ {error}</Text>
        ) : doctors.length === 0 ? (
          <View style={modal.empty}>
            <Text style={modal.emptyIcon}>👨‍⚕️</Text>
            <Text style={modal.emptyTitle}>No authorized doctors</Text>
            <Text style={modal.emptyBody}>
              Go to Profile → Manage My Doctors to authorize a doctor first.
            </Text>
          </View>
        ) : (
          <FlatList
            data={doctors}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ padding: spacing.md }}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={modal.doctorRow}
                onPress={() => onSelect(item)}
                activeOpacity={0.7}
              >
                <View style={modal.avatar}>
                  <Text style={modal.avatarText}>
                    {item.firstName[0]}{item.lastName[0]}
                  </Text>
                </View>
                <View style={modal.doctorInfo}>
                  <Text style={modal.doctorName}>
                    Dr. {item.firstName} {item.lastName}
                  </Text>
                  <Text style={modal.doctorEmail}>{item.email}</Text>
                </View>
                <Text style={modal.chevron}>›</Text>
              </TouchableOpacity>
            )}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

const modal = StyleSheet.create({
  safe:       { flex: 1, backgroundColor: colors.background },
  header:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border,
                backgroundColor: colors.surface },
  title:      { ...typography.h3, color: colors.text.primary },
  closeBtn:   { padding: spacing.xs },
  closeText:  { fontSize: 18, color: colors.text.secondary },
  subtitle:   { ...typography.body, color: colors.text.secondary,
                paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: spacing.sm },
  error:      { ...typography.body, color: colors.danger, textAlign: 'center', margin: spacing.xl },
  empty:      { alignItems: 'center', paddingTop: 60, paddingHorizontal: spacing.xl, gap: 12 },
  emptyIcon:  { fontSize: 48 },
  emptyTitle: { ...typography.h3, color: colors.text.primary, textAlign: 'center' },
  emptyBody:  { ...typography.body, color: colors.text.secondary, textAlign: 'center' },
  doctorRow:  { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
                borderRadius: borderRadius.md, borderWidth: 1, borderColor: colors.border,
                padding: spacing.md, marginBottom: spacing.sm, gap: spacing.md },
  avatar:     { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.primary,
                justifyContent: 'center', alignItems: 'center', flexShrink: 0 },
  avatarText: { ...typography.body, color: colors.surface, fontWeight: '700' },
  doctorInfo: { flex: 1 },
  doctorName: { ...typography.body, color: colors.text.primary, fontWeight: '600' },
  doctorEmail:{ ...typography.small, color: colors.text.secondary },
  chevron:    { fontSize: 24, color: colors.text.disabled },
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversations list (shown when no other_user_id param)
// ─────────────────────────────────────────────────────────────────────────────

function ConversationsList() {
  const router  = useRouter();
  const { user } = useAuthStore();
  const isPatient = user?.user_type === 'patient';

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading]             = useState(true);
  const [refreshing, setRefreshing]       = useState(false);
  const [error, setError]                 = useState<string | null>(null);
  const [showNewModal, setShowNewModal]   = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await apiClient.get<ConversationSummary[]>('/api/messages/conversations');
      setConversations(res.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load conversations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const openThread = (conv: ConversationSummary) => {
    router.push({
      pathname: '/(app)/ehr/messages' as any,
      params: {
        other_user_id:   conv.other_user_id,
        other_user_name: conv.other_user_name,
        other_user_type: conv.other_user_type,
      },
    });
  };

  const handleSelectDoctor = (doctor: AuthorizedDoctor) => {
    setShowNewModal(false);
    router.push({
      pathname: '/(app)/ehr/messages' as any,
      params: {
        other_user_id:   doctor.id,
        other_user_name: `${doctor.firstName} ${doctor.lastName}`,
        other_user_type: 'doctor',
      },
    });
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen
        options={{
          title: 'Messages',
          headerRight: isPatient
            ? () => (
                <TouchableOpacity
                  onPress={() => setShowNewModal(true)}
                  style={styles.newMsgBtn}
                >
                  <Text style={styles.newMsgBtnText}>✉️ New</Text>
                </TouchableOpacity>
              )
            : undefined,
        }}
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} />
        }
      >
        {loading ? (
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        ) : error ? (
          <Text style={styles.errorText}>⚠️ {error}</Text>
        ) : conversations.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyIcon}>💬</Text>
            <Text style={styles.emptyTitle}>No conversations yet</Text>
            <Text style={styles.emptyBody}>
              {isPatient
                ? 'Tap "New" above to message one of your authorized doctors.'
                : 'When a patient messages you, the thread will appear here.'}
            </Text>
            {isPatient && (
              <TouchableOpacity
                style={styles.newMsgFab}
                onPress={() => setShowNewModal(true)}
              >
                <Text style={styles.newMsgFabText}>✉️  Message a Doctor</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <>
            {conversations.map((conv) => {
              const name = displayName(conv.other_user_name, conv.other_user_type);
              const isDoctor = conv.other_user_type === 'doctor';
              return (
                <TouchableOpacity
                  key={conv.other_user_id}
                  style={styles.convRow}
                  onPress={() => openThread(conv)}
                  activeOpacity={0.7}
                >
                  {/* Avatar */}
                  <View style={[styles.avatar, isDoctor && styles.avatarDoctor]}>
                    <Text style={styles.avatarText}>
                      {conv.other_user_name.charAt(0).toUpperCase()}
                    </Text>
                  </View>

                  {/* Info */}
                  <View style={styles.convInfo}>
                    <View style={styles.convHeader}>
                      <View style={styles.convNameRow}>
                        <Text style={styles.convName} numberOfLines={1}>
                          {name}
                        </Text>
                        {isDoctor && (
                          <View style={styles.roleBadge}>
                            <Text style={styles.roleBadgeText}>Doctor</Text>
                          </View>
                        )}
                      </View>
                      <Text style={styles.convTime}>
                        {formatTime(conv.last_message_at)}
                      </Text>
                    </View>
                    <View style={styles.convFooter}>
                      <Text style={styles.convPreview} numberOfLines={1}>
                        {conv.last_message || '(no messages yet)'}
                      </Text>
                      {conv.unread_count > 0 && (
                        <View style={styles.badge}>
                          <Text style={styles.badgeText}>{conv.unread_count}</Text>
                        </View>
                      )}
                    </View>
                  </View>
                </TouchableOpacity>
              );
            })}

            {/* Floating "New" button for patients with existing conversations */}
            {isPatient && (
              <TouchableOpacity
                style={styles.newMsgFab}
                onPress={() => setShowNewModal(true)}
              >
                <Text style={styles.newMsgFabText}>✉️  Message a Doctor</Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </ScrollView>

      {/* New conversation modal — patients only */}
      <NewConversationModal
        visible={showNewModal}
        onClose={() => setShowNewModal(false)}
        onSelect={handleSelectDoctor}
      />
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat thread (shown when other_user_id param is present)
// ─────────────────────────────────────────────────────────────────────────────

function ChatThread({
  other_user_id,
  other_user_name,
  other_user_type,
}: {
  other_user_id:   string;
  other_user_name: string;
  other_user_type: string;
}) {
  const scrollViewRef = useRef<ScrollView>(null);
  const [messages, setMessages]     = useState<MessageResponse[]>([]);
  const [isLoading, setIsLoading]   = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [input, setInput]           = useState('');
  const [sending, setSending]       = useState(false);

  const { user } = useAuthStore();

  // ✅ FIX: use getMessages() — generic /api/messages/<other_user_id>
  // This works for BOTH patients and doctors.
  // The old getMessageThread() alias pointed to the doctor-only proxied
  // endpoint which returned 403 for patients.
  const loadThread = useCallback(async () => {
    try {
      setError(null);
      const data = await getMessages(other_user_id);
      setMessages(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load messages');
    } finally {
      setIsLoading(false);
    }
  }, [other_user_id]);

  useEffect(() => {
    setIsLoading(true);
    loadThread();
  }, [loadThread]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadThread();
    setRefreshing(false);
  }, [loadThread]);

  const handleSend = useCallback(async () => {
    const body = input.trim();
    if (!body || sending) return;
    try {
      setSending(true);
      setError(null);
      await sendMessage(other_user_id, body);
      setInput('');
      await loadThread();
      setTimeout(
        () => scrollViewRef.current?.scrollToEnd({ animated: true }),
        SCROLL_DELAY_MS
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  }, [input, sending, other_user_id, loadThread]);

  const threadTitle = displayName(other_user_name, other_user_type);

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: threadTitle }} />
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        {/* Thread header showing who this conversation is with */}
        <View style={styles.threadHeader}>
          <View style={styles.threadHeaderAvatar}>
            <Text style={styles.threadHeaderAvatarText}>
              {other_user_name.charAt(0).toUpperCase()}
            </Text>
          </View>
          <View>
            <Text style={styles.threadHeaderName}>{threadTitle}</Text>
            <Text style={styles.threadHeaderRole}>
              {other_user_type === 'doctor' ? '👨‍⚕️ Doctor' : '🧑 Patient'}
            </Text>
          </View>
        </View>

        <ScrollView
          ref={scrollViewRef}
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} />
          }
          onContentSizeChange={() =>
            scrollViewRef.current?.scrollToEnd({ animated: false })
          }
        >
          {isLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.loader} />
          ) : error ? (
            <Text style={styles.errorText}>⚠️ {error}</Text>
          ) : messages.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyIcon}>💬</Text>
              <Text style={styles.emptyBody}>
                No messages yet. Send a message to {threadTitle}.
              </Text>
            </View>
          ) : (
            messages.map((msg, index) => {
              // Use sender_type vs the current user's role to decide alignment.
              // user._id is not stored in the auth store (only userType/name/token
              // come back from the login response), so comparing IDs always returned
              // false and placed every bubble on the "other" side.
              // auth store stores the role as user_type (snake_case) — confirmed by
              // profile.tsx using user?.user_type. Using userType (camelCase) was
              // always undefined, making isSelf always false → all bubbles on left.
              const isSelf = msg.sender_type === user?.user_type;
              const timeStr = formatTime(msg.created_at);
              return (
                <View
                  key={msg.id ?? index}
                  style={[
                    styles.bubble,
                    isSelf ? styles.bubbleSelf : styles.bubbleOther,
                  ]}
                >
                  <Text style={[styles.bubbleBody, isSelf && styles.bubbleBodySelf]}>
                    {msg.body}
                  </Text>
                  <Text style={[styles.bubbleTime, isSelf && styles.bubbleTimeSelf]}>
                    {timeStr}
                  </Text>
                </View>
              );
            })
          )}
        </ScrollView>

        {/* Compose area */}
        <View style={styles.composeRow}>
          <TextInput
            style={styles.composeInput}
            placeholder={`Message ${threadTitle}…`}
            placeholderTextColor={colors.text.secondary}
            value={input}
            onChangeText={setInput}
            multiline
          />
          <TouchableOpacity
            style={[
              styles.sendButton,
              (!input.trim() || sending) && styles.sendButtonDisabled,
            ]}
            onPress={handleSend}
            disabled={!input.trim() || sending}
          >
            {sending ? (
              <ActivityIndicator color={colors.surface} size="small" />
            ) : (
              <Text style={styles.sendButtonText}>Send</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Root export — routes to sub-component based on params
// ─────────────────────────────────────────────────────────────────────────────

export default function MessagesScreen() {
  const { other_user_id, other_user_name, other_user_type } = useLocalSearchParams<{
    other_user_id?:   string;
    other_user_name?: string;
    other_user_type?: string;
  }>();

  if (other_user_id) {
    return (
      <ChatThread
        other_user_id={other_user_id}
        other_user_name={other_user_name ?? 'Messages'}
        other_user_type={other_user_type ?? ''}
      />
    );
  }

  return <ConversationsList />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  keyboardView:  { flex: 1 },
  scrollView:    { flex: 1 },
  scrollContent: { padding: spacing.md, paddingBottom: spacing.xl },
  loader:        { marginTop: spacing.xl },
  errorText: {
    ...typography.body,
    color: colors.danger,
    textAlign: 'center',
    marginTop: spacing.xl,
  },

  // ── Header button ──
  newMsgBtn: {
    marginRight: spacing.sm,
    padding: spacing.xs,
  },
  newMsgBtnText: {
    ...typography.body,
    color: colors.primary,
    fontWeight: '600',
  },

  // ── Conversations list ──
  emptyContainer: {
    alignItems: 'center',
    paddingTop: 80,
    gap: 12,
  },
  emptyIcon: { fontSize: 56 },
  emptyTitle: {
    ...typography.h3,
    color: colors.text.primary,
    textAlign: 'center',
  },
  emptyBody: {
    ...typography.body,
    color: colors.text.secondary,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
  },
  newMsgFab: {
    marginTop: spacing.lg,
    backgroundColor: colors.primary,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    alignSelf: 'center',
    alignItems: 'center',
  },
  newMsgFabText: {
    ...typography.body,
    color: colors.surface,
    fontWeight: '600',
  },
  convRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.md,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  avatarDoctor: {
    backgroundColor: colors.secondary ?? colors.primary,
    borderWidth: 2,
    borderColor: colors.primary,
  },
  avatarText: {
    ...typography.h3,
    color: colors.surface,
    fontWeight: '700',
  },
  convInfo:   { flex: 1, gap: 4 },
  convHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  convNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: spacing.xs,
    flexWrap: 'wrap',
  },
  convName: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '600',
    flexShrink: 1,
  },
  roleBadge: {
    backgroundColor: colors.primary + '20',
    borderRadius: borderRadius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  roleBadgeText: {
    ...typography.small,
    color: colors.primary,
    fontWeight: '600',
    fontSize: 10,
  },
  convTime: {
    ...typography.small,
    color: colors.text.secondary,
    marginLeft: spacing.sm,
    flexShrink: 0,
  },
  convFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  convPreview: {
    ...typography.small,
    color: colors.text.secondary,
    flex: 1,
  },
  badge: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
    marginLeft: spacing.sm,
    flexShrink: 0,
  },
  badgeText: {
    color: colors.surface,
    fontWeight: '700',
    fontSize: 11,
  },

  // ── Thread header ──
  threadHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  threadHeaderAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  threadHeaderAvatarText: {
    ...typography.body,
    color: colors.surface,
    fontWeight: '700',
  },
  threadHeaderName: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '600',
  },
  threadHeaderRole: {
    ...typography.small,
    color: colors.text.secondary,
  },

  // ── Chat bubbles ──
  bubble: {
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    maxWidth: '80%',
  },
  bubbleSelf: {
    alignSelf: 'flex-end',
    backgroundColor: colors.primary,
  },
  bubbleOther: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  bubbleBody:     { ...typography.body, color: colors.text.primary },
  bubbleBodySelf: { color: colors.surface },
  bubbleTime: {
    ...typography.small,
    color: colors.text.secondary,
    marginTop: spacing.xs,
  },
  bubbleTimeSelf: { color: colors.surface, opacity: 0.8 },

  // ── Compose ──
  composeRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  composeInput: {
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
  sendButtonDisabled: { opacity: 0.5 },
  sendButtonText: {
    ...typography.body,
    color: colors.surface,
    fontWeight: '600',
  },
});