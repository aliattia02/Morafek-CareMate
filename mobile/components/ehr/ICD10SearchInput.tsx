/**
 * ICD10SearchInput.tsx
 * Location: mobile/components/ehr/ICD10SearchInput.tsx
 *
 * A self-contained ICD-10-GM 2026 picker for the doctor's visit form.
 *
 * Features
 * ────────
 * • Live local search — searches both the code (prefix) and the German
 *   description (substring, case-insensitive).
 * • AI-Assist — sends the current chief-complaint + diagnosis hint to
 *   POST /api/ehr/icd10-suggest and shows ranked suggestions.
 * • Keyboard-aware result list rendered below the input (no Modal needed).
 * • Selecting a result fills both the code AND description fields in the
 *   parent form via the `onSelect` callback.
 *
 * Props
 * ────────
 * value        – current ICD-10 code string (controlled)
 * onSelect     – called when the user picks a result: { code, description }
 * chiefComplaint – forwarded to the AI-assist endpoint
 * diagnosisHint  – free-text the doctor has typed so far (used by AI-assist)
 * placeholder  – input placeholder (default: "e.g. I10, Hypertonie")
 * style        – optional outer container style override
 */

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  StyleSheet,
  StyleProp,
  ViewStyle,
  Keyboard,
  Platform,
} from 'react-native';

import { apiClient } from '@/services/api/client';
import { API }       from '@/services/api/endpoints';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
import { ICD10_GM, ICD10Entry } from '@/constants/icd10gm';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ICD10Selection {
  code:        string;
  description: string;
}

interface Props {
  value:           string;
  onSelect:        (sel: ICD10Selection) => void;
  chiefComplaint?: string;
  diagnosisHint?:  string;
  placeholder?:    string;
  style?:          StyleProp<ViewStyle>;
  /** Show AI-Assist button (default: true) */
  aiAssist?:       boolean;
}

