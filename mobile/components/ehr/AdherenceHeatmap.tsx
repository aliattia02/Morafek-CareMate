import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { E, ET } from '@/constants/elderlyTheme';
import { getAdherence, type MedicationAdherenceDay } from '@/services/api/medications';

interface AdherenceHeatmapProps {
  days: Array<{ date: string; total: number; taken: number; rate: number }>;
  overallRate: number;
}

interface HeatmapDay {
  date: string;
  total: number;
  taken: number;
  rate: number;
}

const WEEKDAY_HEADERS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const CELL_SIZE = 36;
const CELL_GAP = 6;
const GRID_WEEKS = 4;
const GRID_DAYS = 7;

function normalizeDateKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfIsoWeek(date: Date) {
  const copy = new Date(date);
  const day = copy.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  copy.setDate(copy.getDate() + diff);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function isoWeekNumber(date: Date): number {
  const start = startOfIsoWeek(date);
  const yearStart = startOfIsoWeek(new Date(start.getFullYear(), 0, 4));
  const diffMs = start.getTime() - yearStart.getTime();
  return Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;
}

function buildLast28Days(sourceDays: HeatmapDay[]): HeatmapDay[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const sourceByDate = new Map(sourceDays.map((day) => [normalizeDateKey(day.date), day]));
  const normalized: HeatmapDay[] = [];

  for (let offset = 27; offset >= 0; offset -= 1) {
    const current = new Date(today);
    current.setDate(today.getDate() - offset);
    const key = normalizeDateKey(current.toISOString());
    const found = sourceByDate.get(key);
    normalized.push(
      found ?? {
        date: key,
        total: 0,
        taken: 0,
        rate: 0,
      }
    );
  }

  return normalized;
}

function cellColor(day: HeatmapDay): string {
  if (day.total === 0 || day.rate === 0) return E.colors.surfaceAlt;
  if (day.rate < 0.5) return '#E86C66';
  if (day.rate < 0.8) return '#F1B84A';
  if (day.rate < 1) return '#8BD58B';
  return '#2EAA5D';
}

function overallColor(rate: number): string {
  if (rate < 0.5) return E.colors.danger;
  if (rate < 0.8) return E.colors.warning;
  return E.colors.success;
}

function weekLabel(days: HeatmapDay[]): string {
  if (days.length === 0) return 'KW —';
  const start = new Date(days[0].date);
  if (Number.isNaN(start.getTime())) return 'KW —';
  return `KW ${isoWeekNumber(start)}`;
}

function ShimmerGrid() {
  const opacity = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.85, duration: 600, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.35, duration: 600, useNativeDriver: true }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);

  return (
    <Animated.View style={{ opacity }}>
      <View style={styles.weekdayHeaderRow}>
        <View style={styles.rowHeaderSpacer} />
        {WEEKDAY_HEADERS.map((weekday) => (
          <Text key={weekday} style={styles.weekdayHeaderText}>
            {weekday}
          </Text>
        ))}
      </View>
      {Array.from({ length: GRID_WEEKS }).map((_, weekIndex) => (
        <View key={`loading-week-${weekIndex}`} style={styles.gridRow}>
          <View style={styles.rowHeader}>
            <Text style={styles.rowHeaderText}>KW —</Text>
          </View>
          {Array.from({ length: GRID_DAYS }).map((__, dayIndex) => (
            <View key={`loading-day-${weekIndex}-${dayIndex}`} style={styles.loadingCell} />
          ))}
        </View>
      ))}
    </Animated.View>
  );
}

