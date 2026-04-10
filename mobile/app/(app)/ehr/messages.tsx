/**
 * EHR Messages Screen
 * Location: mobile/app/(app)/ehr/messages.tsx
 *
 * Full-screen chat thread between the current user and another user.
 * Params (via useLocalSearchParams):
 *   - other_user_id   : string  – the counterpart's user ID
 *   - other_user_name : string  – display name shown in the header
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
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getMessageThread, sendMessage, type MessageResponse } from '@/services/api/ehr';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

export default function MessagesScreen() {
  const { other_user_id, other_user_name } = useLocalSearchParams<{
    other_user_id?: string;
    other_user_name?: string;
  }>();

  const [messages, setMessages] = useState<MessageResponse[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const scrollViewRef = useRef<ScrollView>(null);

  const loadThread = useCallback(async () => {
    if (!other_user_id) return;
    try {
      setError(null);
      const data = await getMessageThread(other_user_id);
      setMessages(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load messages';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [other_user_id]);

  useEffect(() => {
    if (other_user_id) {
      setIsLoading(true);
      loadThread();
    }
  }, [other_user_id, loadThread]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadThread();
    setRefreshing(false);
  }, [loadThread]);

  const handleSend = useCallback(async () => {
    const body = input.trim();
    if (!body || sending || !other_user_id) return;
    try {
      setSending(true);
      await sendMessage(other_user_id, body);
      setInput('');
      await loadThread();
      setTimeout(() => scrollViewRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to send message';
      setError(message);
    } finally {
      setSending(false);
    }
  }, [input, sending, other_user_id, loadThread]);

  // ── No params placeholder ──────────────────────────────────────────────────
  if (!other_user_id) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['bottom']}>
        <Stack.Screen options={{ title: 'Messages' }} />
        <View style={styles.placeholderContainer}>
          <Text style={styles.placeholderText}>Select a conversation</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Main chat view ─────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: other_user_name ?? 'Messages' }} />
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <ScrollView
          ref={scrollViewRef}
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[colors.primary]}
            />
          }
          onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: false })}
        >
          {isLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.loader} />
          ) : error ? (
            <Text style={styles.errorText}>⚠️ {error}</Text>
          ) : messages.length === 0 ? (
            <Text style={styles.emptyText}>No messages yet. Say hello!</Text>
          ) : (
            messages.map((msg, index) => {
              const isSelf = msg.sender_type === 'doctor';
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
                    {msg.created_at}
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
            placeholder="Type a message…"
            placeholderTextColor={colors.text.secondary}
            value={input}
            onChangeText={setInput}
            multiline
          />
          <TouchableOpacity
            style={[styles.sendButton, (!input.trim() || sending) && styles.sendButtonDisabled]}
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

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  keyboardView: {
    flex: 1,
  },
  placeholderContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: {
    ...typography.body,
    color: colors.text.secondary,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
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
  bubbleBody: {
    ...typography.body,
    color: colors.text.primary,
  },
  bubbleBodySelf: {
    color: colors.surface,
  },
  bubbleTime: {
    ...typography.small,
    color: colors.text.secondary,
    marginTop: spacing.xs,
  },
  bubbleTimeSelf: {
    color: colors.surface,
    opacity: 0.8,
  },
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
  sendButtonDisabled: {
    opacity: 0.5,
  },
  sendButtonText: {
    ...typography.body,
    color: colors.surface,
    fontWeight: '600',
  },
});
