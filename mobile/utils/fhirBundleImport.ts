/**
 * mobile/utils/fhirBundleImport.ts
 *
 * Parses a FHIR R4 Bundle JSON string (typically a doctor's delta export) and
 * merges new resources into the local SQLite database using the helpers from
 * services/offline/db.ts.
 *
 * DSGVO / GDPR relevance
 * ──────────────────────
 * The bundle must be decrypted with decryptBundle() (fhirCrypto.ts) before
 * being passed to importDeltaBundle().  This module stores only the data the
 * patient explicitly receives from their care team.  Existing local records are
 * updated (INSERT OR REPLACE) so that re-importing the same bundle is safe and
 * idempotent.
 */

import {
  cacheVisits,
  cacheConditions,
  cacheExercises,
  cacheMessages,
} from '@/services/offline/db';
import type { ConditionRow } from '@/services/offline/db';
import type {
  VisitResponse,
  ExerciseResponse,
  ExerciseCategory,
  MessageResponse,
} from '@/services/api/ehr';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Counts of resources merged into the local database. */
export interface ImportSummary {
  encounters:  number;
  conditions:  number;
  exercises:   number;
  messages:    number;
  skipped:     number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function safeStr(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function safeNum(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function safeBool(value: unknown): boolean {
  return value === true || value === 1;
}

/** Extract the id portion from a FHIR reference string, e.g. "Patient/abc" → "abc". */
function refId(ref: unknown): string {
  const s = safeStr(ref);
  const slash = s.lastIndexOf('/');
  return slash >= 0 ? s.slice(slash + 1) : s;
}

// ─── Per-resourceType mappers ─────────────────────────────────────────────────

function mapEncounter(resource: Record<string, unknown>): VisitResponse | null {
  const id = safeStr(resource['id']);
  if (!id) return null;
  const period   = resource['period'] as Record<string, unknown> | undefined;
  const reasonCode = resource['reasonCode'] as unknown[] | undefined;
  const diagnosisArr = resource['diagnosis'] as unknown[] | undefined;
  const noteArr  = resource['note'] as unknown[] | undefined;

  const firstReason  = reasonCode?.[0] as Record<string, unknown> | undefined;
  const firstDiag    = diagnosisArr?.[0] as Record<string, unknown> | undefined;
  const conditionCoding = (
    (firstDiag?.['condition'] as Record<string, unknown> | undefined)
    ?.['coding'] as unknown[] | undefined
  )?.[0] as Record<string, unknown> | undefined;

  const participantArr = resource['participant'] as unknown[] | undefined;
  const firstParticipant = participantArr?.[0] as Record<string, unknown> | undefined;
  const individual = firstParticipant?.['individual'] as Record<string, unknown> | undefined;
  const doctorRef  = safeStr(individual?.['reference']);

  return {
    id,
    visit_date:       safeStr(period?.['start']),
    chief_complaint:  safeStr(firstReason?.['text']),
    diagnosis_icd10:  safeStr(conditionCoding?.['code']),
    diagnosis_text:   safeStr(conditionCoding?.['display']),
    notes:            safeStr((noteArr?.[0] as Record<string, unknown> | undefined)?.['text']),
    doctor_id:        refId(doctorRef),
    encounter_fhir_id: id,
  };
}

function mapCondition(resource: Record<string, unknown>): ConditionRow | null {
  const id = safeStr(resource['id']);
  if (!id) return null;
  const codeCoding   = ((resource['code'] as Record<string, unknown> | undefined)
    ?.['coding'] as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
  const statusCoding = ((resource['clinicalStatus'] as Record<string, unknown> | undefined)
    ?.['coding'] as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
  const encounterRef = (resource['encounter'] as Record<string, unknown> | undefined)
    ?.['reference'];

  return {
    id,
    icd10_code:      safeStr(codeCoding?.['code']),
    icd10_text:      safeStr(codeCoding?.['display']),
    clinical_status: safeStr(statusCoding?.['code'], 'active'),
    encounter_id:    refId(encounterRef),
    onset_date:      safeStr(resource['onsetDateTime'] ?? resource['recordedDate']),
  };
}

function mapCarePlan(resource: Record<string, unknown>): ExerciseResponse | null {
  const id = safeStr(resource['id']);
  if (!id) return null;
  const categoryArr = resource['category'] as unknown[] | undefined;
  const firstCat    = (categoryArr?.[0] as Record<string, unknown> | undefined);
  const catCoding   = (firstCat?.['coding'] as unknown[] | undefined)
    ?.[0] as Record<string, unknown> | undefined;

  const activityArr = resource['activity'] as unknown[] | undefined;
  const detail      = (activityArr?.[0] as Record<string, unknown> | undefined)
    ?.['detail'] as Record<string, unknown> | undefined;

  const extensionArr = resource['extension'] as unknown[] | undefined;
  const videoExt     = (extensionArr ?? []).find(
    (e) =>
      (e as Record<string, unknown>)['url'] ===
      'https://morafek.app/fhir/StructureDefinition/exercise-video-url',
  ) as Record<string, unknown> | undefined;

  const rawCategory = safeStr(catCoding?.['code'], 'other');
  const validCategories: ExerciseCategory[] = [
    'mobility', 'strength', 'balance', 'breathing', 'other',
  ];
  const category: ExerciseCategory = validCategories.includes(rawCategory as ExerciseCategory)
    ? (rawCategory as ExerciseCategory)
    : 'other';

  const dailyAmount = detail?.['dailyAmount'] as Record<string, unknown> | undefined;

  return {
    id,
    title:            safeStr(resource['title']),
    description:      safeStr(resource['description'] ?? detail?.['description']),
    category,
    frequency:        safeStr(detail?.['scheduledString']),
    duration_minutes: safeNum(dailyAmount?.['value']),
    repetitions:      safeNum(
      (detail?.['quantity'] as Record<string, unknown> | undefined)?.['value'],
    ),
    sets:      undefined,
    video_url: videoExt ? safeStr(videoExt['valueUri']) : undefined,
    image_url: undefined,
    notes:     detail ? safeStr(detail['description']) : undefined,
  };
}

function mapMessageThread(resource: Record<string, unknown>): MessageResponse | null {
  const id = safeStr(resource['id']);
  if (!id) return null;
  const senderRef  = (resource['sender'] as Record<string, unknown> | undefined)
    ?.['reference'];
  const recipientArr = resource['recipient'] as unknown[] | undefined;
  const recipientRef = (recipientArr?.[0] as Record<string, unknown> | undefined)
    ?.['reference'];

  const rawSenderType = safeStr(resource['sender_type']);
  const senderType: MessageResponse['sender_type'] =
    rawSenderType === 'doctor' ? 'doctor' : 'patient';

  const noteArr   = resource['note'] as unknown[] | undefined;
  const body      = safeStr(
    (noteArr?.[0] as Record<string, unknown> | undefined)?.['text'] ?? resource['body'],
  );

  return {
    id,
    sender_id:    refId(senderRef),
    recipient_id: refId(recipientRef),
    sender_type:  senderType,
    body,
    read:         safeBool(resource['read']),
    created_at:   safeStr(resource['received'] ?? resource['created_at'] ?? new Date().toISOString()),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Validates that a JSON string is a parseable FHIR Bundle with an entry array.
 *
 * DSGVO / GDPR relevance: call this before importDeltaBundle() to ensure
 * the decrypted payload is structurally sound before writing to the local DB.
 *
 * @param bundleJson - Raw JSON string to validate.
 * @returns `true` if the string is a valid Bundle; `false` otherwise.
 * @throws {Error} with a descriptive message if the JSON cannot be parsed.
 */
export function validateBundle(bundleJson: string): boolean {
  if (typeof bundleJson !== 'string' || bundleJson.trim() === '') {
    throw new Error('[fhirBundleImport] bundleJson must be a non-empty string');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bundleJson);
  } catch (e) {
    throw new Error(`[fhirBundleImport] Invalid JSON: ${(e as Error).message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('[fhirBundleImport] Parsed value is not an object');
  }

  const obj = parsed as Record<string, unknown>;
  if (obj['resourceType'] !== 'Bundle') {
    throw new Error(
      `[fhirBundleImport] resourceType must be "Bundle", got "${obj['resourceType']}"`,
    );
  }

  if (!Array.isArray(obj['entry'])) {
    throw new Error('[fhirBundleImport] Bundle.entry must be an array');
  }

  return true;
}

/**
 * Parses a FHIR R4 Bundle JSON string and merges recognised resources into
 * the local SQLite database.
 *
 * Supported resourceTypes and their target tables:
 *   - Encounter       → visits
 *   - Condition       → conditions
 *   - CarePlan        → exercises
 *   - MessageThread   → messages  (custom resourceType used by Morafek)
 *
 * All other resourceTypes increment the `skipped` counter.
 *
 * DSGVO / GDPR relevance: this function must only be called after
 * decryptBundle() (fhirCrypto.ts) has returned the plain-text bundle string.
 * The bundle is stored locally and never re-transmitted.
 *
 * @param bundleJson - Decrypted FHIR R4 Bundle JSON string.
 * @returns ImportSummary with per-type counts of merged and skipped resources.
 */
export async function importDeltaBundle(bundleJson: string): Promise<ImportSummary> {
  // validateBundle throws descriptive errors on malformed input
  validateBundle(bundleJson);

  const bundle = JSON.parse(bundleJson) as Record<string, unknown>;
  const entries = bundle['entry'] as unknown[];

  const encounters: VisitResponse[]   = [];
  const conditions: ConditionRow[]    = [];
  const exercises:  ExerciseResponse[] = [];
  const messages:   MessageResponse[] = [];
  let   skipped = 0;

  for (const entry of entries) {
    const e        = entry as Record<string, unknown>;
    const resource = (e['resource'] ?? e) as Record<string, unknown>;
    const rt       = safeStr(resource['resourceType']);

    switch (rt) {
      case 'Encounter': {
        const mapped = mapEncounter(resource);
        if (mapped) encounters.push(mapped); else skipped++;
        break;
      }
      case 'Condition': {
        const mapped = mapCondition(resource);
        if (mapped) conditions.push(mapped); else skipped++;
        break;
      }
      case 'CarePlan': {
        const mapped = mapCarePlan(resource);
        if (mapped) exercises.push(mapped); else skipped++;
        break;
      }
      case 'MessageThread': {
        const mapped = mapMessageThread(resource);
        if (mapped) messages.push(mapped); else skipped++;
        break;
      }
      default:
        skipped++;
        break;
    }
  }

  // The db helper functions use expo-sqlite's synchronous runSync/getAllSync API,
  // so they do not return Promises and must not be awaited.
  if (encounters.length > 0)  cacheVisits(encounters);
  if (conditions.length > 0)  cacheConditions(conditions);
  if (exercises.length  > 0)  cacheExercises(exercises);
  if (messages.length   > 0)  cacheMessages(messages);

  return {
    encounters: encounters.length,
    conditions: conditions.length,
    exercises:  exercises.length,
    messages:   messages.length,
    skipped,
  };
}