export default function AdherenceHeatmap({ days, overallRate }: AdherenceHeatmapProps) {
  const [loading, setLoading] = useState(true);
  const [remoteDays, setRemoteDays] = useState<HeatmapDay[]>(days);
  const [remoteOverallRate, setRemoteOverallRate] = useState(overallRate);
  const [selected, setSelected] = useState<HeatmapDay | null>(null);

  useEffect(() => {
    let active = true;

    const loadAdherence = async () => {
      try {
        const response = await getAdherence();
        if (!active) return;
        setRemoteDays(response.days);
        setRemoteOverallRate(response.overall_rate);
      } catch {
        // keep fallback props data
      } finally {
        if (active) setLoading(false);
      }
    };

    loadAdherence();
    return () => {
      active = false;
    };
  }, []);

  const normalizedDays = useMemo(() => buildLast28Days(remoteDays), [remoteDays]);
  const weekRows = useMemo(() => {
    const rows: HeatmapDay[][] = [];
    for (let index = 0; index < normalizedDays.length; index += GRID_DAYS) {
      rows.push(normalizedDays.slice(index, index + GRID_DAYS));
    }
    return rows;
  }, [normalizedDays]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Adherence (28 Days)</Text>

      {loading ? (
        <View style={styles.loadingWrapper}>
          <ShimmerGrid />
          <ActivityIndicator size="small" color={E.colors.primary} />
        </View>
      ) : (
        <>
          <View style={styles.weekdayHeaderRow}>
            <View style={styles.rowHeaderSpacer} />
            {WEEKDAY_HEADERS.map((weekday) => (
              <Text key={weekday} style={styles.weekdayHeaderText}>
                {weekday}
              </Text>
            ))}
          </View>

          {weekRows.map((row, rowIndex) => (
            <View key={`week-row-${rowIndex}`} style={styles.gridRow}>
              <View style={styles.rowHeader}>
                <Text style={styles.rowHeaderText}>{weekLabel(row)}</Text>
              </View>
              {row.map((day) => (
                <Pressable
                  key={day.date}
                  style={[styles.cell, { backgroundColor: cellColor(day) }]}
                  onPress={() => setSelected(day)}
                  accessibilityRole="button"
                  accessibilityLabel={`${day.date}: ${day.taken} von ${day.total} genommen`}
                />
              ))}
            </View>
          ))}
        </>
      )}

      {selected ? (
        <View style={styles.tooltip}>
          <Text style={styles.tooltipDate}>{selected.date}</Text>
          <Text style={styles.tooltipText}>
            {selected.taken} / {selected.total} taken
          </Text>
        </View>
      ) : null}

      <View style={styles.overallWrapper}>
        <Text style={[styles.overallValue, { color: overallColor(remoteOverallRate) }]}>
          Overall adherence: {Math.round(remoteOverallRate * 100)}%
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: E.colors.surface,
    borderRadius: E.radius,
    borderWidth: 1,
    borderColor: E.colors.border,
    padding: E.padSm,
    gap: 10,
  },
  title: {
    ...ET.bodyBold,
  },
  loadingWrapper: {
    gap: 8,
    alignItems: 'center',
  },
  weekdayHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: CELL_GAP,
  },
  rowHeaderSpacer: {
    width: 42,
  },
  weekdayHeaderText: {
    width: CELL_SIZE,
    textAlign: 'center',
    ...ET.small,
    fontWeight: '700',
    color: E.colors.textSecondary,
  },
  gridRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: CELL_GAP,
    marginTop: CELL_GAP,
  },
  rowHeader: {
    width: 42,
    alignItems: 'flex-start',
  },
  rowHeaderText: {
    ...ET.caption,
    color: E.colors.textSecondary,
  },
  cell: {
    width: CELL_SIZE,
    height: CELL_SIZE,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: E.colors.border,
  },
  loadingCell: {
    width: CELL_SIZE,
    height: CELL_SIZE,
    borderRadius: 8,
    backgroundColor: E.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: E.colors.border,
  },
  tooltip: {
    marginTop: 6,
    borderRadius: E.radiusSm,
    borderWidth: 1,
    borderColor: E.colors.border,
    backgroundColor: E.colors.surfaceAlt,
    paddingHorizontal: E.padSm,
    paddingVertical: 8,
  },
  tooltipDate: {
    ...ET.small,
    fontWeight: '700',
  },
  tooltipText: {
    ...ET.small,
    color: E.colors.textSecondary,
  },
  overallWrapper: {
    marginTop: 6,
    alignItems: 'center',
    gap: 2,
  },
  overallValue: {
    ...ET.h2,
    fontWeight: '700',
  },
});