interface AISuggestion {
  code:        string;
  description: string;
  rationale?:  string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_LOCAL_RESULTS = 30;
const DEBOUNCE_MS       = 200;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Fast local search:
 *  • Exact prefix match on the code  (highest priority)
 *  • Substring match in the description (case-insensitive)
 */
function searchICD10(query: string): ICD10Entry[] {
  const q = query.trim();
  if (!q || q.length < 2) return [];

  const upper = q.toUpperCase();
  const lower = q.toLowerCase();

  const prefixMatches:  ICD10Entry[] = [];
  const textMatches:    ICD10Entry[] = [];

  for (const entry of ICD10_GM) {
    if (prefixMatches.length + textMatches.length >= MAX_LOCAL_RESULTS * 3) break;
    const codeUpper = entry.c.toUpperCase();
    if (codeUpper.startsWith(upper)) {
      prefixMatches.push(entry);
    } else if (entry.d.toLowerCase().includes(lower)) {
      textMatches.push(entry);
    }
  }

  return [...prefixMatches, ...textMatches].slice(0, MAX_LOCAL_RESULTS);
}

// ─── Result Row ───────────────────────────────────────────────────────────────

function ResultRow({
  item,
  onPress,
  query,
}: {
  item:    ICD10Entry | AISuggestion;
  onPress: () => void;
  query?:  string;
}) {
  const code = 'code' in item ? item.code : item.c;
  const desc = 'description' in item ? item.description : item.d;
  const rat  = 'rationale' in item ? item.rationale : undefined;

  return (
    <TouchableOpacity
      style={styles.resultRow}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`${code} — ${desc}`}
    >
      <View style={styles.resultBadge}>
        <Text style={styles.resultCode}>{code}</Text>
      </View>
      <View style={styles.resultTextWrap}>
        <Text style={styles.resultDesc} numberOfLines={2}>{desc}</Text>
        {rat ? <Text style={styles.resultRationale}>{rat}</Text> : null}
      </View>
    </TouchableOpacity>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ICD10SearchInput({
  value,
  onSelect,
  chiefComplaint = '',
  diagnosisHint  = '',
  placeholder    = 'z.B. I10, Hypertonie…',
  style,
  aiAssist       = true,
}: Props) {
  const [query,        setQuery]        = useState(value);
  const [results,      setResults]      = useState<ICD10Entry[]>([]);
  const [aiResults,    setAiResults]    = useState<AISuggestion[] | null>(null);
  const [showList,     setShowList]     = useState(false);
  const [aiLoading,    setAiLoading]    = useState(false);
  const [aiError,      setAiError]      = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync external value → internal query when parent resets the field
  useEffect(() => {
    setQuery(value);
  }, [value]);

  // ── Local search with debounce ──────────────────────────────────────────────
  const handleChangeText = useCallback((text: string) => {
    setQuery(text);
    setAiResults(null);
    setAiError(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!text.trim() || text.trim().length < 2) {
      setResults([]);
      setShowList(false);
      return;
    }

    debounceRef.current = setTimeout(() => {
      const found = searchICD10(text);
      setResults(found);
      setShowList(true);
    }, DEBOUNCE_MS);
  }, []);

  // ── AI Assist ──────────────────────────────────────────────────────────────
  const handleAIAssist = useCallback(async () => {
    Keyboard.dismiss();
    setAiLoading(true);
    setAiError(null);
    setAiResults(null);
    setShowList(true);

    try {
      const res = await apiClient.post<{ suggestions: AISuggestion[] }>(
        API.EHR.ICD10_SUGGEST,
        {
          chief_complaint:  chiefComplaint,
          diagnosis_hint:   diagnosisHint || query,
        }
      );
      setAiResults(res.data.suggestions ?? []);
    } catch (err: unknown) {
      setAiError(
        err instanceof Error ? err.message : 'AI-Vorschläge nicht verfügbar'
      );
    } finally {
      setAiLoading(false);
    }
  }, [chiefComplaint, diagnosisHint, query]);

  // ── Select ─────────────────────────────────────────────────────────────────
  const handleSelect = useCallback(
    (item: ICD10Entry | AISuggestion) => {
      const code = 'code' in item ? item.code : item.c;
      const desc = 'description' in item ? item.description : item.d;
      setQuery(code);
      setShowList(false);
      setResults([]);
      setAiResults(null);
      Keyboard.dismiss();
      onSelect({ code, description: desc });
    },
    [onSelect]
  );

  const dismissList = useCallback(() => {
    setShowList(false);
  }, []);

  // ── Render list items ──────────────────────────────────────────────────────
  const listData: (ICD10Entry | AISuggestion)[] = aiResults ?? results;

  return (
    <View style={[styles.container, style]}>
      {/* Label */}
      <Text style={styles.label}>
        ICD-10-GM Code
        <Text style={styles.optional}> (optional)</Text>
      </Text>

      {/* Input row */}
      <View style={styles.inputRow}>
        <TextInput
          style={styles.textInput}
          value={query}
          onChangeText={handleChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.text.secondary}
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="search"
          onFocus={() => {
            if (results.length > 0) setShowList(true);
          }}
          onBlur={() => {
            // short delay lets a tap on a result register first
            setTimeout(dismissList, 150);
          }}
          accessibilityLabel="ICD-10-GM Suche"
        />

        {aiAssist && (
          <TouchableOpacity
            style={[styles.aiBtn, aiLoading && styles.aiBtnLoading]}
            onPress={handleAIAssist}
            disabled={aiLoading}
            accessibilityRole="button"
            accessibilityLabel="KI-Vorschlag anfordern"
          >
            {aiLoading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.aiBtnText}>✨ KI</Text>
            )}
          </TouchableOpacity>
        )}
      </View>

      {/* Helper / error text */}
      {aiError ? (
        <Text style={styles.errorText}>⚠️ {aiError}</Text>
      ) : aiResults !== null && aiResults.length === 0 ? (
        <Text style={styles.helperText}>Keine KI-Vorschläge gefunden</Text>
      ) : (
        <Text style={styles.helperText}>
          {query.length >= 2
            ? `${results.length} Treffer — oder ✨ KI für intelligente Vorschläge`
            : 'Min. 2 Zeichen eingeben oder ✨ KI-Vorschlag anfordern'}
        </Text>
      )}

      {/* Result dropdown */}
      {showList && listData.length > 0 && (
        <View style={styles.dropdown}>
          {/* Header showing source */}
          <View style={styles.dropdownHeader}>
            <Text style={styles.dropdownHeaderText}>
              {aiResults
                ? `✨ KI-Vorschläge (${listData.length})`
                : `🔍 ${listData.length} Treffer`}
            </Text>
            <TouchableOpacity onPress={dismissList}>
              <Text style={styles.closeBtn}>✕</Text>
            </TouchableOpacity>
          </View>

          <FlatList
            data={listData}
            keyExtractor={(item, i) =>
              ('code' in item ? item.code : item.c) + i
            }
            renderItem={({ item }) => (
              <ResultRow
                item={item}
                onPress={() => handleSelect(item)}
                query={query}
              />
            )}
            keyboardShouldPersistTaps="always"
            style={styles.list}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            // Performance on large lists
            initialNumToRender={10}
            maxToRenderPerBatch={10}
            windowSize={5}
          />
        </View>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const DROPDOWN_MAX_HEIGHT = 320;

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md,
  },

  // Label
  label: {
    ...typography.small,
    color: colors.text.primary,
    fontWeight: '600',
    marginBottom: 6,
  },
  optional: {
    fontWeight: '400',
    color: colors.text.secondary,
  },

  // Input row
  inputRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  textInput: {
    flex: 1,
    height: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.md,
    ...typography.body,
    color: colors.text.primary,
    backgroundColor: colors.surface,
  },

  // AI button
  aiBtn: {
    height: 48,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 64,
  },
  aiBtnLoading: {
    opacity: 0.7,
  },
  aiBtnText: {
    ...typography.small,
    color: '#fff',
    fontWeight: '700',
  },

  // Helper / error text
  helperText: {
    ...typography.small,
    color: colors.text.secondary,
    marginTop: 4,
  },
  errorText: {
    ...typography.small,
    color: colors.danger,
    marginTop: 4,
  },

  // Dropdown
  dropdown: {
    position:        'absolute',
    top:             48 + 6 + 16 + 4 + spacing.sm, // input height + label + helper + gap
    left:            0,
    right:           0,
    zIndex:          999,
    backgroundColor: colors.surface,
    borderWidth:     1,
    borderColor:     colors.border,
    borderRadius:    borderRadius.md,
    maxHeight:       DROPDOWN_MAX_HEIGHT,
    ...Platform.select({
      ios:     { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 8 },
      android: { elevation: 8 },
    }),
  },
  dropdownHeader: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.background,
    borderTopLeftRadius:  borderRadius.md,
    borderTopRightRadius: borderRadius.md,
  },
  dropdownHeaderText: {
    ...typography.small,
    color:      colors.text.secondary,
    fontWeight: '600',
  },
  closeBtn: {
    ...typography.body,
    color:   colors.text.secondary,
    padding: 4,
  },
  list: {
    maxHeight: DROPDOWN_MAX_HEIGHT - 40,
  },

  // Result row
  resultRow: {
    flexDirection:  'row',
    alignItems:     'flex-start',
    gap:            spacing.sm,
    paddingVertical:  spacing.sm,
    paddingHorizontal: spacing.md,
  },
  resultBadge: {
    backgroundColor:  colors.primary + '15',
    borderRadius:     4,
    paddingHorizontal: 6,
    paddingVertical:  2,
    alignSelf:        'flex-start',
    marginTop:        2,
    flexShrink:       0,
  },
  resultCode: {
    ...typography.small,
    color:      colors.primary,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  resultTextWrap: {
    flex: 1,
  },
  resultDesc: {
    ...typography.body,
    color:    colors.text.primary,
    fontSize: 14,
  },
  resultRationale: {
    ...typography.small,
    color:     colors.text.secondary,
    marginTop: 2,
    fontStyle: 'italic',
  },

  separator: {
    height:          1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.md,
  },
});
