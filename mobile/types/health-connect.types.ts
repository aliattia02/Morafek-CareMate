/**
 * health-connect.types.ts — Google Health Connect type definitions for Morafek CareMate
 * Location: mobile/types/health-connect.types.ts
 *
 * Mirrors watch.types.ts patterns from DiaTwin, but replaces Google Fit
 * OAuth/server-side types with Health Connect on-device SDK types.
 *
 * Key differences from watch.types.ts:
 *   • No OAuth tokens, no server-side connection documents
 *   • Permission state is Android system-level (granted/denied by OS)
 *   • Sync produces FHIR Observations, not activity sessions
 *   • Record counts are broken down by data type (heart_rate, steps, etc.)
 */

// ─── SDK / Permission state ───────────────────────────────────────────────────

/**
 * Maps directly onto react-native-health-connect's SdkAvailabilityStatus enum.
 * Values 1/2/3 match the SDK constants — kept as a union for TypeScript safety.
 */
export type HCSdkStatus =
  | 'SDK_AVAILABLE'        // Health Connect is installed and ready
  | 'SDK_UNAVAILABLE'      // Device does not support Health Connect
  | 'SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED'; // HC app needs updating

/** Per-record-type permission entry, mirrors requestPermission() input shape. */
export interface HCPermissionRequest {
  accessType: 'read';
  recordType: HCRecordType;
}

// ─── Supported record types ───────────────────────────────────────────────────

/**
 * The Health Connect record types Morafek currently reads.
 * Add new values here as the registry expands.
 */
export type HCRecordType =
  | 'HeartRate'
  | 'Steps'
  | 'OxygenSaturation' // reserved — future SpO₂
  | 'Weight'           // reserved — future weight
  | 'BloodGlucose'     // reserved — future DiaTwin crossover
  | 'SleepSession';    // reserved — future sleep

// ─── Type registry entry ──────────────────────────────────────────────────────

/**
 * One row in the HC_DATA_TYPES registry (health-connect-mapper.ts).
 * Adding a new entry to that registry is the only change needed to support
 * a new data type end-to-end.
 */
export interface HCDataTypeConfig {
  /** LOINC code to use in the FHIR Observation.code */
  loincCode: string;
  /** Display name for the LOINC code */
  loincDisplay: string;
  /** UCUM unit string for FHIR Observation.valueQuantity */
  unit: string;
  /** UCUM unit code (may differ from display, e.g. '/min' vs 'beats/min') */
  unitCode: string;
  /** Health Connect SDK record type string */
  hcRecord: HCRecordType;
}

// ─── Data origin filtering (cross-source duplicate/overlap fix) ───────────────
//
// Health Connect's readRecords() returns records from EVERY app that has
// ever written to it, tagged via record.metadata.dataOrigin. This is NOT
// the same as Health Connect's own "Data sources and priority" Settings UI
// — that priority only affects HC's internal aggregate queries (e.g. a step
// widget total); it has no effect on raw readRecords() results.
//
// Confirmed via direct inspection: Samsung Health, Google Fit, and Health
// Sync all write genuinely overlapping (not identical — the deterministic-ID
// dedup in health-connect-mapper.ts does not catch this) heart-rate data for
// the same time windows. The fix has to happen in Morafek's own code, by
// filtering raw records on metadata.dataOrigin before they reach the mapper.

/**
 * Known Health Connect contributing app package names, for reference and
 * debug display. Values other than GOOGLE_FIT are unverified against this
 * device's actual metadata.dataOrigin strings — cross-check against the
 * debug card / Health Connect's own data screen before relying on them.
 */
export const HC_KNOWN_ORIGINS = {
  GOOGLE_FIT: 'com.google.android.apps.fitness',
  SAMSUNG_HEALTH: 'com.sec.android.app.shealth',
  HEALTH_SYNC: 'nl.appyhapps.healthsync',
} as const;

/**
 * Preferred dataOrigin per Morafek data-type key (heart_rate, steps, ...).
 * These are the DEFAULT values layered under a patient's stored overrides —
 * see preferredOriginsByUser / getPreferredOriginsForUser in
 * health-connect.store.ts, and preferredOrigins/setPreferredOrigin on
 * UseHealthConnectReturn. readAllRecords() in useHealthConnect.ts uses the
 * resolved (defaults + per-user overrides) map to discard records from
 * non-preferred sources before they reach the mapper.
 *
 * Decision: Google Fit is the default for all current types — its
 * per-sample granularity/values closely match the underlying watch data,
 * while Health Sync's writes are coarser bridge summaries less suitable for
 * a medical record.
 */
export const DEFAULT_PREFERRED_ORIGINS: Record<string, string> = {
  heart_rate: HC_KNOWN_ORIGINS.GOOGLE_FIT,
  steps: HC_KNOWN_ORIGINS.GOOGLE_FIT,
};

/** Per-data-type origin preference map, as used by readAllRecords(). */
export type HCOriginPreferences = Record<string, string>;

