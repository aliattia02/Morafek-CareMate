/**
 * ICD-10-GM API Service
 * Location: mobile/services/api/icd10.ts
 *
 * Thin wrapper around POST /api/ehr/icd10-suggest.
 *
 * Usage (inside ICD10SearchInput or any future screen):
 *
 *   import { fetchICD10Suggestions } from '@/services/api/icd10';
 *
 *   const suggestions = await fetchICD10Suggestions({
 *     chiefComplaint: 'Brustschmerzen',
 *     diagnosisHint:  'Angina pectoris',
 *   });
 *   // → [{ code: 'I20.0', description: '...', rationale: '...' }, ...]
 */

import apiClient from './client';
import { API } from './endpoints';

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single AI-suggested ICD-10-GM code returned by the backend. */
export interface ICD10Suggestion {
  /** ICD-10-GM code, e.g. "I20.0" or "E11.9" */
  code: string;
  /** German diagnosis label, e.g. "Instabile Angina pectoris" */
  description: string;
  /**
   * Short German rationale (≤ 10 words) explaining why this code was chosen.
   * May be undefined if the backend omits it.
   */
  rationale?: string;
}

/** Parameters accepted by {@link fetchICD10Suggestions}. */
export interface ICD10SuggestParams {
  /**
   * Patient's main reason for the visit (Leitsymptom).
   * At least one of chiefComplaint / diagnosisHint must be non-empty.
   */
  chiefComplaint?: string;
  /**
   * Free-text diagnosis the doctor is considering (Diagnosehinweis).
   * At least one of chiefComplaint / diagnosisHint must be non-empty.
   */
  diagnosisHint?: string;
}

/** Shape of the raw API response. */
interface ICD10SuggestResponse {
  suggestions: ICD10Suggestion[];
}

// ─── Service function ─────────────────────────────────────────────────────────

/**
 * Ask the backend (Claude claude-sonnet-4-20250514) for the top 3-5 ICD-10-GM 2026 codes
 * that best match the given chief complaint and/or diagnosis hint.
 *
 * Throws on network errors or non-2xx responses — callers should catch.
 *
 * @example
 * const results = await fetchICD10Suggestions({
 *   chiefComplaint: 'Kopfschmerzen',
 *   diagnosisHint:  'Migräne ohne Aura',
 * });
 */
export async function fetchICD10Suggestions(
  params: ICD10SuggestParams
): Promise<ICD10Suggestion[]> {
  if (!params.chiefComplaint?.trim() && !params.diagnosisHint?.trim()) {
    throw new Error('chiefComplaint or diagnosisHint is required');
  }

  const response = await apiClient.post<ICD10SuggestResponse>(
    API.EHR.ICD10_SUGGEST,
    {
      chief_complaint: params.chiefComplaint?.trim() ?? '',
      diagnosis_hint:  params.diagnosisHint?.trim()  ?? '',
    }
  );

  // Defensive: backend always returns { suggestions: [...] }
  return response.data.suggestions ?? [];
}

// ─── React hook (optional convenience) ───────────────────────────────────────

import { useState, useCallback } from 'react';

export interface UseICD10SuggestResult {
  /** The last set of suggestions returned by the AI. Null before first call. */
  suggestions: ICD10Suggestion[] | null;
  /** True while the request is in flight. */
  isLoading: boolean;
  /** Error message if the last call failed, otherwise null. */
  error: string | null;
  /** Trigger a new suggestion request. */
  suggest: (params: ICD10SuggestParams) => Promise<ICD10Suggestion[]>;
  /** Reset state (e.g. when the form is cleared). */
  reset: () => void;
}

/**
 * Hook that wraps {@link fetchICD10Suggestions} with loading / error state.
 *
 * @example
 * const { suggestions, isLoading, error, suggest } = useICD10Suggest();
 *
 * // In a button handler:
 * await suggest({ chiefComplaint, diagnosisHint });
 */
export function useICD10Suggest(): UseICD10SuggestResult {
  const [suggestions, setSuggestions] = useState<ICD10Suggestion[] | null>(null);
  const [isLoading,   setIsLoading]   = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  const suggest = useCallback(async (params: ICD10SuggestParams) => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await fetchICD10Suggestions(params);
      setSuggestions(result);
      return result;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'KI-Vorschläge nicht verfügbar';
      setError(message);
      setSuggestions([]);
      return [];
    } finally {
      setIsLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setSuggestions(null);
    setIsLoading(false);
    setError(null);
  }, []);

  return { suggestions, isLoading, error, suggest, reset };
}

export default { fetchICD10Suggestions, useICD10Suggest };
