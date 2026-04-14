/**
 * mobile/utils/fhirBundleExport.ts
 *
 * Builds a FHIR R4 "collection" Bundle entirely offline from data that is
 * already persisted in the local SQLite cache.  No network calls are made.
 *
 * The resource shapes mirror what the backend GET /api/patient/fhir-export
 * endpoint returns (see backend/utils/fhir_de.py for profile URLs and field
 * conventions).
 *
 * DSGVO / GDPR relevance
 * ──────────────────────
 * The exported bundle contains personal health data (PHI). It is intended to
 * be encrypted with encryptBundle() from fhirCrypto.ts before leaving the
 * device.  The raw JSON produced here must never be transmitted or stored
 * unprotected.
 */

import {
  getCachedVitals,
  getCachedVisits,
  getCachedConditions,
  getCachedDocuments,
  getCachedExercises,
  getPatientFhirIdentifiers,
} from '@/services/offline/db';
import type { ConditionRow } from '@/services/offline/db';
import type {
  VitalResponse,
  VisitResponse,
  ExerciseResponse,
  DocumentResponse,
} from '@/services/api/ehr';

// ─── Profile URL constants (mirrors fhir_de.py PROFILE) ──────────────────────

const PROFILE = {
  PATIENT_DE:              'http://fhir.de/StructureDefinition/Patient',
  ISIK_PATIENT:            'https://gematik.de/fhir/isik/StructureDefinition/ISiKPatient',
  OBSERVATION_DE:          'http://fhir.de/StructureDefinition/Observation-de-vitalsign',
  ISIK_OBSERVATION_VITALS: 'https://gematik.de/fhir/isik/StructureDefinition/ISiKLebenszeichen',
  ENCOUNTER_DE:            'http://fhir.de/StructureDefinition/Encounter',
  ISIK_ENCOUNTER:          'https://gematik.de/fhir/isik/StructureDefinition/ISiKKontaktGesundheitseinrichtung',
  CONDITION_DE:            'http://fhir.de/StructureDefinition/Condition',
  ISIK_CONDITION:          'https://gematik.de/fhir/isik/StructureDefinition/ISiKDiagnose',
  ISIK_DOCUMENT_REFERENCE: 'https://gematik.de/fhir/isik/StructureDefinition/ISiKDokumentenInformationen',
} as const;

// ─── Identifier system URIs (mirrors fhir_de.py IdentifierSystem) ────────────

const SID = {
  GKV_KVID:  'http://fhir.de/sid/gkv/kvid-10',
  KH_INTERN: 'https://morafek.app/fhir/sid/patient-id',
  AUFNAHME:  'https://morafek.app/fhir/sid/aufnahmenummer',
} as const;

// ─── Internal helpers ─────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function makeEntry(resource: Record<string, unknown>): Record<string, unknown> {
  return {
    fullUrl:  `urn:uuid:${resource['id']}`,
    resource,
  };
}

// ─── Resource builders ────────────────────────────────────────────────────────

/**
 * Build a de.basisprofil.r4 + ISiK-compliant FHIR Patient resource.
 * Mirrors build_fhir_patient() in fhir_de.py.
 */
