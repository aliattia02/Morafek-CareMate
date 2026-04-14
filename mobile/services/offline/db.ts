/**
 * Offline SQLite Cache (Mobile) + Web Fallback
 */

import { Platform } from 'react-native';
import type {
  VitalResponse,
  VisitResponse,
  ExerciseResponse,
  DocumentResponse,
  MessageResponse,
} from '@/services/api/ehr';

export interface ConditionRow {
  id: string;
  icd10_code: string;
  icd10_text: string;
  clinical_status: string;
  encounter_id: string;
  onset_date: string;
}

export interface PatientFhirIdentifiers {
  patient_id: string;
  gkv_kvid: string;
  phone: string;
  street: string;
  postal_code: string;
  city: string;
}

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
      } else if (query.includes('INSERT OR REPLACE INTO vitals')) {
        const idx = vitals.findIndex((v) => v.id === params[0]);
        const entry = {
          id: params[0],
          systolic: params[1],
          diastolic: params[2],
          pulse: params[3],
          urgent: params[4],
          timestamp: params[5],
        };
        if (idx !== -1) {
          vitals[idx] = entry;
        } else {
          vitals.push(entry);
        }
      } else if (query.includes('INTO vitals')) {
        vitals.push({
          id: params[0],
          systolic: params[1],
          diastolic: params[2],
          pulse: params[3],
          urgent: params[4],
          timestamp: params[5],
        });
      }
    },
    getAllSync: (query: string) => {
      if (query.includes('pending_vitals')) return pendingVitals;
      if (query.includes('FROM vitals')) {
        return [...vitals]
          .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
          .slice(0, 50);
      }
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
      doctor_id TEXT,
      encounter_fhir_id TEXT
    );
    CREATE TABLE IF NOT EXISTS conditions (
      id TEXT PRIMARY KEY,
      icd10_code TEXT,
      icd10_text TEXT,
      clinical_status TEXT,
      encounter_id TEXT,
      onset_date TEXT
    );
    CREATE TABLE IF NOT EXISTS exercises (
      id TEXT PRIMARY KEY,
      doctor_id TEXT,
      title TEXT,
      description TEXT,
      category TEXT,
      frequency TEXT,
      duration_minutes INTEGER,
      repetitions INTEGER,
      sets INTEGER,
      video_url TEXT,
      image_url TEXT,
      notes TEXT,
      done INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      category TEXT,
      description TEXT,
      url TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT,
      receiver_id TEXT,
      sender_type TEXT,
      body TEXT,
      read INTEGER DEFAULT 0,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS patient_fhir_identifiers (
      patient_id TEXT PRIMARY KEY,
      gkv_kvid TEXT,
      phone TEXT,
      street TEXT,
      postal_code TEXT,
      city TEXT
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

// ─────────────────────────────────────────────────────────────────────────────
// Visits
// ─────────────────────────────────────────────────────────────────────────────

export function cacheVisits(visits: VisitResponse[]) {
  if (Platform.OS === 'web') return;

  for (const v of visits) {
    db.runSync(
      `INSERT OR REPLACE INTO visits
        (id, visit_date, chief_complaint, diagnosis_icd10, diagnosis_text, notes, doctor_id, encounter_fhir_id)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        v.id,
        v.visit_date,
        v.chief_complaint,
        v.diagnosis_icd10,
        v.diagnosis_text,
        v.notes,
        v.doctor_id,
        v.encounter_fhir_id ?? null,
      ]
    );
  }
}

export function getCachedVisits(): VisitResponse[] {
  if (Platform.OS === 'web') return [];

  return db.getAllSync(`SELECT * FROM visits ORDER BY visit_date DESC`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Conditions
// ─────────────────────────────────────────────────────────────────────────────

export function cacheConditions(conditions: ConditionRow[]) {
  if (Platform.OS === 'web') return;

  for (const c of conditions) {
    db.runSync(
      `INSERT OR REPLACE INTO conditions
        (id, icd10_code, icd10_text, clinical_status, encounter_id, onset_date)
       VALUES (?,?,?,?,?,?)`,
      [c.id, c.icd10_code, c.icd10_text, c.clinical_status, c.encounter_id, c.onset_date]
    );
  }
}

export function getCachedConditions(): ConditionRow[] {
  if (Platform.OS === 'web') return [];

  return db.getAllSync(`SELECT * FROM conditions ORDER BY onset_date DESC`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exercises
// ─────────────────────────────────────────────────────────────────────────────

export function cacheExercises(exercises: ExerciseResponse[]) {
  if (Platform.OS === 'web') return;

  for (const e of exercises) {
    db.runSync(
      `INSERT OR REPLACE INTO exercises
        (id, doctor_id, title, description, category, frequency,
         duration_minutes, repetitions, sets, video_url, image_url, notes, done)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(
         (SELECT done FROM exercises WHERE id = ?), 0
       ))`,
      [
        e.id,
        null,
        e.title,
        e.description,
        e.category,
        e.frequency,
        e.duration_minutes ?? null,
        e.repetitions ?? null,
        e.sets ?? null,
        e.video_url ?? null,
        e.image_url ?? null,
        e.notes ?? null,
        e.id,
      ]
    );
  }
}

export function getCachedExercises(): (ExerciseResponse & { done: boolean })[] {
  if (Platform.OS === 'web') return [];

  const rows = db.getAllSync(`SELECT * FROM exercises ORDER BY title ASC`);
  return rows.map((r: any) => ({ ...r, done: r.done === 1 }));
}

export function markExerciseDoneLocal(exerciseId: string, done: boolean) {
  if (Platform.OS === 'web') return;

  db.runSync(`UPDATE exercises SET done = ? WHERE id = ?`, [done ? 1 : 0, exerciseId]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Documents
// ─────────────────────────────────────────────────────────────────────────────

export function cacheDocuments(documents: DocumentResponse[]) {
  if (Platform.OS === 'web') return;

  for (const d of documents) {
    db.runSync(
      `INSERT OR REPLACE INTO documents
        (id, category, description, url, created_at)
       VALUES (?,?,?,?,?)`,
      [d.id, d.category, d.description, d.url, d.created_at]
    );
  }
}

export function getCachedDocuments(): DocumentResponse[] {
  if (Platform.OS === 'web') return [];

  return db.getAllSync(`SELECT * FROM documents ORDER BY created_at DESC`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────────────────────────────────────

export function cacheMessages(messages: MessageResponse[]) {
  if (Platform.OS === 'web') return;

  for (const m of messages) {
    db.runSync(
      `INSERT OR REPLACE INTO messages
        (id, sender_id, receiver_id, sender_type, body, read, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      // DB column is receiver_id; MessageResponse uses recipient_id
      [m.id, m.sender_id, m.recipient_id, m.sender_type, m.body, m.read ? 1 : 0, m.created_at]
    );
  }
}

export function getCachedMessages(): MessageResponse[] {
  if (Platform.OS === 'web') return [];

  const rows = db.getAllSync(`SELECT * FROM messages ORDER BY created_at ASC`);
  return rows.map((r: any) => ({
    id: r.id,
    sender_id: r.sender_id,
    // DB column is receiver_id; map back to recipient_id for MessageResponse
    recipient_id: r.receiver_id,
    sender_type: r.sender_type as MessageResponse['sender_type'],
    body: r.body,
    read: r.read === 1,
    created_at: r.created_at,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Patient FHIR Identifiers
// ─────────────────────────────────────────────────────────────────────────────

export function savePatientFhirIdentifiers(data: PatientFhirIdentifiers) {
  if (Platform.OS === 'web') return;

  db.runSync(
    `INSERT OR REPLACE INTO patient_fhir_identifiers
      (patient_id, gkv_kvid, phone, street, postal_code, city)
     VALUES (?,?,?,?,?,?)`,
    [data.patient_id, data.gkv_kvid, data.phone, data.street, data.postal_code, data.city]
  );
}

export function getPatientFhirIdentifiers(patientId: string): PatientFhirIdentifiers | null {
  if (Platform.OS === 'web') return null;

  const rows = db.getAllSync(
    `SELECT * FROM patient_fhir_identifiers WHERE patient_id = ?`,
    [patientId]
  );
  return rows.length > 0 ? (rows[0] as PatientFhirIdentifiers) : null;
}