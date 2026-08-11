# Morafek CareMate — Common Models Development Plan
## Build first, decide storage later

**Strategy:** Everything below compiles and runs identically under Approach A or B.  
The storage backend is hidden behind a **Repository interface** — when you pick an approach, you write one adapter, nothing else changes.

---

## Core Principle: Repository Pattern

```
Flask Routes
    └── Service Layer  (business logic, FHIR assembly, consent flow)
            └── Repository Interface  ← the seam
                    ├── [later] MongoRepository   (Approach A)
                    └── [later] OrbisOFIRepository (Approach B)
```

Every model, route, and mobile screen is written against the **interface only**.  
No `mongo_client`, no `requests.post(OFI_URL)` anywhere in common code.

---

## Phase 0 — Project Scaffold
**Goal:** Runnable skeleton with no storage dependency.

### Backend (`/backend`)
```
backend/
├── app/
│   ├── __init__.py          # Flask factory
│   ├── config.py            # env vars, feature flags (GPAS_ENABLED, etc.)
│   ├── repositories/
│   │   └── base.py          # Abstract Repository interface (see below)
│   ├── services/            # (empty, filled per phase)
│   ├── routes/              # (empty, filled per phase)
│   └── models/              # Pydantic / dataclass models (pure Python)
├── tests/
│   └── conftest.py          # in-memory stub repository for all tests
├── docker-compose.yml       # gICS + gPAS only (no DB yet)
└── requirements.txt
```

### `repositories/base.py` — the seam
```python
from abc import ABC, abstractmethod

class UserRepository(ABC):
    @abstractmethod
    def get_by_username(self, username: str, user_type: str): ...
    @abstractmethod
    def create(self, user: dict) -> str: ...
    @abstractmethod
    def update(self, user_id: str, fields: dict): ...
    @abstractmethod
    def delete(self, user_id: str): ...

class PatientRepository(ABC):
    @abstractmethod
    def get(self, patient_id: str): ...
    @abstractmethod
    def authorize_doctor(self, patient_id: str, doctor_id: str): ...
    @abstractmethod
    def revoke_doctor(self, patient_id: str, doctor_id: str): ...
    @abstractmethod
    def list_authorized_doctors(self, patient_id: str) -> list: ...

class ClinicalRepository(ABC):
    @abstractmethod
    def save_encounter(self, encounter: dict) -> str: ...
    @abstractmethod
    def list_encounters(self, patient_id: str) -> list: ...
    @abstractmethod
    def save_observation(self, observation: dict) -> str: ...
    @abstractmethod
    def list_observations(self, patient_id: str, type: str) -> list: ...
    @abstractmethod
    def save_medication_request(self, rx: dict) -> str: ...
    @abstractmethod
    def list_medication_requests(self, patient_id: str) -> list: ...
    @abstractmethod
    def save_condition(self, condition: dict) -> str: ...

class ConsentRepository(ABC):
    @abstractmethod
    def save_consent(self, patient_id: str, payload: dict): ...
    @abstractmethod
    def get_consent(self, patient_id: str): ...
```

### `tests/conftest.py` — in-memory stub (used for all unit tests)
```python
class InMemoryUserRepository(UserRepository):
    def __init__(self): self._store = {}
    def get_by_username(self, username, user_type):
        return self._store.get(f"{username}:{user_type}")
    def create(self, user):
        key = f"{user['username']}:{user['user_type']}"
        self._store[key] = user
        return key
    # ... etc.
```

**Deliverable:** `flask run` returns `{"status": "ok"}` from `/api/health`.  
**Tests:** All pass against `InMemoryRepository`.

---

## Phase 1 — Identity & Auth
**Depends on:** Phase 0  
**Storage touch:** `UserRepository` only

### Models (`app/models/user.py`)
```python
@dataclass
class User:
    id: str
    username: str
    email: str
    password_hash: str
    user_type: Literal["patient", "doctor", "admin"]
    first_name: str
    last_name: str
    date_of_birth: str
    # Doctor-specific
    lanr: str | None = None          # Lebenslange Arztnummer (9 digits)
    # Patient-specific
    gkv_kvid: str | None = None      # e.g. A123456789
    authorized_doctors: list[str] = field(default_factory=list)
    pseudonym: str | None = None
    is_active: bool = True
```