// ─── Source-app identification (FIX 9) ────────────────────────────────────────
//
// Distinct from the filtering constants above: HC_KNOWN_ORIGINS /
// DEFAULT_PREFERRED_ORIGINS decide WHICH source's records survive the FIX 8
// filter in useHealthConnect.ts. The constants below decide how the
// surviving record's origin gets STAMPED onto the FHIR Observation that
// health-connect-mapper.ts builds from it, so the app it came from isn't
// discarded once the reading passes the filter.
//
// SOURCE_APP_IDENTIFIER_SYSTEM / SOURCE_APP_EXTENSION_URL must match
// backend/utils/fhir_health_connect.py's constants of the same name exactly
// — that file's _extract_source_app() checks device.identifier[] first,
// then falls back to extension[], in that order. Confirmed against the
// actual backend file: identical strings, identical check order.

export const SOURCE_APP_IDENTIFIER_SYSTEM = 'https://morafek.app/fhir/source-app-package';
export const SOURCE_APP_EXTENSION_URL     = 'https://morafek.app/fhir/StructureDefinition/source-app';

/**
 * Best-effort friendly names for common Health Connect data sources, shown
 * in device.display instead of the raw package id when recognized.
 * NOT exhaustive — verify these package ids against what your devices
 * actually report (log `record.metadata?.dataOrigin` once to confirm) before
 * relying on the label in anything user-facing. Unrecognized packages are
 * never collapsed into "Other" — resolveSourceAppDisplay() falls back to the
 * raw id as-is, so new sources remain identifiable and can be added here
 * later.
 *
 * Deliberately keyed by explicit string literals rather than derived from
 * HC_KNOWN_ORIGINS' keys — avoids any casing/formatting mismatch between an
 * enum-style key (e.g. GOOGLE_FIT) and its intended display label.
 */
export const KNOWN_SOURCE_APPS: Record<string, string> = {
  'com.google.android.apps.fitness': 'Google Fit',
  'com.sec.android.app.shealth':     'Samsung Health',
  'nl.appyhapps.healthsync':         'Health Sync',
};

/** Resolve a raw dataOrigin package id to a friendly display name, or the raw id if unrecognized. */
export function resolveSourceAppDisplay(dataOrigin: string): string {
  return KNOWN_SOURCE_APPS[dataOrigin] ?? dataOrigin;
}

// ─── Raw HC SDK record shapes (minimal — only fields we consume) ──────────────

/** Heart rate sample within a HeartRate record */
export interface HCHeartRateSample {
  /** Beats per minute */
  beatsPerMinute: number;
  time: string; // ISO-8601
}

/** A single HeartRate record from readRecords('HeartRate', ...) */
export interface HCHeartRateRecord {
  startTime: string; // ISO-8601
  endTime: string;   // ISO-8601
  samples: HCHeartRateSample[];
  metadata?: HCRecordMetadata;
}

/** A single Steps record from readRecords('Steps', ...) */
export interface HCStepsRecord {
  startTime: string; // ISO-8601
  endTime: string;   // ISO-8601
  count: number;
  metadata?: HCRecordMetadata;
}

/** Common metadata fields on HC records */
export interface HCRecordMetadata {
  id?: string;
  dataOrigin?: string;
  lastModifiedTime?: string;
  clientRecordId?: string;
}

// ─── FHIR Observation (HC-flavoured) ─────────────────────────────────────────

/**
 * Shape of a FHIR R4 Observation as produced by health-connect-mapper.ts
 * and accepted by POST /api/healthconnect/sync.
 *
 * Follows the same structure as existing ehr_vitals documents in Morafek,
 * with two additional top-level fields: `source` and `device_type`.
 */
export interface HCFHIRObservation {
  resourceType: 'Observation';
  /** UUID v4 — client-generated */
  id: string;
  status: 'final';
  category: Array<{
    coding: Array<{
      system: 'http://terminology.hl7.org/CodeSystem/observation-category';
      code: 'vital-signs';
      display: 'Vital Signs';
    }>;
  }>;
  code: {
    coding: Array<{
      system: 'http://loinc.org';
      code: string;       // e.g. '8867-4'
      display: string;    // e.g. 'Heart rate'
    }>;
    text: string;
  };
  subject: {
    /** e.g. "Patient/507f1f77bcf86cd799439011" */
    reference: string;
  };
  /** ISO-8601 datetime of the measurement */
  effectiveDateTime: string;
  valueQuantity: {
    value: number;
    unit: string;    // human-readable, e.g. 'beats/min'
    system: 'http://unitsofmeasure.org';
    code: string;    // UCUM code, e.g. '/min'
  };
  /** Fixed: marks this Observation as originating from Health Connect */
  source: 'health_connect';
  /**
   * FIX 9: display widened from the literal 'health_connect' to a general
   * string — it now shows a friendly source-app name (KNOWN_SOURCE_APPS) or
   * the raw package id when the record's dataOrigin is known, falling back
   * to the original 'health_connect' literal when it isn't. identifier is
   * optional and only populated when dataOrigin is present on the source
   * record (see buildBaseObservation() in health-connect-mapper.ts).
   */
  device: {
    display: string;
    identifier?: Array<{ system: string; value: string }>;
  };
  /**
   * FIX 9: widened from a single fixed-shape entry to a general array so it
   * can carry both the original device-type entry and, when available, a
   * second source-app entry (SOURCE_APP_EXTENSION_URL) alongside it.
   */
  extension: Array<{ url: string; valueString: string }>;
}

