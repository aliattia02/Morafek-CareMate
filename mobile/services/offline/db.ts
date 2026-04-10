/**
 * Offline SQLite Cache (Mobile) + Web Fallback
 */

import { Platform } from 'react-native';
import type { VitalResponse } from '@/services/api/ehr';

let db: any;

// 👉 MOBILE: real SQLite
if (Platform.OS !== 'web') {
  const SQLite = require('expo-sqlite');
  db = SQLite.openDatabaseSync('morafek.db');
}

// 👉 WEB: in-memory fallback so Expo web can run
else {
  console.log('SQLite disabled on Web — using in-memory DB');

  const vitals: any[] = [];
  const pendingVitals: any[] = [];

  db = {
    execSync: () => {},
    runSync: (query: string, params: any[]) => {
      if (query.includes('pending_vitals')) {
        pendingVitals.push({
          local_id: params[0],
          systolic: params[1],
          diastolic: params[2],
          pulse: params[3],
          weight_kg: params[4],
          notes: params[5],
          created_at: params[6],
        });
      }
    },
    getAllSync: (query: string) => {
      if (query.includes('pending_vitals')) return pendingVitals;
      if (query.includes('vitals')) return vitals;
      return [];
    },
  };
}

export function initDB() {
  if (Platform.OS === 'web') return; // no tables needed for web

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
  if (Platform.OS === 'web') return;

  for (const v of vitals) {
    db.runSync(
      `INSERT OR REPLACE INTO vitals VALUES (?,?,?,?,?,?)`,
      [v.id, v.systolic, v.diastolic, v.pulse, v.urgent ? 1 : 0, v.timestamp]
    );
  }
}

export function getCachedVitals(): VitalResponse[] {
  if (Platform.OS === 'web') return [];

  const rows = db.getAllSync(`
    SELECT * FROM vitals ORDER BY timestamp DESC LIMIT 50
  `);

  return rows.map((r: any) => ({ ...r, urgent: r.urgent === 1 }));
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
  return db.getAllSync(`SELECT * FROM pending_vitals`);
}

export function deletePendingVital(localId: string) {
  if (Platform.OS === 'web') return;
  db.runSync(`DELETE FROM pending_vitals WHERE local_id = ?`, [localId]);
}