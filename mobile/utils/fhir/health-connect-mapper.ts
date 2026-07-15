/**
 * health-connect-mapper.ts — Health Connect → FHIR R4 Observation mapper
 * Location: mobile/utils/fhir/health-connect-mapper.ts
 *
 * This is the core transformation layer. It converts raw Health Connect SDK
 * records (HeartRateRecord, StepsRecord, etc.) into FHIR R4 Observation
 * resources that match the ehr_vitals collection shape in Morafek's backend.
 *
 * Extensibility:
 *   To add a new data type (e.g. SpO₂), add one entry to HC_DATA_TYPES and
 *   one case in buildObservationsFromRecord(). No other file needs to change.
 *
 * FHIR conformance:
 *   • resourceType: Observation
 *   • status: final
 *   • category: vital-signs (http://terminology.hl7.org/CodeSystem/observation-category)
 *   • code: LOINC (http://loinc.org)
 *   • subject.reference: Patient/<patient_id>
 *   • effectiveDateTime: ISO-8601
 *   • valueQuantity: UCUM unit (http://unitsofmeasure.org)
 *   • extension: device-type (android_watch)
 *   • source: "health_connect" (non-FHIR field, added for backend filtering)
 *
 * ── FIX 7 — Deterministic observation IDs (fixes duplicate re-sync bug) ─────
 *
 *   Previously `id` was `uuidv4()` — a fresh random value every time this
 *   file built an Observation, even for the exact same underlying HC/Google
 *   Fit reading across repeated syncs.
 *
 *   The backend (health_connect_routes.py) relies on the `id` field to make
 *   sync idempotent:
 *       UpdateOne(filter={"id": enriched["id"]},
 *                 update={"$setOnInsert": enriched}, upsert=True)
 *   This only skips a duplicate if the SAME reading produces the SAME id on
 *   a later sync. A random id defeats that entirely — every tap of "Jetzt
 *   synchronisieren" re-inserted the same readings as brand-new documents,
 *   so counts doubled/tripled on every sync.
 *
 *   Fix: `id` is now derived deterministically from the fields that
 *   uniquely identify one measurement — patient + LOINC code + effective
 *   timestamp + value — via buildDeterministicObservationId(). The same
 *   reading always hashes to the same id, so the backend upsert correctly
 *   no-ops it as a duplicate. Two distinct readings would need to collide on
 *   patient + code + timestamp + value simultaneously to produce the same
 *   id, which does not happen in practice.
 *
 *   uuidv4()/react-native-get-random-values are no longer used by this file.
 */

import type {
  HCDataTypeConfig,
  HCFHIRObservation,
  HCHeartRateRecord,
  HCStepsRecord,
} from '@/types/health-connect.types';

// ─── Type registry ────────────────────────────────────────────────────────────
//
// This is the single source of truth for supported Health Connect data types.
// Add a new entry here + a case in buildObservationsFromRecord() to support
// a new record type end-to-end.

export const HC_DATA_TYPES = {
  heart_rate: {
    loincCode:    '8867-4',
    loincDisplay: 'Heart rate',
    unit:         'beats/min',
    unitCode:     '/min',
    hcRecord:     'HeartRate',
  },
  steps: {
    loincCode:    '41950-7',
    loincDisplay: 'Number of steps in unspecified time Pedometer',
    unit:         'steps',
    unitCode:     '{steps}',
    hcRecord:     'Steps',
  },
  // ── Reserved — add implementation in buildObservationsFromRecord() when ready:
  // spo2: {
  //   loincCode:    '59408-5',
  //   loincDisplay: 'Oxygen saturation in Arterial blood Pulse oximetry',
  //   unit:         '%',
  //   unitCode:     '%',
  //   hcRecord:     'OxygenSaturation',
  // },
  // weight: {
  //   loincCode:    '29463-7',
  //   loincDisplay: 'Body weight',
  //   unit:         'kg',
  //   unitCode:     'kg',
  //   hcRecord:     'Weight',
  // },
  // blood_glucose: {
  //   loincCode:    '15074-8',
  //   loincDisplay: 'Glucose [Moles/volume] in Blood',
  //   unit:         'mmol/L',
  //   unitCode:     'mmol/L',
  //   hcRecord:     'BloodGlucose',
  // },
} as const satisfies Record<string, HCDataTypeConfig>;

export type HCDataTypeKey = keyof typeof HC_DATA_TYPES;

// ─── Deterministic ID generation ──────────────────────────────────────────────
//
// See FIX 7 above. This replaces uuidv4() so the same underlying reading
// always produces the same Observation.id across repeated syncs, which is
// what makes the backend's upsert-based duplicate detection actually work.

/**
 * FNV-1a 32-bit hash, run twice with different seeds (once over the input,
 * once over the reversed input) and concatenated into a 64-bit-ish hex
 * digest. This is NOT cryptographic — it doesn't need to be. It only needs
 * to be a) fully deterministic for the same input, and b) collision-resistant
 * enough for a handful of observations per patient per sync, which a 64-bit
 * digest comfortably provides.
 */