// ─── API request / response shapes ───────────────────────────────────────────

/** POST /api/healthconnect/sync — request body */
export interface HCSyncRequest {
  observations: HCFHIRObservation[];
}

/** POST /api/healthconnect/sync — response body */
export interface HCSyncResponse {
  message: string;
  /** Total observations received in the request */
  received: number;
  /** Observations actually inserted (new, not duplicates) */
  inserted: number;
  /** Observations skipped (duplicate id or invalid LOINC) */
  skipped: number;
}

/** GET /api/healthconnect/status — response body */
export interface HCStatusResponse {
  /** Whether there is any Health Connect data for this patient */
  has_data: boolean;
  /** ISO-8601 datetime of the most recent synced observation */
  last_sync: string | null;
  /** Count of HC-sourced observations per data type */
  counts: HCRecordCounts;
}

/** Record counts broken down by internal data-type key */
export interface HCRecordCounts {
  heart_rate: number;
  steps: number;
  [key: string]: number; // extensible for future types
}

// ─── Hook return type ─────────────────────────────────────────────────────────

/** Return type of the useHealthConnect() hook */
export interface UseHealthConnectReturn {
  /** True when running on Android with Health Connect available */
  isSupported: boolean;
  /** True when all required permissions have been granted by the OS */
  isPermissionGranted: boolean;
  /**
   * True when the OS will no longer show the permission dialog because the
   * user previously selected "Don't ask again". When true, the UI should
   * surface the openSettings() action so the user can grant permissions
   * manually in the Health Connect settings screen.
   */
  isPermanentlyDenied: boolean;
  /** ISO-8601 datetime of last successful sync, or null */
  lastSync: string | null;
  /** Number of observations sent in the most recent sync */
  syncCount: number;
  /** Record counts from the backend status endpoint */
  counts: HCRecordCounts;
  /** Last error message, or null */
  error: string | null;
  /** True while a sync is in progress */
  isSyncing: boolean;
  /** True while the initial status is loading */
  isLoading: boolean;
  /**
   * TEMP DEBUG — inline diagnostic text from the most recent sync() call
   * (raw record counts, sample record shapes, patient ID resolution, etc).
   * Null until the first sync attempt. Remove this field once the
   * empty-sync root cause is confirmed and fixed.
   */
  debugInfo: string | null;
  /** TEMP DEBUG — clears debugInfo. Remove alongside debugInfo. */
  clearDebugInfo: () => void;
  /** Request Android Health Connect permissions */
  requestPermission: () => Promise<void>;
  /**
   * Opens the Health Connect system settings screen so the user can manually
   * grant permissions that were permanently denied. Only actionable when
   * isPermanentlyDenied is true.
   */
  openSettings: () => Promise<void>;
  /** Read HC records and POST FHIR Observations to backend */
  sync: (hoursBack?: number) => Promise<HCSyncResponse | null>;
  /** Reload status from backend without syncing */
  refreshStatus: () => Promise<void>;
  /**
   * Active per-data-type preferred dataOrigin map (see FIX 8 /
   * DEFAULT_PREFERRED_ORIGINS). Starts as a copy of DEFAULT_PREFERRED_ORIGINS
   * and can be overridden at runtime via setPreferredOrigin — e.g. from a
   * settings screen, if the user switches primary tracking app/watch.
   * Tied to the current patient and persisted via health-connect.store.ts
   * (keyed by user._id), so it survives app restarts and stays isolated
   * per patient on a shared device.
   */
  preferredOrigins: HCOriginPreferences;
  /** Override the preferred dataOrigin for one data-type key (e.g. 'heart_rate'). */
  setPreferredOrigin: (dataType: string, origin: string) => void;
}

// ─── Display helpers ──────────────────────────────────────────────────────────

/**
 * Human-readable relative time: '3 min ago', '2 hr ago', etc.
 * Matches timeAgo() in watch.types.ts for UI consistency.
 */
export function timeAgo(isoString: string): string {
  const diffMs  = Date.now() - new Date(isoString).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 2)  return 'gerade eben';
  if (diffMin < 60) return `vor ${diffMin} Min.`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24)  return `vor ${diffHr} Std.`;
  const diffDay = Math.floor(diffHr / 24);
  return `vor ${diffDay} Tag${diffDay === 1 ? '' : 'en'}`;
}

/** Format an ISO-8601 date string as a short German locale date */
export function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}