function buildPatient(
  user: UserParam,
  gkvKvid: string | null,
  phone: string | null,
  street: string | null,
  postalCode: string | null,
  city: string | null,
): Record<string, unknown> {
  const identifiers: unknown[] = [
    { system: SID.KH_INTERN, value: user.id },
  ];

  if (gkvKvid) {
    identifiers.push({
      type: {
        coding: [{
          system:  'http://fhir.de/CodeSystem/identifier-type-de-basis',
          code:    'GKV',
          display: 'Gesetzliche Krankenversicherung',
        }],
      },
      system: SID.GKV_KVID,
      value:  gkvKvid,
    });
  }

  const nameEntry: Record<string, unknown> = {
    use:    'official',
    family: user.last_name,
    given:  user.first_name ? [user.first_name] : [],
    _family: {
      extension: [{
        url:         'http://hl7.org/fhir/StructureDefinition/humanname-own-name',
        valueString: user.last_name,
      }],
    },
  };

  const addressList: unknown[] = [];
  if (street || postalCode || city) {
    const addr: Record<string, unknown> = {
      type:    'both',
      use:     'home',
      country: 'DE',
    };
    if (street) {
      addr['line'] = [street];
      addr['_line'] = [{
        extension: [{
          url:         'http://hl7.org/fhir/StructureDefinition/iso21090-ADXP-streetName',
          valueString: street,
        }],
      }];
    }
    if (postalCode) addr['postalCode'] = postalCode;
    if (city)       addr['city']       = city;
    addressList.push(addr);
  }

  const resource: Record<string, unknown> = {
    resourceType: 'Patient',
    id:           user.id,
    meta: {
      profile:     [PROFILE.PATIENT_DE, PROFILE.ISIK_PATIENT],
      lastUpdated: nowIso(),
    },
    identifier: identifiers,
    active:     true,
    name:       [nameEntry],
    telecom:    phone
      ? [{ system: 'phone', value: phone, use: 'home' }]
      : [],
  };

  if (user.date_of_birth) resource['birthDate'] = user.date_of_birth;
  if (addressList.length > 0) resource['address'] = addressList;

  return resource;
}

/**
 * Convert a single VitalResponse into 1-2 FHIR Observation resources.
 * Blood pressure (systolic + diastolic) share one Observation under
 * LOINC 55284-4; pulse is its own Observation under 8867-4.
 * Mirrors build_observations_from_vitals_doc() in fhir_de.py.
 */
