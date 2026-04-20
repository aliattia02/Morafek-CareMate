import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Platform,
} from 'react-native';

import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import { PZNEntry, searchPZN } from '@/constants/pzn_data';

export interface PZNSearchInputProps {
  onSelect: (entry: PZNEntry) => void;
  placeholder?: string;
  disabled?: boolean;
}

const DEBOUNCE_MS = 200;
const MAX_RESULTS = 8;
const BLUR_DISMISS_DELAY_MS = 150;
const INPUT_HEIGHT = 48;
const INPUT_TO_LABEL_GAP = spacing.xs;
const LABEL_LINE_HEIGHT = typography.small.lineHeight;

function ResultRow({ item, onPress }: { item: PZNEntry; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={styles.resultRow}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`${item.trade_name} ${item.pzn}`}
    >
      <View style={styles.resultMain}>
        <Text style={styles.tradeName} numberOfLines={1}>{item.trade_name}</Text>
        <Text style={styles.subtitle} numberOfLines={2}>
          {item.active_substance} • {item.strength} • {item.form}
        </Text>
      </View>

      <View style={styles.pznBadge}>
        <Text style={styles.pznText}>{item.pzn}</Text>
      </View>
    </TouchableOpacity>
  );
}

export default function PZNSearchInput({
  onSelect,
  placeholder = 'PZN, Handelsname oder Wirkstoff…',
  disabled = false,
}: PZNSearchInputProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PZNEntry[]>([]);
  const [showList, setShowList] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChangeText = useCallback((text: string) => {
    setQuery(text);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!text.trim()) {
      setResults([]);
      setShowList(false);
      return;
    }

    debounceRef.current = setTimeout(() => {
      const found = searchPZN(text, MAX_RESULTS);
      setResults(found);
      setShowList(found.length > 0);
    }, DEBOUNCE_MS);
  }, []);

  const dismissList = useCallback(() => {
    setShowList(false);
  }, []);

  const handleSelect = useCallback((entry: PZNEntry) => {
    onSelect(entry);
    setQuery('');
    setResults([]);
    setShowList(false);
  }, [onSelect]);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>PZN Medikamentensuche</Text>

      <TextInput
        style={[styles.input, disabled && styles.inputDisabled]}
        value={query}
        onChangeText={handleChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.text.secondary}
        editable={!disabled}
        autoCorrect={false}
        autoCapitalize="none"
        onBlur={() => setTimeout(dismissList, BLUR_DISMISS_DELAY_MS)}
        onFocus={() => {
          if (query.trim() && results.length > 0) setShowList(true);
        }}
        accessibilityLabel="PZN Suche"
      />

      {showList && query.trim().length > 0 && results.length > 0 && (
        <View style={styles.dropdown}>
          <FlatList
            data={results}
            keyExtractor={(item) => item.pzn}
            renderItem={({ item }) => <ResultRow item={item} onPress={() => handleSelect(item)} />}
            keyboardShouldPersistTaps="always"
            style={styles.list}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            initialNumToRender={8}
            maxToRenderPerBatch={8}
            windowSize={5}
          />
        </View>
      )}
    </View>
  );
}

const DROPDOWN_MAX_HEIGHT = 320;
const DROPDOWN_TOP_OFFSET = INPUT_HEIGHT + INPUT_TO_LABEL_GAP + LABEL_LINE_HEIGHT + spacing.sm;

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md,
  },
  label: {
    ...typography.small,
    color: colors.text.primary,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  input: {
    height: INPUT_HEIGHT,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.md,
    ...typography.body,
    color: colors.text.primary,
    backgroundColor: colors.surface,
  },
  inputDisabled: {
    backgroundColor: colors.surfaceVariant,
    opacity: 0.8,
  },
  dropdown: {
    position: 'absolute',
    top: DROPDOWN_TOP_OFFSET,
    left: 0,
    right: 0,
    zIndex: 999,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    maxHeight: DROPDOWN_MAX_HEIGHT,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.12,
        shadowRadius: 8,
      },
      android: { elevation: 8 },
      web: { boxShadow: '0 4px 16px rgba(0,0,0,0.12)' } as any,
    }),
  },
  list: {
    maxHeight: DROPDOWN_MAX_HEIGHT,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  resultMain: {
    flex: 1,
  },
  tradeName: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '700',
  },
  subtitle: {
    ...typography.small,
    color: colors.text.secondary,
    marginTop: 2,
  },
  pznBadge: {
    minWidth: 78,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.sm,
    backgroundColor: colors.primary + '12',
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    marginLeft: spacing.xs,
  },
  pznText: {
    ...typography.small,
    color: colors.primary,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.md,
  },
});
