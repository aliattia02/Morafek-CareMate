/**
 * EHR Exercises Screen
 * Location: mobile/app/(app)/ehr/exercises.tsx
 *
 * Displays the exercise plan assigned by the patient's doctor.
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  Linking,
} from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { apiClient } from '@/services/api/client';
import { API } from '@/services/api/endpoints';
import { E, ET } from '@/constants/elderlyTheme';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ExerciseCategory = 'mobility' | 'strength' | 'balance' | 'breathing' | 'other';

interface Exercise {
  id: string;
  title: string;
  description: string;
  category: ExerciseCategory;
  frequency: string;
  duration_minutes?: number;
  repetitions?: number;
  sets?: number;
  video_url?: string;
  image_url?: string;
  notes?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<ExerciseCategory, string> = {
  mobility:  '#1565C0',
  strength:  '#2E7D32',
  balance:   '#E65100',
  breathing: '#00695C',
  other:     '#757575',
};

const CATEGORY_LABELS: Record<ExerciseCategory, string> = {
  mobility:  'Mobility',
  strength:  'Strength',
  balance:   'Balance',
  breathing: 'Breathing',
  other:     'Other',
};

// ─────────────────────────────────────────────────────────────────────────────
// Exercise Card
// ─────────────────────────────────────────────────────────────────────────────

function ExerciseCard({ exercise }: { exercise: Exercise }) {
  const [done, setDone] = useState(false);

  const categoryColor = CATEGORY_COLORS[exercise.category] ?? CATEGORY_COLORS.other;
  const categoryLabel = CATEGORY_LABELS[exercise.category] ?? 'Other';

  const handleWatchVideo = () => {
    if (exercise.video_url) {
      Linking.openURL(exercise.video_url);
    }
  };

  return (
    <View style={styles.card}>
      {/* Top row: category badge */}
      <View style={[styles.categoryBadge, { backgroundColor: categoryColor }]}>
        <Text style={[ET.small, styles.badgeText]}>{categoryLabel}</Text>
      </View>

      {/* Title */}
      <Text style={[ET.h2, styles.exerciseTitle]}>{exercise.title}</Text>

      {/* Description */}
      <Text style={ET.body}>{exercise.description}</Text>

      {/* Details row */}
      <View style={styles.detailsRow}>
        <Text style={[ET.body, styles.detailItem]}>🕐 {exercise.frequency}</Text>
        {exercise.duration_minutes != null && (
          <Text style={[ET.body, styles.detailItem]}>⏱ {exercise.duration_minutes} min</Text>
        )}
        {exercise.repetitions != null && exercise.sets != null && (
          <Text style={[ET.body, styles.detailItem]}>
            🔄 {exercise.repetitions}×{exercise.sets}
          </Text>
        )}
      </View>

      {/* Video button */}
      {exercise.video_url && (
        <TouchableOpacity
          style={styles.videoButton}
          onPress={handleWatchVideo}
          accessibilityRole="button"
          accessibilityLabel="Watch exercise video"
        >
          <Text style={ET.btnPrimary}>▶️  Watch Video</Text>
        </TouchableOpacity>
      )}

      {/* Image */}
      {exercise.image_url && (
        <Image
          source={{ uri: exercise.image_url }}
          style={styles.exerciseImage}
          resizeMode="cover"
          accessibilityRole="image"
          accessibilityLabel={`Image for ${exercise.title}`}
        />
      )}

      {/* Notes */}
      {exercise.notes ? (
        <View style={styles.notesSection}>
          <Text style={ET.label}>{"📝 Doctor's notes:"}</Text>
          <View style={styles.notesBox}>
            <Text style={ET.body}>{exercise.notes}</Text>
          </View>
        </View>
      ) : null}

      {/* Mark as Done */}
      <TouchableOpacity
        style={[styles.doneButton, done && styles.doneButtonActive]}
        onPress={() => setDone((prev) => !prev)}
        accessibilityRole="checkbox"
        accessibilityLabel="Toggle exercise completion status"
        accessibilityState={{ checked: done }}
      >
        <Text style={[ET.bodyBold, done ? styles.doneButtonTextActive : styles.doneButtonText]}>
          {done ? '✅  Done!' : '✅  Mark as Done'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function ExercisesScreen() {
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const response = await apiClient.get<Exercise[]>(API.EHR.EXERCISES);
        setExercises(response.data);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to load exercises');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'My Exercises' }} />

      {loading ? (
        <ActivityIndicator
          color={E.colors.primary}
          size="large"
          style={styles.loader}
        />
      ) : error ? (
        <View style={styles.errorContainer}>
          <Text style={[ET.body, styles.errorText]}>⚠️ {error}</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
        >
          {/* Header card */}
          <View style={styles.headerCard}>
            <Text style={ET.h2}>🏋️  My Exercise Plan</Text>
            <Text style={[ET.body, styles.headerSubtitle]}>
              {exercises.length} exercises assigned by your doctor
            </Text>
          </View>

          {exercises.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyIllustration}>🏃</Text>
              <Text style={[ET.h3, styles.emptyTitle]}>No exercises assigned yet</Text>
              <Text style={[ET.body, styles.emptyBody]}>
                Your doctor will add exercises to your plan
              </Text>
            </View>
          ) : (
            exercises.map((ex) => <ExerciseCard key={ex.id} exercise={ex} />)
          )}
        </ScrollView>
      )}
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
  loader: {
    flex: 1,
    marginTop: 40,
  },
  errorContainer: {
    flex: 1,
    padding: E.pad,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    color: E.colors.danger,
    textAlign: 'center',
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: E.pad,
    paddingBottom: 40,
    gap: 16,
  },

  // Header card
  headerCard: {
    backgroundColor: E.colors.surfaceAlt,
    borderRadius: E.radius,
    padding: E.pad,
    gap: 6,
  },
  headerSubtitle: {
    color: E.colors.textSecondary,
  },

  // Exercise card
  card: {
    backgroundColor: E.colors.surface,
    borderRadius: E.radius,
    padding: E.pad,
    gap: 12,
    borderWidth: 1,
    borderColor: E.colors.divider,
  },
  categoryBadge: {
    alignSelf: 'flex-start',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  badgeText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  exerciseTitle: {
    fontWeight: 'bold',
  },
  detailsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  detailItem: {
    color: E.colors.textPrimary,
  },

  // Video button
  videoButton: {
    height: 56,
    backgroundColor: E.colors.primary,
    borderRadius: E.radius,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Exercise image
  exerciseImage: {
    height: 200,
    borderRadius: E.radius,
    width: '100%',
  },

  // Notes
  notesSection: {
    gap: 6,
  },
  notesBox: {
    backgroundColor: E.colors.surfaceAlt,
    padding: 12,
    borderRadius: 8,
  },

  // Done button
  doneButton: {
    height: E.tap,
    backgroundColor: E.colors.successLight,
    borderRadius: E.radius,
    borderWidth: 1,
    borderColor: E.colors.success,
    justifyContent: 'center',
    alignItems: 'center',
  },
  doneButtonActive: {
    backgroundColor: E.colors.success,
    borderColor: E.colors.success,
  },
  doneButtonText: {
    color: E.colors.success,
  },
  doneButtonTextActive: {
    color: '#FFFFFF',
  },

  // Empty state
  emptyContainer: {
    alignItems: 'center',
    paddingTop: 60,
    gap: 12,
  },
  emptyIllustration: {
    fontSize: 64,
  },
  emptyTitle: {
    textAlign: 'center',
  },
  emptyBody: {
    color: E.colors.textSecondary,
    textAlign: 'center',
  },
});
