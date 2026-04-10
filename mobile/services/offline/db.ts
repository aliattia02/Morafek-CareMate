/**
 * Offline SQLite Cache
 * Location: mobile/services/offline/db.ts
 *
 * Caches vitals and visits locally; queues pending vitals for sync.
 */

import * as SQLite from 'expo-sqlite';
import type { VitalResponse } from '@/services/api/ehr';

// The database is opened synchronously at module load time.
// expo-sqlite will throw if the database cannot be opened (e.g. insufficient storage).
const db = SQLite.openDatabaseSync('morafek.db');

export function initDB() {
  db.execSync(`
    CREATE TABLE IF NOT EXISTS vitals (
      id TEXT PRIMARY KEY,
      systolic INTEGER,
      diastolic INTEGER,
      pulse INTEGER,
      urgent INTEGER,
      timestamp TEXT
    );
    CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY,
      visit_date TEXT,
      chief_complaint TEXT,
      diagnosis_icd10 TEXT,
      diagnosis_text TEXT,
      notes TEXT,
      doctor_id TEXT
    );
    CREATE TABLE IF NOT EXISTS pending_vitals (
      local_id TEXT PRIMARY KEY,
      systolic INTEGER,
      diastolic INTEGER,
      pulse INTEGER,
      weight_kg REAL,
      notes TEXT,
      created_at TEXT
    );
  `);
}

export function cacheVitals(vitals: VitalResponse[]) {
  for (const v of vitals) {
    db.runSync(
      `INSERT OR REPLACE INTO vitals VALUES (?,?,?,?,?,?)`,
      [v.id, v.systolic, v.diastolic, v.pulse, v.urgent ? 1 : 0, v.timestamp]
    );
  }
}

export function getCachedVitals(): VitalResponse[] {
  const rows = db.getAllSync<{
    id: string;
    systolic: number;
    diastolic: number;
    pulse: number;
    urgent: number;
    timestamp: string;
  }>(`SELECT * FROM vitals ORDER BY timestamp DESC LIMIT 50`);
  return rows.map((r) => ({ ...r, urgent: r.urgent === 1 }));
}

export interface PendingVital {
  local_id: string;
  systolic: number;
  diastolic: number;
  pulse: number;
  weight_kg: number | null;
  notes: string | null;
  created_at: string;
}

export function queueVital(data: {
  systolic: number;
  diastolic: number;
  pulse: number;
  weight_kg?: number;
  notes?: string;
}): string {
  const localId = `local_${Date.now()}`;
  db.runSync(
    `INSERT INTO pending_vitals VALUES (?,?,?,?,?,?,?)`,
    [
      localId,
      data.systolic,
      data.diastolic,
      data.pulse,
      data.weight_kg ?? null,
      data.notes ?? null,
      new Date().toISOString(),
    ]
  );
  return localId;
}

export function getPendingVitals(): PendingVital[] {
  return db.getAllSync<PendingVital>(`SELECT * FROM pending_vitals`);
}

export function deletePendingVital(localId: string) {
  db.runSync(`DELETE FROM pending_vitals WHERE local_id = ?`, [localId]);
}
