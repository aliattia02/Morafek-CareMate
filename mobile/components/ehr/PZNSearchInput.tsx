import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  StyleProp,
  ViewStyle,
  Keyboard,
  Platform,
} from 'react-native';

import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import { PZN_DATA, PZNEntry } from '@/constants/pzn';

export interface PZNSelection {
  pzn: string;
  tradeName: string;
  activeSubstance: string;
  form: string;
  strength: string;
  normSize: 'N1' | 'N2' | 'N3';
}

interface Props {
  value: string;
  onSelect: (selection: PZNSelection) => void;
  placeholder?: string;
  style?: StyleProp<ViewStyle>;
}

const MAX_LOCAL_RESULTS = 25;
const DEBOUNCE_MS = 180;

function searchPZN(query: string): PZNEntry[] {
  const q = query.trim();
  if (!q || q.length < 2) return [];

  const lower = q.toLowerCase();
  const prefix = q.replace(/\s+/g, '');

  const pznMatches: PZNEntry[] = [];
  const textMatches: PZNEntry[] = [];

  for (const entry of PZN_DATA) {
    if (pznMatches.length + textMatches.length >= MAX_LOCAL_RESULTS * 3) break;

    if (entry.p.startsWith(prefix)) {
      pznMatches.push(entry);
      continue;
    }

    const searchable = `${entry.t} ${entry.a} ${entry.f} ${entry.s}`.toLowerCase();
    if (searchable.includes(lower)) {
      textMatches.push(entry);
    }
  }

  return [...pznMatches, ...textMatches].slice(0, MAX_LOCAL_RESULTS);
}

function ResultRow({ item, onPress }: { item: PZNEntry; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={styles.resultRow}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`${item.p} ${item.t}`}
    >
      <View style={styles.resultBadge}>
        <Text style={styles.resultCode}>{item.p}</Text>
      </View>
      <View style={styles.resultTextWrap}>
        <Text style={styles.resultTitle} numberOfLines={1}>{item.t}</Text>
        <Text style={styles.resultSubtitle} numberOfLines={2}>{item.a} • {item.s} • {item.f}</Text>
      </View>
    </TouchableOpacity>
  );
}

export default function PZNSearchInput({
  value,
  onSelect,
  placeholder = 'z.B. PZN oder Wirkstoff…',
  style,
}: Props) {
  const [query, setQuery] = useState(value);
  const [results, setResults] = useState<PZNEntry[]>([]);
  const [showList, setShowList] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setQuery(value);
  }, [value]);

  const handleChangeText = useCallback((text: string) => {
    setQuery(text);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!text.trim() || text.trim().length < 2) {
      setResults([]);
      setShowList(false);
      return;
    }

    debounceRef.current = setTimeout(() => {
      const found = searchPZN(text);
      setResults(found);
      setShowList(true);
    }, DEBOUNCE_MS);
  }, []);

  const dismissList = useCallback(() => setShowList(false), []);

  const handleSelect = useCallback((item: PZNEntry) => {
    setQuery(item.p);
    setResults([]);
    setShowList(false);
    Keyboard.dismiss();

    onSelect({
      pzn: item.p,
      tradeName: item.t,
      activeSubstance: item.a,
      form: item.f,
      strength: item.s,
      normSize: item.n,
    });
  }, [onSelect]);

  return (
    <View style={[styles.container, style]}>
      <Text style={styles.label}>PZN Medikamentensuche</Text>

      <TextInput
        style={styles.textInput}
        value={query}
        onChangeText={handleChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.text.secondary}
        autoCorrect={false}
        autoCapitalize="none"
        keyboardType="default"
        onFocus={() => {
          if (results.length > 0) setShowList(true);
        }}
        onBlur={() => {
          setTimeout(dismissList, 150);
        }}
        accessibilityLabel="PZN Suche"
      />

      <Text style={styles.helperText}>
        {query.trim().length >= 2 ? `${results.length} Treffer` : 'Mindestens 2 Zeichen eingeben'}
      </Text>

      {showList && results.length > 0 && (
        <View style={styles.dropdown}>
          <View style={styles.dropdownHeader}>
            <Text style={styles.dropdownHeaderText}>�� {results.length} Treffer</Text>
            <TouchableOpacity onPress={dismissList}>
              <Text style={styles.closeBtn}>✕</Text>
            </TouchableOpacity>
          </View>

          <FlatList
            data={results}
            keyExtractor={(item) => item.p}
            renderItem={({ item }) => <ResultRow item={item} onPress={() => handleSelect(item)} />}
            keyboardShouldPersistTaps="always"
            style={styles.list}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            initialNumToRender={10}
            maxToRenderPerBatch={10}
            windowSize={5}
          />
        </View>
      )}
    </View>
  );
}

const DROPDOWN_MAX_HEIGHT = 300;

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md,
  },
  label: {
    ...typography.small,
    color: colors.text.primary,
    fontWeight: '600',
    marginBottom: 6,
  },
  textInput: {
    height: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    ...typography.body,
    color: colors.text.primary,
    backgroundColor: colors.surface,
  },
  helperText: {
    ...typography.small,
    color: colors.text.secondary,
    marginTop: 4,
  },
  dropdown: {
    position: 'absolute',
    top: 48 + 6 + 16 + 4 + spacing.sm,
    left: 0,
    right: 0,
    zIndex: 999,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    maxHeight: DROPDOWN_MAX_HEIGHT,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 8 },
      android: { elevation: 8 },
      web: { boxShadow: '0 4px 16px rgba(0,0,0,0.12)' } as any,
    }),
  },
  dropdownHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.background,
    borderTopLeftRadius: borderRadius.md,
    borderTopRightRadius: borderRadius.md,
  },
  dropdownHeaderText: {
    ...typography.small,
    color: colors.text.secondary,
    fontWeight: '600',
  },
  closeBtn: {
    ...typography.body,
    color: colors.text.secondary,
    padding: 4,
  },
  list: {
    maxHeight: DROPDOWN_MAX_HEIGHT - 40,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  resultBadge: {
    backgroundColor: colors.primary + '15',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignSelf: 'flex-start',
    marginTop: 2,
    flexShrink: 0,
  },
  resultCode: {
    ...typography.small,
    color: colors.primary,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  resultTextWrap: {
    flex: 1,
  },
  resultTitle: {
    ...typography.body,
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  resultSubtitle: {
    ...typography.small,
    color: colors.text.secondary,
    marginTop: 2,
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.md,
  },
});