### Routes (`app/routes/auth.py`)
| Method | Path | Description |
|---|---|---|
| `POST` | `/login` | username + password + user_type → JWT (90-day mobile / 24-h web) |
| `POST` | `/register` | Create user; fire-and-forget gPAS pseudonym |
| `DELETE` | `/api/auth/delete-account` | Wipe user + clinical data; retain gPAS record |
| `GET` | `/api/health` | Liveness probe |

### Services (`app/services/auth.py`)
- `issue_token(user, mobile: bool) → str` — JWT with `exp`, `user_type`, `user_id`
- `verify_token(token) → dict` — validates signature + expiry
- `token_required` decorator — skips `OPTIONS`; checks `authorized_doctors` via `PatientRepository`
- `check_doctor_patient_access(doctor_id, patient_id)` — `doctor_id in patient.authorized_doctors`; admins bypass

### LANR & GKV-KVID validation (pure Python, no DB)
```python
import re

LANR_RE    = re.compile(r'^\d{9}$')
KVID_RE    = re.compile(r'^[A-Z]\d{9}$')

def validate_lanr(v: str) -> bool:  return bool(LANR_RE.match(v))
def validate_kvid(v: str) -> bool:  return bool(KVID_RE.match(v))
```

**Tests:** login, register, token expiry, LANR/KVID validation — all against `InMemoryUserRepository`.

---

## Phase 2 — Consent (gICS / gPAS)
**Depends on:** Phase 1  
**Storage touch:** `ConsentRepository` only  
**External services:** gICS 2025.x · gPAS 2025.x (Docker — same in both approaches)

### Models (`app/models/consent.py`)
```python
@dataclass
class ConsentRecord:
    patient_id: str
    pseudonym: str | None       # null if GPAS_ENABLED=false
    pseudonym_suffix: str | None  # last 4 chars only — sent to client
    gics_consent_id: str | None
    status: Literal["granted", "revoked", "pending"]
    granted_at: datetime | None
    revoked_at: datetime | None
```

### Routes (`app/routes/consent.py`)
| Method | Path | Flow | Notes |
|---|---|---|---|
| `POST` | `/api/consent/accept` | **Strict** | gICS + gPAS must succeed; rolls back gICS on gPAS failure |
| `POST` | `/api/patient/consent` | **Soft** | gICS/gPAS fire-and-forget; DB always written |
| `GET` | `/api/consent/status` | — | Returns status + masked pseudonym suffix |
| `PUT` | `/api/patient/fhir-identifiers` | — | Store GKV-KVID |

### Services (`app/services/consent.py`)
```python
class ConsentService:
    def __init__(self, repo: ConsentRepository, gics: GICSClient, gpas: GPASClient): ...

    def accept_strict(self, patient_id: str) -> ConsentRecord:
        # 1. Call gICS → get consent_id (raises on failure)
        # 2. Call gPAS get_or_create → get pseudonym (rolls back gICS on failure)
        # 3. repo.save_consent(...)
        # 4. Return record with suffix only

    def accept_soft(self, patient_id: str) -> ConsentRecord:
        # 1. repo.save_consent(status="granted") always
        # 2. gICS fire-and-forget
        # 3. gPAS fire-and-forget
```

### `app/services/ttp/gics.py` — gICS client (HTTP, no storage coupling)
```python
class GICSClient:
    def __init__(self, base_url: str): ...
    def grant_consent(self, patient_id: str) -> str: ...   # returns consent_id
    def revoke_consent(self, consent_id: str): ...
    def rollback(self, consent_id: str): ...               # used in strict flow
```

### `app/services/ttp/gpas.py` — gPAS client
```python
class GPASClient:
    def __init__(self, base_url: str, enabled: bool = True): ...
    def get_or_create(self, patient_id: str) -> str | None:
        if not self.enabled: return None
        ...
    def delete(self, pseudonym: str): ...
```

### `GPAS_ENABLED=false` mode
Set in `config.py`. `GPASClient.__init__` reads it. When `False`:  
- `get_or_create` returns `None`  
- `ConsentRecord.pseudonym = None`  
- FHIR export falls back to internal patient ID

**Docker (`docker-compose.yml`):**
```yaml
services:
  gics:
    image: mosaic-greifswald/gics:2025.x
    ports: ["8080:8080"]
  gpas:
    image: mosaic-greifswald/gpas:2025.x
    ports: ["8081:8081"]
  flask:
    build: .
    env_file: .env
    depends_on: [gics, gpas]
    # No DB service yet
```

**Tests:** strict flow, soft flow, gPAS unavailable fallback, rollback — all against `InMemoryConsentRepository`.

