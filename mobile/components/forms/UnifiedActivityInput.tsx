/**
 * Unified Activity Input
 * Location: mobile/components/forms/UnifiedActivityInput.tsx
 *
 * Main Component: UnifiedActivityInput
 * Description: Activity tracking input with duration calculation and
 *              impact assessment for insulin dose adjustments
 *
 * Features:
 * - Activity level selection (1-5 intensity)
 * - Start/end time selection with UTC handling
 * - Duration calculation
 * - Impact coefficient application
 * - Multiple activity support
 * - Expected vs actual activity tracking
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Switch
} from 'react-native';
import { colors, spacing, borderRadius, typography } from '@/constants/theme';
import { ACTIVITY_LEVELS } from '@/constants';
import { TimeManager } from '@/utils/time';

export interface UnifiedActivity {
  level: number;
  duration: string;
  startTime: string; // ISO string in UTC
  endTime: string; // ISO string in UTC
  impact: number;
  notes?: string;
  isExpected: boolean;
}

interface UnifiedActivityInputProps {
  onActivityUpdate: (activities: UnifiedActivity[], totalImpact: number) => void;
  initialActivities?: UnifiedActivity[];
  activityCoefficients: Record<string, number>;
  standalone?: boolean;
  showNotes?: boolean;
}

// Pure helper — computes total impact from a list of activities and coefficients.
// Used by addActivity / removeActivity to notify the parent with the correct
// value immediately, without relying on stale useMemo state.
function calcTotalImpactFrom(
  activities: UnifiedActivity[],
  activityCoefficients: Record<string, number>
): number {
  if (activities.length === 0) return 1.0;
  let total = 1.0;
  activities.forEach(activity => {
    const coefficient = activityCoefficients[activity.level.toString()] || 1.0;
    const [hours, minutes] = activity.duration.split(':').map(Number);
    const durationHours = hours + minutes / 60;
    const durationWeight = Math.min(durationHours / 2, 1);
    total *= 1.0 + ((coefficient - 1.0) * durationWeight);
  });
  return total;
}

const UnifiedActivityInput: React.FC<UnifiedActivityInputProps> = ({
  onActivityUpdate,
  initialActivities = [],
  activityCoefficients,
  standalone = false,
  showNotes = true,
}) => {
  const [activities, setActivities] = useState<UnifiedActivity[]>(initialActivities);
  const [showForm, setShowForm] = useState(false);

  // Current activity being edited
  const [currentActivity, setCurrentActivity] = useState<Partial<UnifiedActivity>>({
    level: 3,
    startTime: new Date().toISOString(),
    endTime: TimeManager.addHours(new Date(), 1).toISOString(), // 1 hour later
    impact: 1.0,
    notes: '',
    isExpected: false
  });

  // Time input states for current activity
  const [startHour, setStartHour] = useState('');
  const [startMinute, setStartMinute] = useState('');
  const [endHour, setEndHour] = useState('');
  const [endMinute, setEndMinute] = useState('');

  // Initialize time inputs when form opens
  useEffect(() => {
    if (showForm && currentActivity.startTime) {
      // Parse UTC timestamps to local time for display
      // parseTimestamp returns a number (milliseconds), so we need to create a Date object
      const startDate = new Date(TimeManager.parseTimestamp(currentActivity.startTime));
      const endDate = currentActivity.endTime
        ? new Date(TimeManager.parseTimestamp(currentActivity.endTime))
        : TimeManager.addHours(startDate, 1);

      setStartHour(startDate.getHours().toString().padStart(2, '0'));
      setStartMinute(startDate.getMinutes().toString().padStart(2, '0'));
      setEndHour(endDate.getHours().toString().padStart(2, '0'));
      setEndMinute(endDate.getMinutes().toString().padStart(2, '0'));
    }
  }, [showForm]);

  // Calculate total impact whenever activities change
  const totalImpact = useMemo(() => {
    if (activities.length === 0) return 1.0;

    let total = 1.0;
    activities.forEach(activity => {
      const coefficient = activityCoefficients[activity.level.toString()] || 1.0;

      // Parse duration (HH:MM format)
      const [hours, minutes] = activity.duration.split(':').map(Number);
      const durationHours = hours + minutes / 60;

      // Calculate weighted impact (max 2 hours)
      const durationWeight = Math.min(durationHours / 2, 1);
      const weightedImpact = 1.0 + ((coefficient - 1.0) * durationWeight);

      total *= weightedImpact;
    });

    return total;
  }, [activities, activityCoefficients]);

  const getActivityImpact = (level: number): number => {
    return activityCoefficients[level.toString()] || 1.0;
  };

  const handleTimeChange = (
    value: string,
    setter: React.Dispatch<React.SetStateAction<string>>,
    max: number
  ) => {
    if (value === '' || /^\d{1,2}$/.test(value)) {
      const num = parseInt(value) || 0;
      if (num <= max) {
        setter(value);
      }
    }
  };

  const updateTimeInputs = () => {
    const now = new Date();
    const newStartHour = parseInt(startHour) || 0;
    const newStartMinute = parseInt(startMinute) || 0;
    const newEndHour = parseInt(endHour) || 0;
    const newEndMinute = parseInt(endMinute) || 0;

    // Create local dates
    const startDate = new Date(now);
    startDate.setHours(newStartHour, newStartMinute, 0, 0);

    const endDate = new Date(now);
    endDate.setHours(newEndHour, newEndMinute, 0, 0);

    // If end is before start, assume it's the next day
    if (endDate <= startDate) {
      endDate.setDate(endDate.getDate() + 1);
    }

    // Convert to UTC for storage
    setCurrentActivity({
      ...currentActivity,
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString()
    });
  };

  const calculateCurrentDuration = (): string => {
    if (!currentActivity.startTime || !currentActivity.endTime) {
      return '01:00';
    }

    // Parse UTC times
    const start = TimeManager.parseTimestamp(currentActivity.startTime);
    const end = TimeManager.parseTimestamp(currentActivity.endTime);

    const durationResult = TimeManager.calculateDuration(start, end);

    // Format as HH:MM
    return `${durationResult.hours.toString().padStart(2, '0')}:${durationResult.minutes.toString().padStart(2, '0')}`;
  };

  const addActivity = () => {
    if (!currentActivity.level && currentActivity.level !== 0) {
      return;
    }

    updateTimeInputs();

    const duration = calculateCurrentDuration();
    const impact = getActivityImpact(currentActivity.level!);

    const newActivity: UnifiedActivity = {
      level: currentActivity.level!,
      duration,
      startTime: currentActivity.startTime!, // Already in UTC
      endTime: currentActivity.endTime!, // Already in UTC
      impact,
      notes: currentActivity.notes || '',
      isExpected: currentActivity.isExpected || false
    };

    const newActivities = [...activities, newActivity];
    setActivities(newActivities);
    setShowForm(false);

    // Notify parent — only fires when user explicitly confirms an activity
    const newTotalImpact = calcTotalImpactFrom(newActivities, activityCoefficients);
    onActivityUpdate(newActivities, newTotalImpact);

    // Reset form
    const now = new Date();
    const oneHourLater = TimeManager.addHours(now, 1);

    setCurrentActivity({
      level: 3,
      startTime: now.toISOString(),
      endTime: oneHourLater.toISOString(),
      impact: 1.0,
      notes: '',
      isExpected: false
    });

    setStartHour('');
    setStartMinute('');
    setEndHour('');
    setEndMinute('');
  };

  const removeActivity = (index: number) => {
    const newActivities = activities.filter((_, i) => i !== index);
    setActivities(newActivities);

    // Notify parent — fires when user explicitly removes an activity
    const newTotalImpact = calcTotalImpactFrom(newActivities, activityCoefficients);
    onActivityUpdate(newActivities, newTotalImpact);
  };

  // **UPDATED**: Format UTC time for display in local timezone
  const formatTime = (utcIsoString: string): string => {
    return TimeManager.formatTimeDisplay(utcIsoString);
  };

  const getTotalImpactDisplay = (): string => {
    const percentage = ((totalImpact - 1) * 100).toFixed(1);
    if (totalImpact === 1) return 'No change';
    return `${Math.abs(Number(percentage))}% ${totalImpact > 1 ? 'increase' : 'decrease'}`;
  };

  const getLevelLabel = (level: number): string => {
    const levelData = ACTIVITY_LEVELS.find(l => l.value === level);
    return levelData?.label || 'Unknown';
  };

  return (
    <View style={styles.container}>
      {standalone && (
      <View style={styles.header}>
        <Text style={styles.title}>Activities</Text>
        {activities.length > 0 && (
          <View style={[
            styles.impactBadge,
            totalImpact > 1 ? styles.impactIncrease :
            totalImpact < 1 ? styles.impactDecrease :
            styles.impactNeutral
          ]}>
            <Text style={styles.impactText}>{getTotalImpactDisplay()}</Text>
          </View>
        )}
      </View>
      )}

      {/* Activity List */}
      <ScrollView style={styles.activityList}>
        {activities.map((activity, index) => (
          <View key={index} style={[
            styles.activityItem,
            activity.isExpected && styles.activityItemExpected
          ]}>
            <View style={styles.activityInfo}>
              <View style={styles.activityHeader}>
                <Text style={styles.activityLevel}>
                  {getLevelLabel(activity.level)} (Level {activity.level})
                </Text>
                {activity.isExpected && (
                  <View style={styles.expectedBadge}>
                    <Text style={styles.expectedBadgeText}>Expected</Text>
                  </View>
                )}
              </View>

              <Text style={styles.activityDetails}>
                {activity.duration} • {formatTime(activity.startTime)} - {formatTime(activity.endTime)}
              </Text>

              <Text style={[
                styles.activityImpact,
                activity.impact > 1 ? styles.impactPositive :
                activity.impact < 1 ? styles.impactNegative :
                null
              ]}>
                Impact: {((activity.impact - 1) * 100).toFixed(0)}%
              </Text>

              {activity.notes && (
                <Text style={styles.activityNotes} numberOfLines={2}>
                  {activity.notes}
                </Text>
              )}
            </View>

            <TouchableOpacity
              onPress={() => removeActivity(index)}
              style={styles.removeButton}
            >
              <Text style={styles.removeButtonText}>✕</Text>
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>

      {/* Add Activity Button */}
      {!showForm && (
        <TouchableOpacity
          style={styles.addButton}
          onPress={() => setShowForm(true)}
        >
          <Text style={styles.addButtonText}>+ Add Activity</Text>
        </TouchableOpacity>
      )}

      {/* Activity Form */}
      {showForm && (
        <View style={styles.form}>
          {/* Activity Level */}
          <Text style={styles.formLabel}>Activity Level</Text>
          <View style={styles.levelSelector}>
            {ACTIVITY_LEVELS.map((level) => {
              const impact = getActivityImpact(level.value);
              const isSelected = currentActivity.level === level.value;

              return (
                <TouchableOpacity
                  key={level.value}
                  style={[
                    styles.levelButton,
                    isSelected && styles.levelButtonActive
                  ]}
                  onPress={() => setCurrentActivity({
                    ...currentActivity,
                    level: level.value
                  })}
                >
                  <Text style={[
                    styles.levelButtonLabel,
                    isSelected && styles.levelButtonLabelActive
                  ]}>
                    {level.label}
                  </Text>
                  <Text style={[
                    styles.levelButtonImpact,
                    isSelected && styles.levelButtonImpactActive
                  ]}>
                    {impact !== 1
                      ? `${Math.abs((impact - 1) * 100).toFixed(0)}% ${impact > 1 ? '↑' : '↓'}`
                      : 'neutral'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Time Inputs */}
          <Text style={[styles.formLabel, styles.formLabelSpacing]}>Time</Text>
          <View style={styles.timeContainer}>
            <View style={styles.timeSection}>
              <Text style={styles.timeLabel}>Start</Text>
              <View style={styles.timeInputs}>
                <TextInput
                  style={styles.timeInput}
                  value={startHour}
                  onChangeText={(text) => handleTimeChange(text, setStartHour, 23)}
                  onBlur={() => {
                    setStartHour(prev => prev.padStart(2, '0'));
                    updateTimeInputs();
                  }}
                  keyboardType="number-pad"
                  maxLength={2}
                  placeholder="HH"
                  placeholderTextColor={colors.text.secondary}
                  selectTextOnFocus
                />
                <Text style={styles.timeSeparator}>:</Text>
                <TextInput
                  style={styles.timeInput}
                  value={startMinute}
                  onChangeText={(text) => handleTimeChange(text, setStartMinute, 59)}
                  onBlur={() => {
                    setStartMinute(prev => prev.padStart(2, '0'));
                    updateTimeInputs();
                  }}
                  keyboardType="number-pad"
                  maxLength={2}
                  placeholder="MM"
                  placeholderTextColor={colors.text.secondary}
                  selectTextOnFocus
                />
              </View>
            </View>

            <View style={styles.timeSection}>
              <Text style={styles.timeLabel}>End</Text>
              <View style={styles.timeInputs}>
                <TextInput
                  style={styles.timeInput}
                  value={endHour}
                  onChangeText={(text) => handleTimeChange(text, setEndHour, 23)}
                  onBlur={() => {
                    setEndHour(prev => prev.padStart(2, '0'));
                    updateTimeInputs();
                  }}
                  keyboardType="number-pad"
                  maxLength={2}
                  placeholder="HH"
                  placeholderTextColor={colors.text.secondary}
                  selectTextOnFocus
                />
                <Text style={styles.timeSeparator}>:</Text>
                <TextInput
                  style={styles.timeInput}
                  value={endMinute}
                  onChangeText={(text) => handleTimeChange(text, setEndMinute, 59)}
                  onBlur={() => {
                    setEndMinute(prev => prev.padStart(2, '0'));
                    updateTimeInputs();
                  }}
                  keyboardType="number-pad"
                  maxLength={2}
                  placeholder="MM"
                  placeholderTextColor={colors.text.secondary}
                  selectTextOnFocus
                />
              </View>
            </View>
          </View>

          {/* Duration Display */}
          <View style={styles.durationDisplay}>
            <Text style={styles.durationText}>
              Duration: {calculateCurrentDuration()}
            </Text>
          </View>

          {/* Timezone Hint */}
          <Text style={styles.timezoneHint}>
            Times are in your local timezone ({TimeManager.getUserTimeZone()})
          </Text>

          {/* Expected Activity Toggle */}
          <View style={styles.expectedToggle}>
            <View style={styles.expectedToggleText}>
              <Text style={styles.formLabel}>This is an expected activity</Text>
              <Text style={styles.expectedHelp}>
                Mark as expected if this activity is planned (can be removed later if not done)
              </Text>
            </View>
            <Switch
              value={currentActivity.isExpected || false}
              onValueChange={(value) =>
                setCurrentActivity({ ...currentActivity, isExpected: value })
              }
              trackColor={{ false: colors.border, true: colors.primary + '40' }}
              thumbColor={currentActivity.isExpected ? colors.primary : colors.surface}
            />
          </View>

          {/* Notes — hidden when embedded (e.g. in MealForm) */}
          {showNotes && (
            <>
              <Text style={[styles.formLabel, styles.formLabelSpacing]}>
                Notes (Optional)
              </Text>
              <TextInput
                style={styles.notesInput}
                value={currentActivity.notes}
                onChangeText={(val) =>
                  setCurrentActivity({ ...currentActivity, notes: val })
                }
                placeholder="Add notes about this activity..."
                placeholderTextColor={colors.text.secondary}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
              />
            </>
          )}

          {/* Form Buttons */}
          <View style={styles.formButtons}>
            <TouchableOpacity
              style={[styles.button, styles.cancelButton]}
              onPress={() => setShowForm(false)}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.saveButton]}
              onPress={addActivity}
            >
              <Text style={styles.saveButtonText}>Add</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.md
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md
  },
  title: {
    ...typography.h3,
    color: colors.text.primary
  },
  impactBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full
  },
  impactIncrease: {
    backgroundColor: colors.success + '20'
  },
  impactDecrease: {
    backgroundColor: colors.danger + '20'
  },
  impactNeutral: {
    backgroundColor: colors.surfaceVariant
  },
  impactText: {
    ...typography.small,
    fontWeight: '600',
    color: colors.text.primary
  },
  activityList: {
    maxHeight: 300
  },
  activityItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.sm,
    backgroundColor: colors.surfaceVariant,
    borderRadius: borderRadius.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: 'transparent'
  },
  activityItemExpected: {
    borderColor: colors.warning,
    backgroundColor: colors.warning + '10'
  },
  activityInfo: {
    flex: 1
  },
  activityHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xs
  },
  activityLevel: {
    ...typography.body,
    fontWeight: '600',
    color: colors.text.primary,
    marginRight: spacing.xs
  },
  expectedBadge: {
    backgroundColor: colors.warning,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: borderRadius.sm
  },
  expectedBadgeText: {
    ...typography.caption,
    color: colors.surface,
    fontWeight: '600'
  },
  activityDetails: {
    ...typography.small,
    color: colors.text.secondary,
    marginBottom: spacing.xs
  },
  activityImpact: {
    ...typography.small,
    fontWeight: '600',
    color: colors.primary
  },
  impactPositive: {
    color: colors.success
  },
  impactNegative: {
    color: colors.danger
  },
  activityNotes: {
    ...typography.caption,
    color: colors.text.secondary,
    marginTop: spacing.xs,
    fontStyle: 'italic'
  },
  removeButton: {
    padding: spacing.sm,
    marginLeft: spacing.xs
  },
  removeButtonText: {
    fontSize: 20,
    color: colors.danger,
    fontWeight: '600'
  },
  addButton: {
    backgroundColor: colors.primary + '15',
    paddingVertical: 7,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    marginTop: spacing.xs
  },
  addButtonText: {
    ...typography.body,
    color: colors.primary,
    fontWeight: '600'
  },
  form: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border
  },
  formLabel: {
    ...typography.body,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: 4
  },
  formLabelSpacing: {
    marginTop: spacing.sm
  },
  levelSelector: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    gap: 4
  },
  levelButton: {
    flex: 1,
    backgroundColor: colors.surfaceVariant,
    paddingVertical: 5,
    paddingHorizontal: 2,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'transparent'
  },
  levelButtonActive: {
    backgroundColor: colors.primary + '15',
    borderColor: colors.primary
  },
  levelButtonNumber: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text.secondary,
    marginBottom: 1
  },
  levelButtonNumberActive: {
    color: colors.primary
  },
  levelButtonLabel: {
    ...typography.caption,
    fontSize: 10,
    color: colors.text.secondary,
    marginBottom: 1
  },
  levelButtonLabelActive: {
    color: colors.primary,
    fontWeight: '600'
  },
  levelButtonImpact: {
    color: colors.text.secondary,
    fontSize: 9
  },
  levelButtonImpactActive: {
    color: colors.primary,
    fontWeight: '600'
  },
  timeContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md
  },
  timeSection: {
    flex: 1
  },
  timeLabel: {
    ...typography.small,
    color: colors.text.secondary,
    marginBottom: spacing.xs
  },
  timeInputs: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center'
  },
  timeInput: {
    ...typography.body,
    backgroundColor: colors.surfaceVariant,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: 4,
    textAlign: 'center',
    width: 42,
    color: colors.text.primary
  },
  timeSeparator: {
    ...typography.body,
    color: colors.text.primary,
    marginHorizontal: spacing.xs
  },
  durationDisplay: {
    alignItems: 'center',
    marginVertical: 4
  },
  durationText: {
    ...typography.small,
    color: colors.text.secondary,
    fontWeight: '600'
  },
  timezoneHint: {
    ...typography.caption,
    color: colors.text.secondary,
    fontStyle: 'italic',
    textAlign: 'center',
    marginBottom: 4
  },
  expectedToggle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surfaceVariant,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.md,
    marginTop: spacing.sm
  },
  expectedToggleText: {
    flex: 1,
    marginRight: spacing.sm
  },
  expectedHelp: {
    ...typography.caption,
    color: colors.text.secondary,
    marginTop: 2
  },
  notesInput: {
    ...typography.body,
    backgroundColor: colors.surfaceVariant,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    minHeight: 60,
    color: colors.text.primary
  },
  formButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm
  },
  button: {
    flex: 1,
    padding: spacing.sm,
    borderRadius: borderRadius.md,
    alignItems: 'center'
  },
  cancelButton: {
    backgroundColor: colors.surfaceVariant,
    borderWidth: 1,
    borderColor: colors.border
  },
  cancelButtonText: {
    ...typography.body,
    color: colors.text.secondary,
    fontWeight: '600'
  },
  saveButton: {
    backgroundColor: colors.primary
  },
  saveButtonText: {
    ...typography.body,
    color: colors.text.inverse,
    fontWeight: '600'
  }
});

export default UnifiedActivityInput;