function buildObservations(
  vital: VitalResponse,
  patientId: string,
): Record<string, unknown>[] {
  const base: Record<string, unknown> = {
    status: 'final',
    category: [{
      coding: [{
        system:  'http://terminology.hl7.org/CodeSystem/observation-category',
        code:    'vital-signs',
        display: 'Vital Signs',
      }],
    }],
    subject:           { reference: `Patient/${patientId}` },
    effectiveDateTime: vital.timestamp,
    performer:         [{ reference: `Patient/${patientId}` }],
  };

  const observations: Record<string, unknown>[] = [];

  // Blood pressure — systolic + diastolic share one Observation (LOINC 55284-4)
  if (vital.systolic != null || vital.diastolic != null) {
    const components: unknown[] = [];
    if (vital.systolic != null) {
      components.push({
        code:          { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic BP' }] },
        valueQuantity: { value: vital.systolic, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' },
      });
    }
    if (vital.diastolic != null) {
      components.push({
        code:          { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastolic BP' }] },
        valueQuantity: { value: vital.diastolic, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' },
      });
    }
    observations.push({
      resourceType: 'Observation',
      id:           vital.id,
      meta: { profile: [PROFILE.OBSERVATION_DE, PROFILE.ISIK_OBSERVATION_VITALS] },
      ...base,
      code:      { coding: [{ system: 'http://loinc.org', code: '55284-4', display: 'Blood pressure systolic and diastolic' }] },
      component: components,
    });
  }

  // Heart rate — LOINC 8867-4
  if (vital.pulse != null) {
    observations.push({
      resourceType: 'Observation',
      id:           crypto.randomUUID(),
      meta: { profile: [PROFILE.OBSERVATION_DE, PROFILE.ISIK_OBSERVATION_VITALS] },
      ...base,
      code:          { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }] },
      valueQuantity: { value: vital.pulse, unit: '/min', system: 'http://unitsofmeasure.org', code: '/min' },
    });
  }

  return observations;
}

/**
 * Build a de.basisprofil.r4 + ISiK-compliant FHIR Encounter from a VisitResponse.
 * Mirrors build_isik_encounter_fields() in fhir_de.py.
 */
function buildEncounter(
  visit: VisitResponse,
  patientId: string,
): Record<string, unknown> {
  const encounterId = visit.encounter_fhir_id ?? crypto.randomUUID();

  return {
    resourceType: 'Encounter',
    id:           encounterId,
    meta: {
      profile: [PROFILE.ENCOUNTER_DE, PROFILE.ISIK_ENCOUNTER],
    },
    identifier: [{
      type: {
        coding: [{
          system:  'http://terminology.hl7.org/CodeSystem/v2-0203',
          code:    'VN',
          display: 'Visit number',
        }],
      },
      system: SID.AUFNAHME,
      value:  encounterId,
    }],
    status: 'finished',
    class:  {
      system:  'http://terminology.hl7.org/CodeSystem/v3-ActCode',
      code:    'AMB',
      display: 'ambulatory',
    },
    type: [{
      coding: [{
        system:  'http://snomed.info/sct',
        code:    '11429006',
        display: 'Consultation',
      }],
    }],
    serviceType: {
      coding: [{
        system:  'https://www.medizininformatik-initiative.de/fhir/core/modul-fall/CodeSystem/Fachabteilungsschluessel',
        code:    '0100',
        display: 'Innere Medizin',
      }],
    },
    subject: { reference: `Patient/${patientId}` },
    period:  { start: visit.visit_date },
    ...(visit.chief_complaint
      ? { reasonCode: [{ text: visit.chief_complaint }] }
      : {}),
    ...(visit.diagnosis_icd10 ? {
      diagnosis: [{
        condition: {
          coding: [{
            system:  'http://fhir.de/CodeSystem/dimdi/icd-10-gm',
            code:    visit.diagnosis_icd10,
            display: visit.diagnosis_text ?? '',
          }],
        },
      }],
    } : {}),
    ...(visit.notes ? { note: [{ text: visit.notes }] } : {}),
  };
}

/**
 * Build a de.basisprofil.r4 + ISiK-compliant FHIR Condition.
 * Mirrors build_isik_condition_fields() in fhir_de.py.
 */
function buildCondition(
  row: ConditionRow,
  patientId: string,
): Record<string, unknown> {
  return {
    resourceType: 'Condition',
    id:           row.id,
    meta: {
      profile: [PROFILE.CONDITION_DE, PROFILE.ISIK_CONDITION],
    },
    clinicalStatus: {
      coding: [{
        system:  'http://terminology.hl7.org/CodeSystem/condition-clinical',
        code:    row.clinical_status || 'active',
        display: row.clinical_status || 'Active',
      }],
    },
    verificationStatus: {
      coding: [{
        system:  'http://terminology.hl7.org/CodeSystem/condition-ver-status',
        code:    'confirmed',
        display: 'Confirmed',
      }],
    },
    code: {
      coding: [{
        system:  'http://fhir.de/CodeSystem/dimdi/icd-10-gm',
        code:    row.icd10_code,
        display: row.icd10_text,
      }],
      text: row.icd10_text,
    },
    subject:      { reference: `Patient/${patientId}` },
    encounter:    row.encounter_id
      ? { reference: `Encounter/${row.encounter_id}` }
      : undefined,
    onsetDateTime: row.onset_date || undefined,
    recordedDate:  row.onset_date || nowIso(),
  };
}

/**
 * Build an ISiK-compliant FHIR DocumentReference from a DocumentResponse.
 * Mirrors the ISiK ISiKDokumentenInformationen profile expectations.
 */
function buildDocumentReference(
  doc: DocumentResponse,
  patientId: string,
): Record<string, unknown> {
  return {
    resourceType: 'DocumentReference',
    id:           doc.id,
    meta: {
      profile: [PROFILE.ISIK_DOCUMENT_REFERENCE],
    },
    status:      'current',
    type: {
      coding: [{
        system:  'https://morafek.app/fhir/CodeSystem/document-category',
        code:    doc.category,
        display: doc.category,
      }],
    },
    description: doc.description,
    subject:     { reference: `Patient/${patientId}` },
    date:        doc.created_at,
    content:     [{ attachment: { url: doc.url, title: doc.description } }],
  };
}

/**
 * Build a FHIR CarePlan from an ExerciseResponse.
 * Exercises are modelled as a CarePlan with one activity.detail per exercise.
 */
function buildCarePlan(
  exercise: ExerciseResponse,
  patientId: string,
): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    kind:        'Task',
    description: exercise.description,
    status:      'not-started',
    ...(exercise.frequency      ? { scheduledString: exercise.frequency }   : {}),
    ...(exercise.duration_minutes != null
      ? { dailyAmount: { value: exercise.duration_minutes, unit: 'min', system: 'http://unitsofmeasure.org', code: 'min' } }
      : {}),
  };

  return {
    resourceType: 'CarePlan',
    id:           exercise.id,
    status:       'active',
    intent:       'plan',
    title:        exercise.title,
    description:  exercise.description,
    subject:      { reference: `Patient/${patientId}` },
    category: [{
      coding: [{
        system:  'https://morafek.app/fhir/CodeSystem/exercise-category',
        code:    exercise.category,
        display: exercise.category,
      }],
    }],
    activity: [{
      detail: {
        ...detail,
        ...(exercise.repetitions != null ? { quantity: { value: exercise.repetitions, unit: 'repetitions' } } : {}),
        ...(exercise.notes ? { description: exercise.notes } : {}),
      },
    }],
    ...(exercise.video_url ? { extension: [{ url: 'https://morafek.app/fhir/StructureDefinition/exercise-video-url', valueUri: exercise.video_url }] } : {}),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Shape of the user object required by buildLocalFhirBundle. */
export interface UserParam {
  id:            string;
  first_name:    string;
  last_name:     string;
  date_of_birth: string;
  user_type:     string;
}

/**
 * Reads all local SQLite tables and assembles a FHIR R4 "collection" Bundle
 * entirely offline.
 *
 * DSGVO / GDPR relevance: this function produces a complete, unencrypted copy
 * of the patient's health record as FHIR JSON.  The return value must be
 * immediately passed to encryptBundle() (fhirCrypto.ts) before being stored
 * or shared.  No data leaves the device during this call.
 *
 * @param user - Minimal user object from the auth store.
 * @returns JSON string of a FHIR R4 Bundle (resourceType "collection").
 */
export async function buildLocalFhirBundle(user: UserParam): Promise<string> {
  // Read all local caches — synchronous SQLite calls wrapped in a Promise
  // so callers can always await this function.
  const vitals     = getCachedVitals();
  const visits     = getCachedVisits();
  const conditions = getCachedConditions();
  const documents  = getCachedDocuments();
  const exercises  = getCachedExercises();
  const fhirIds    = getPatientFhirIdentifiers(user.id);

  const entries: Record<string, unknown>[] = [];

  // ── Patient ────────────────────────────────────────────────────────────────
  const patient = buildPatient(
    user,
    fhirIds?.gkv_kvid   ?? null,
    fhirIds?.phone       ?? null,
    fhirIds?.street      ?? null,
    fhirIds?.postal_code ?? null,
    fhirIds?.city        ?? null,
  );
  entries.push(makeEntry(patient));

  // ── Observations (vitals) ──────────────────────────────────────────────────
  for (const vital of vitals) {
    for (const obs of buildObservations(vital, user.id)) {
      entries.push(makeEntry(obs));
    }
  }

  // ── Encounters (visits) ───────────────────────────────────────────────────
  for (const visit of visits) {
    entries.push(makeEntry(buildEncounter(visit, user.id)));
  }

  // ── Conditions ────────────────────────────────────────────────────────────
  for (const cond of conditions) {
    entries.push(makeEntry(buildCondition(cond, user.id)));
  }

  // ── DocumentReferences ────────────────────────────────────────────────────
  for (const doc of documents) {
    entries.push(makeEntry(buildDocumentReference(doc, user.id)));
  }

  // ── CarePlans (exercises) ─────────────────────────────────────────────────
  for (const exercise of exercises) {
    entries.push(makeEntry(buildCarePlan(exercise, user.id)));
  }

  const bundle = {
    resourceType: 'Bundle',
    id:           crypto.randomUUID(),
    meta: {
      profile:     ['http://hl7.org/fhir/StructureDefinition/Bundle'],
      lastUpdated: nowIso(),
    },
    type:      'collection',
    timestamp: nowIso(),
    total:     entries.length,
    entry:     entries,
  };

  return JSON.stringify(bundle, null, 2);
}