---

## Phase 3 — FHIR R4 Clinical Models
**Depends on:** Phase 1  
**Storage touch:** `ClinicalRepository` only  
**Profiles:** `de.basisprofil.r4` · ISiK Stage 1

These are pure Python dataclasses + FHIR assemblers. No DB calls inside.

### Models (`app/models/fhir/`)

#### `patient.py`
```python
def build_fhir_patient(user: User) -> dict:
    resource = {
        "resourceType": "Patient",
        "id": user.id,
        "name": [{"family": user.last_name, "given": [user.first_name]}],
        "birthDate": user.date_of_birth,
        "identifier": []
    }
    if user.gkv_kvid:
        resource["identifier"].append({
            "system": "http://fhir.de/sid/gkv/kvid-10",
            "value": user.gkv_kvid
        })
    return resource
```

#### `practitioner.py`
```python
def build_fhir_practitioner(user: User) -> dict:
    resource = {
        "resourceType": "Practitioner",
        "id": user.id,
        "name": [{"family": user.last_name, "given": [user.first_name]}],
        "identifier": []
    }
    if user.lanr:
        resource["identifier"].append({
            "system": "https://fhir.kbv.de/NamingSystem/KBV_NS_Base_ANR",
            "value": user.lanr
        })
    return resource
```

#### `encounter.py`
```python
@dataclass
class VisitRecord:
    id: str
    patient_id: str
    doctor_id: str
    date: str
    chief_complaint: str
    diagnosis: str
    icd10_code: str | None     # optional — see 10.12 edge case
    notes: str
    created_at: datetime

def build_fhir_encounter(visit: VisitRecord) -> dict:
    enc = {
        "resourceType": "Encounter",
        "id": visit.id,
        "status": "finished",
        "class": {"system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
                  "code": "AMB"},
        "subject": {"reference": f"Patient/{visit.patient_id}"},
        "participant": [{"individual": {"reference": f"Practitioner/{visit.doctor_id}"}}],
        "period": {"start": visit.date},
        "diagnosis": []
    }
    if visit.icd10_code:          # skip silently if empty (§10.12)
        enc["diagnosis"].append({
            "condition": {"reference": f"Condition/{visit.id}"},
            "use": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/diagnosis-role",
                                "code": "CC"}]}
        })
    return enc
```

#### `observation.py`
```python
VITAL_LOINC = {
    "blood_pressure_systolic":  ("55284-4", "Blood pressure"),
    "blood_pressure_diastolic": ("55284-4", "Blood pressure"),
    "heart_rate":               ("8867-4",  "Heart rate"),
    "weight":                   ("29463-7", "Body weight"),
    "height":                   ("8302-2",  "Body height"),
    "temperature":              ("8310-5",  "Body temperature"),
    "oxygen_saturation":        ("59408-5", "Oxygen saturation"),
    "blood_glucose":            ("2339-0",  "Blood glucose"),
}

@dataclass
class ObservationRecord:
    id: str
    patient_id: str
    type: str          # key from VITAL_LOINC
    value: float
    unit: str
    recorded_at: datetime
    source: Literal["manual", "health_connect"]
```

#### `medication.py`
```python
@dataclass
class MedicationRequest:
    id: str
    patient_id: str
    prescriber_id: str          # → Practitioner LANR
    medication_name: str
    dosage: str
    frequency: str
    start_date: str
    end_date: str | None
    status: Literal["active", "completed", "cancelled"]

def build_fhir_medication_request(rx: MedicationRequest, lanr: str | None) -> dict:
    resource = {
        "resourceType": "MedicationRequest",
        "id": rx.id,
        "status": rx.status,
        "intent": "order",
        "subject": {"reference": f"Patient/{rx.patient_id}"},
        "requester": {"reference": f"Practitioner/{rx.prescriber_id}"},
        ...
    }
    if lanr:
        resource["requester"]["identifier"] = {
            "system": "https://fhir.kbv.de/NamingSystem/KBV_NS_Base_ANR",
            "value": lanr
        }
    return resource
```

#### `condition.py`
```python
@dataclass
class ConditionRecord:
    id: str
    patient_id: str
    icd10_code: str
    display: str
    clinical_status: Literal["active", "resolved"]
    recorded_date: str
```

