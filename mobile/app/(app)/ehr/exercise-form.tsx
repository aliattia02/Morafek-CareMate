/**
 * Exercise Form Screen (Doctor only)
 * Location: mobile/app/(app)/ehr/exercise-form.tsx
 *
 * Allows a doctor to add or edit an exercise assigned to a patient.
 *
 * Params (via useLocalSearchParams):
 *   - patient_id   : string – the patient's user ID
 *   - patient_name : string – the patient's display name (used in header)
 *   - exercise_id  : string (optional) – if present, edits the existing exercise
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  TouchableOpacity,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, Input, Button } from '@/components/ui';
import { useAuthStore } from '@/store/auth.store';
import { apiClient } from '@/services/api/client';
import { API } from '@/services/api/endpoints';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ExerciseCategory = 'mobility' | 'strength' | 'balance' | 'breathing' | 'other';

interface CategoryTile {
  key: ExerciseCategory;
  emoji: string;
  label: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_TILES: CategoryTile[] = [
  { key: 'mobility',  emoji: '🦵', label: 'Mobility'  },
  { key: 'strength',  emoji: '💪', label: 'Strength'  },
  { key: 'balance',   emoji: '⚖️',  label: 'Balance'   },
  { key: 'breathing', emoji: '🫁', label: 'Breathing' },
  { key: 'other',     emoji: '🏃', label: 'Other'     },
];

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function ExerciseFormScreen() {
  const router = useRouter();
  const { user } = useAuthStore();
  const { patient_id, patient_name, exercise_id } = useLocalSearchParams<{
    patient_id?: string;
    patient_name?: string;
    exercise_id?: string;
  }>();

  const isEdit = Boolean(exercise_id);

  const [category, setCategory] = useState<ExerciseCategory | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [frequency, setFrequency] = useState('');
  const [duration, setDuration] = useState('');
  const [repetitions, setRepetitions] = useState('');
  const [sets, setSets] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [doctorNotes, setDoctorNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // Redirect non-doctors to home
  if (user?.user_type !== 'doctor') {
    router.replace('/');
    return null;
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!category) newErrors.category = 'Please select a category';
    if (!title.trim()) newErrors.title = 'Exercise title is required';
    if (!description.trim()) newErrors.description = 'Instructions are required';
    if (!frequency.trim()) newErrors.frequency = 'Frequency is required';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    if (!patient_id) {
      Alert.alert('Error', 'Missing patient ID');
      return;
    }
    try {
      setSubmitting(true);
      const payload = {
        category,
        title: title.trim(),
        description: description.trim(),
        frequency: frequency.trim(),
        duration_minutes: duration.trim() ? Number(duration.trim()) : undefined,
        repetitions: repetitions.trim() ? Number(repetitions.trim()) : undefined,
        sets: sets.trim() ? Number(sets.trim()) : undefined,
        video_url: videoUrl.trim() || undefined,
        notes: doctorNotes.trim() || undefined,
      };

      if (isEdit && exercise_id) {
        await apiClient.put(
          API.EHR.PATIENT_EXERCISE_BY_ID(patient_id, exercise_id),
          payload
        );
      } else {
        await apiClient.post(API.EHR.PATIENT_EXERCISES(patient_id), payload);
      }

      Alert.alert('Exercise saved', undefined, [{ text: 'OK', onPress: () => router.back() }]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save exercise';
      Alert.alert('Error', message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: isEdit ? 'Edit Exercise' : 'Add Exercise' }} />
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Card variant="elevated" padding="large" style={styles.card}>
            <Text style={styles.title}>{isEdit ? 'Edit Exercise' : 'Add Exercise'}</Text>
            {patient_name ? (
              <Text style={styles.subtitle}>Patient: {patient_name}</Text>
            ) : null}

            {/* Category picker */}
            <Text style={styles.fieldLabel}>
              Category <Text style={styles.required}>*</Text>
            </Text>
            <View style={styles.categoryGrid}>
              {CATEGORY_TILES.map((tile) => {
                const selected = category === tile.key;
                return (
                  <TouchableOpacity
                    key={tile.key}
                    style={[styles.categoryTile, selected && styles.categoryTileSelected]}
                    onPress={() => {
                      setCategory(tile.key);
                      setErrors((prev) => ({ ...prev, category: '' }));
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={tile.label}
                  >
                    <Text style={styles.categoryEmoji}>{tile.emoji}</Text>
                    <Text style={[styles.categoryLabel, selected && styles.categoryLabelSelected]}>
                      {tile.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {errors.category ? (
              <Text style={styles.errorText}>{errors.category}</Text>
            ) : null}

            <Input
              label="Exercise Title"
              value={title}
              onChangeText={(v) => {
                setTitle(v);
                setErrors((prev) => ({ ...prev, title: '' }));
              }}
              placeholder="e.g. Seated Leg Raises"
              error={errors.title}
              required
            />

            <Input
              label="Instructions"
              value={description}
              onChangeText={(v) => {
                setDescription(v);
                setErrors((prev) => ({ ...prev, description: '' }));
              }}
              placeholder="Step-by-step exercise instructions"
              error={errors.description}
              multiline
              numberOfLines={4}
              required
            />

            <Input
              label="Frequency"
              value={frequency}
              onChangeText={(v) => {
                setFrequency(v);
                setErrors((prev) => ({ ...prev, frequency: '' }));
              }}
              placeholder="e.g. 3 times daily"
              error={errors.frequency}
              required
            />

            <Input
              label="Duration (minutes)"
              value={duration}
              onChangeText={setDuration}
              placeholder="e.g. 10"
              keyboardType="numeric"
            />

            <Input
              label="Repetitions"
              value={repetitions}
              onChangeText={setRepetitions}
              placeholder="e.g. 15"
              keyboardType="numeric"
            />

            <Input
              label="Sets"
              value={sets}
              onChangeText={setSets}
              placeholder="e.g. 3"
              keyboardType="numeric"
            />

            <Input
              label="Video URL"
              value={videoUrl}
              onChangeText={setVideoUrl}
              placeholder="YouTube or other link"
              autoCapitalize="none"
              keyboardType="url"
            />

            <Input
              label="Doctor's Notes"
              value={doctorNotes}
              onChangeText={setDoctorNotes}
              placeholder="Additional notes for the patient (optional)"
              multiline
              numberOfLines={3}
            />

            <View style={styles.buttonRow}>
              <Button
                title="Save Exercise"
                onPress={handleSubmit}
                loading={submitting}
                fullWidth
              />
            </View>
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

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
  subtitle: {
    ...typography.body,
    color: colors.text.secondary,
    marginBottom: spacing.lg,
  },
  fieldLabel: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '600',
    marginBottom: spacing.sm,
    marginTop: spacing.sm,
  },
  required: {
    color: colors.danger,
  },
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  categoryTile: {
    width: '47%',
    height: 64,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  categoryTileSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  categoryEmoji: {
    fontSize: 22,
  },
  categoryLabel: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '500',
  },
  categoryLabelSelected: {
    color: colors.surface,
    fontWeight: '700',
  },
  errorText: {
    ...typography.small,
    color: colors.danger,
    marginBottom: spacing.sm,
  },
  buttonRow: {
    marginTop: spacing.md,
  },
});