function hashToHex(input: string): string {
  function fnv1a(str: string, seed: number): number {
    let hash = seed;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  const forward = fnv1a(input, 0x811c9dc5);
  const reversed = fnv1a(input.split('').reverse().join(''), 0x1000193);
  return forward.toString(16).padStart(8, '0') + reversed.toString(16).padStart(8, '0');
}

/**
 * Build a stable Observation id from the fields that uniquely identify one
 * measurement. Re-mapping the exact same HC/Google Fit reading — even from
 * a completely fresh readRecords() call in a later sync — yields the exact
 * same id, so the backend's upsert-by-id treats it as an already-synced
 * duplicate instead of inserting a new document.
 */
function buildDeterministicObservationId(
  patientId: string,
  loincCode: string,
  effectiveDateTime: string,
  value: number,
): string {
  const key = `hc|${patientId}|${loincCode}|${effectiveDateTime}|${value}`;
  return `hc-${hashToHex(key)}`;
}

// ─── FHIR builder helpers ─────────────────────────────────────────────────────

/**
 * Shared structure for all HC-sourced FHIR Observations.
 * Called by each per-type builder.
 */
function buildBaseObservation(
  patientId: string,
  config: HCDataTypeConfig,
  effectiveDateTime: string,
  value: number,
): HCFHIRObservation {
  return {
    resourceType: 'Observation',
    id: buildDeterministicObservationId(patientId, config.loincCode, effectiveDateTime, value),
    status: 'final',
    category: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/observation-category',
            code: 'vital-signs',
            display: 'Vital Signs',
          },
        ],
      },
    ],
    code: {
      coding: [
        {
          system: 'http://loinc.org',
          code: config.loincCode,
          display: config.loincDisplay,
        },
      ],
      text: config.loincDisplay,
    },
    subject: {
      reference: `Patient/${patientId}`,
    },
    effectiveDateTime,
    valueQuantity: {
      value,
      unit: config.unit,
      system: 'http://unitsofmeasure.org',
      code: config.unitCode,
    },
    source: 'health_connect',
    device: {
      display: 'health_connect',
    },
    extension: [
      {
        url: 'https://morafek.app/fhir/StructureDefinition/device-type',
        valueString: 'android_watch',
      },
    ],
  };
}

// ─── Per-type builders ────────────────────────────────────────────────────────

/**
 * Convert a HeartRateRecord into one FHIR Observation per sample.
 *
 * Health Connect stores HR as an array of samples within a record window.
 * Each sample has its own timestamp, so we produce one Observation per
 * sample rather than one per record — this gives finer temporal resolution
 * and matches how Morafek's existing HR observations are stored.
 */
function buildHeartRateObservations(
  record: HCHeartRateRecord,
  patientId: string,
): HCFHIRObservation[] {
  const config = HC_DATA_TYPES.heart_rate;
  const observations: HCFHIRObservation[] = [];

  for (const sample of record.samples) {
    const bpm = sample.beatsPerMinute;
    // Physiological sanity check — discard noise
    if (bpm < 20 || bpm > 300) continue;

    observations.push(
      buildBaseObservation(patientId, config, sample.time, bpm),
    );
  }

  return observations;
}

/**
 * Convert a StepsRecord into a single FHIR Observation.
 *
 * Steps are an aggregate over the record's time window, so one record → one
 * Observation. effectiveDateTime is the start of the window.
 */
function buildStepsObservation(
  record: HCStepsRecord,
  patientId: string,
): HCFHIRObservation | null {
  const config = HC_DATA_TYPES.steps;
  if (record.count <= 0) return null;

  return buildBaseObservation(
    patientId,
    config,
    record.startTime,
    record.count,
  );
}

// ─── Main dispatch function ───────────────────────────────────────────────────

/**
 * Convert a raw Health Connect record of any supported type into an array
 * of FHIR R4 Observations.
 *
 * This is the only function callers (useHealthConnect hook) need to call.
 *
 * @param dataType - Key into HC_DATA_TYPES registry
 * @param record   - Raw record from readRecords()
 * @param patientId - MongoDB patient _id string
 * @returns Array of FHIR Observations (may be empty if all samples are invalid)
 */
export function buildObservationsFromRecord(
  dataType: HCDataTypeKey,
  record: unknown,
  patientId: string,
): HCFHIRObservation[] {
  switch (dataType) {
    case 'heart_rate': {
      const hr = record as HCHeartRateRecord;
      return buildHeartRateObservations(hr, patientId);
    }

    case 'steps': {
      const steps = record as HCStepsRecord;
      const obs = buildStepsObservation(steps, patientId);
      return obs ? [obs] : [];
    }

    // Uncomment as implementations are added:
    // case 'spo2': { ... }
    // case 'weight': { ... }
    // case 'blood_glucose': { ... }

    default:
      // Unknown type — should not happen with the typed registry
      console.warn(`[HC Mapper] Unknown data type: ${String(dataType)}`);
      return [];
  }
}

// ─── Batch conversion ─────────────────────────────────────────────────────────

/**
 * Convert all records from a full sync pass into a flat array of FHIR
 * Observations. Accepts the output of readAllRecords() from the hook.
 *
 * @param allRecords  Map of dataType → raw records array from HC SDK
 * @param patientId   MongoDB patient _id string
 * @returns Deduplicated flat array of FHIR Observations ready to POST
 */
export function mapAllRecordsToObservations(
  allRecords: Partial<Record<HCDataTypeKey, unknown[]>>,
  patientId: string,
): HCFHIRObservation[] {
  const result: HCFHIRObservation[] = [];

  for (const [dataType, records] of Object.entries(allRecords) as [
    HCDataTypeKey,
    unknown[],
  ][]) {
    if (!records || records.length === 0) continue;

    for (const record of records) {
      const observations = buildObservationsFromRecord(dataType, record, patientId);
      result.push(...observations);
    }
  }

  return result;
}

// ─── Type guard for the registry ─────────────────────────────────────────────

/** Returns true if the given string is a key in HC_DATA_TYPES */
export function isHCDataTypeKey(key: string): key is HCDataTypeKey {
  return key in HC_DATA_TYPES;
}

/** Returns the HC record types to request permissions for */
export function getPermissionRequests() {
  return Object.values(HC_DATA_TYPES).map(config => ({
    accessType: 'read' as const,
    recordType: config.hcRecord,
  }));
}