#### `bundle.py` — FHIR export bundle
```python
def build_export_bundle(
    patient: User,
    encounters: list[VisitRecord],
    observations: list[ObservationRecord],
    medications: list[MedicationRequest],
    conditions: list[ConditionRecord],
    pseudonym: str | None
) -> dict:
    """
    Assembles a FHIR R4 document bundle.
    - Uses pseudonym as Patient.id if available; falls back to patient.id
    - Skips encounters with empty ICD codes (§10.12)
    - All referenced resources must be present (FHIR R4 §3.3)
    """
```

### Routes (`app/routes/clinical.py`)
| Method | Path | Resource |
|---|---|---|
| `POST` | `/api/ehr/visits` | Encounter |
| `GET` | `/api/ehr/visits` | Encounter list |
| `POST` | `/api/patient/vitals` | Observation |
| `GET` | `/api/patient/vitals` | Observation list |
| `POST` | `/api/medications` | MedicationRequest |
| `GET` | `/api/medications/today` | MedicationRequest (filtered) |
| `POST` | `/api/medications/intake/` | Intake confirmation |
| `GET` | `/api/patient/export-fhir` | Bundle export |
| `POST` | `/api/ehr/icd10-suggest` | Gemini ICD-10 suggest |
| `POST` | `/api/healthconnect/sync` | Batch observation ingest |
| `DELETE` | `/api/healthconnect/data` | Health Connect selective erase |

### ICD-10 AI Suggest (`app/services/icd10.py`)
```python
class ICD10SuggestService:
    def suggest(self, symptom_text: str) -> list[dict]:
        if not settings.GEMINI_API_KEY:
            raise ServiceUnavailable("ICD10_SUGGEST_DISABLED")  # → 503
        # call Gemini; on error → 502 with detail
```

### Health Connect batch validation (§10.11)
```python
def validate_observation_batch(observations: list) -> tuple[list, list]:
    """Returns (valid, errors). A single bad record never blocks the batch.
    Returns 422 only if ALL observations fail."""
```

**Tests:** FHIR resource structure, bundle self-containment, empty-ICD skip, batch partial failure.

---

## Phase 4 — Offline Layer (Mobile)
**Depends on:** Phase 0 (mobile scaffold)  
**Platform:** React Native · `expo-sqlite`

This phase is 100% approach-neutral — SQLite runs on device.

### Schema (`services/offline/db.ts`)
```typescript
export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS vitals (
    id TEXT PRIMARY KEY,
    type TEXT, value REAL, unit TEXT,
    recorded_at TEXT, source TEXT
  );
  CREATE TABLE IF NOT EXISTS visits (
    id TEXT PRIMARY KEY, date TEXT,
    chief_complaint TEXT, diagnosis TEXT,
    icd10_code TEXT, notes TEXT
  );
  CREATE TABLE IF NOT EXISTS pending_vitals (
    local_id TEXT PRIMARY KEY,
    payload TEXT,          -- JSON string
    queued_at TEXT
  );
  CREATE TABLE IF NOT EXISTS pending_medication_intakes (
    local_id TEXT PRIMARY KEY,
    medication_id TEXT, taken_at TEXT,
    queued_at TEXT
  );
  CREATE TABLE IF NOT EXISTS today_medications_cache (
    id TEXT PRIMARY KEY,
    payload TEXT,
    cached_at TEXT
  );
`;
```

### Sync service (`services/offline/sync.ts`)
```typescript
export async function syncPendingVitals(apiClient: AxiosInstance) { ... }
export async function syncPendingIntakes(apiClient: AxiosInstance) { ... }
export function getCachedTodayMedications(): MedicationSchedule | null { ... }
```

### Retry policy (`services/client.ts`)
```typescript
// Applied to: ECONNABORTED, ERR_NETWORK, no response, 502/503/504
const BACKOFF = [2000, 4000, 8000, 15000];   // ms, cap at index 3

// __noRetryOn5xx: true  → used by acceptConsent() (permanent 502 = TTP unreachable)
```

### Pseudonym suffix storage (`services/consent.ts`)
```typescript
// On app restart, rehydrate Zustand store from AsyncStorage
const suffix = await AsyncStorage.getItem('@caremate/pseudonym_suffix');
if (suffix && !store.pseudonymSuffix) store.setPseudonymSuffix(suffix);
```

### Token storage
```typescript
// Always expo-secure-store (iOS Keychain / Android Keystore)
// Never AsyncStorage for auth tokens
await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
```

### Push notification lazy import (§10.5)
```typescript
// In scheduleMedicationNotifications() only — never at module level
const Notifications = await import('expo-notifications');
```

---

## Phase 5 — P2P Path
**Depends on:** Phase 1  
**Approach-neutral:** runs identically regardless of cloud or on-prem backend

### Protocol
```
Doctor device  ──(LAN/WiFi direct)──  Patient device
     └── mDNS service discovery
     └── HTTP over local socket (no TLS required — LAN only)
     └── JWT issued by main backend; validated by P2P endpoint
