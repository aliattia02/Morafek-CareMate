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
  device: {
    display: 'health_connect';
  };
  extension: Array<{
    url: 'https://morafek.app/fhir/StructureDefinition/device-type';
    valueString: 'android_watch';
  }>;
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