```

### Scope
- Read patient vitals snapshot
- Record a visit note (queued locally; synced to main backend when connectivity restored)
- No consent operations over P2P (TTP not reachable)

### Routes (`app/routes/p2p.py`)
| Method | Path | Notes |
|---|---|---|
| `GET` | `/p2p/patient/vitals` | Returns cached vitals from SQLite |
| `POST` | `/p2p/visit` | Queued to `pending_visits`; synced later |
| `GET` | `/p2p/health` | Liveness (LAN only) |

---

## Phase 6 — API Surface Completion
**Depends on:** Phases 1–5  
**Goal:** All routes wired; all services tested; repository interface fully defined

At end of Phase 6, the codebase is **100% functional against `InMemoryRepository`** and passes all tests.  
This is the **decision point** — pick an approach and write one adapter.

### Final repository method checklist
```
UserRepository
  ✓ get_by_username
  ✓ create
  ✓ update
  ✓ delete

PatientRepository
  ✓ get
  ✓ authorize_doctor / revoke_doctor
  ✓ list_authorized_doctors
  ✓ update_fhir_identifiers

ClinicalRepository
  ✓ save/list Encounter
  ✓ save/list Observation
  ✓ save/list MedicationRequest
  ✓ save/list Condition
  ✓ delete_health_connect_data

ConsentRepository
  ✓ save_consent
  ✓ get_consent
  ✓ update_pseudonym
```

---

## Decision Point — Storage Adapters

Once Phase 6 is done, plug in one of:

### Adapter A — `MongoRepository` (Approach A)
```python
class MongoUserRepository(UserRepository):
    def __init__(self, db: MongoClient): self._col = db["users"]
    def get_by_username(self, username, user_type):
        return self._col.find_one({"username": username, "user_type": user_type})
    # ...
```

### Adapter B — `OrbisOFIRepository` (Approach B)
```python
class OrbisPatientRepository(PatientRepository):
    def __init__(self, ofi_base_url: str, token: str): ...
    def get(self, patient_id: str):
        r = requests.get(f"{self.ofi_base_url}/Patient/{patient_id}", headers=...)
        return r.json()
    def save_encounter(self, encounter: dict):
        requests.post(f"{self.ofi_base_url}/Encounter", json=encounter, headers=...)
    # ...
```

**Both adapters implement the same interface. No route or service code changes.**

---

## Phase Timeline

| Phase | What | Duration |
|---|---|---|
| 0 | Scaffold + Repository interface + InMemory stub | 1–2 days |
| 1 | Identity, Auth, JWT, LANR/KVID | 2–3 days |
| 2 | Consent — gICS/gPAS, strict/soft flows | 2–3 days |
| 3 | FHIR R4 models, clinical routes, FHIR export | 4–5 days |
| 4 | Mobile offline layer (SQLite, sync, retry) | 2–3 days |
| 5 | P2P path | 1–2 days |
| 6 | API surface completion + full test coverage | 2–3 days |
| **—** | **Decision point: pick Approach A or B** | — |
| A | `MongoRepository` adapter + Atlas config | 2–3 days |
| B | `OrbisOFIRepository` adapter + OFI mapping | 4–6 days |

**Total common work: ~2.5–3 weeks**  
**Adapter work: +3–6 days depending on choice**

---

## What Does NOT Go Into Common Models

These are deferred to the adapter phase:

| Item | Reason |
|---|---|
| MongoDB connection, collections, indexes | Approach A only |
| Orbis OFI HTTP client, FHIR PUT/POST mapping | Approach B only |
| MongoDB `$addToSet` / `$pull` operations | Approach A only |
| OFI resource ID mapping (Orbis ↔ FHIR) | Approach B only |
| Atlas connection string / replica set config | Approach A only |
| Hospital VPN / mTLS config | Approach B only |
| Cross-hospital patient lookup | Approach A (or Stage 2 federation) |

---

*All phases buildable and testable with `docker-compose up` (gICS + gPAS only — no DB service).*
