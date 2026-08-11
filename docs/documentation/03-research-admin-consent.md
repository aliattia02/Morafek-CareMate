# Part 3 — Research, Admin & Consent Infrastructure (gICS / gPAS)

> Morafek CareMate · Researcher and admin surfaces, pseudonymised research data, and the German
> consent/pseudonymisation stack (gICS + gPAS) underneath both.
> Part of a 3-part documentation set — see [`README.md`](README.md) for the other parts.

---

## Table of Contents

1. [Why This Layer Exists](#1-why-this-layer-exists)
2. [The Two TTP Services: gICS & gPAS](#2-the-two-ttp-services-gics--gpas)
3. [Pseudonym Lifecycle](#3-pseudonym-lifecycle)
4. [Identified vs. Research Data: the Collections](#4-identified-vs-research-data-the-collections)
5. [Erasure Requests: a Two-Step Destructive Action](#5-erasure-requests-a-two-step-destructive-action)
6. [The Researcher Journey](#6-the-researcher-journey)
7. [The Admin Journey](#7-the-admin-journey)
8. [Auth Model Summary](#8-auth-model-summary)
9. [Infrastructure: Local Docker Stack vs. Cloud](#9-infrastructure-local-docker-stack-vs-cloud)
10. [What's Not Built Yet](#10-whats-not-built-yet)
11. [Research & Admin API Reference](#11-research--admin-api-reference)

---

## 1. Why This Layer Exists

Real-world German medical research doesn't let a researcher query hospital patient data directly. The process this app's architecture mirrors looks roughly like this:

```
Patient signs a Broad Consent on admission
    → gICS records what they agreed to (research use, cross-hospital sharing, re-contact, ...)

Researcher finds a matching cohort via a national portal (FDPG), submits a
formal request with ethical approval

A Treuhandstelle (trusted third party) reviews the request against:
  - ethical approval
  - what the matching patients actually consented to (queried from gICS)
  - data minimisation

On approval, gPAS generates pseudonyms for the approved patients — the
Treuhandstelle holds the real-identity ↔ pseudonym mapping; the researcher
never sees it and can never re-identify a record from the data they receive
```

The Treuhandstelle's job is to keep **identity** and **research data** physically separate, and only a component it controls (gPAS) can bridge them. Morafek's backend implements a scaled-down version of exactly this separation:

- **gICS** ("Generic Informed Consent Service") owns whether a patient has agreed to research use at all.
- **gPAS** ("Generic Pseudonym Administration Service") owns the identity ↔ pseudonym mapping — no other service, including Morafek's own backend, ever computes or stores that mapping itself.
- A **researcher-triggered sync job** mirrors vitals into a separate collection, keyed by pseudonym instead of patient ID, only for patients whose gICS status says they've consented.
- An **admin approval queue** is the only path that can permanently delete already-mirrored research data — mirroring the Treuhandstelle's role as the human check on anything irreversible.

Everything below describes how much of that model is actually built, and exactly where the line between "real" and "designed but not wired up yet" sits today.

---

## 2. The Two TTP Services: gICS & gPAS

| Service | Owns | Backend touches it via |
|---|---|---|
| **gICS** | Whether a patient has an active research-consent record | `services/gics_service.py` — SOAP calls: `addConsent`, `get_consent_status()` / `get_consent_status_detailed()` |
| **gPAS** | The identity ↔ pseudonym mapping | `get_or_create()` (fire-and-forget), `get_or_create_pseudonym()` (idempotent, hard-failure variant), `delete_pseudonym()` |

Both run **only in the local Docker development stack** (`docker-compose.yml`) — they are **not deployed to the cloud**. The production backend runs on Render's free tier; from there, gICS/gPAS calls fail with a connection error that the relevant routes turn into a `502`. The mobile app's consent screen specifically detects this and shows "🏥 Please visit your hospital" instead of a raw error (see [Part 1 §11](01-patient-journey.md#11-research-consent)).

### Consent has two flows, on purpose

| | Soft (legacy) | Strict (used by the app) |
|---|---|---|
| Endpoint | `POST /api/patient/consent` | `POST /api/consent/accept` |
| gICS/gPAS failure | Fire-and-forget — ignored | Hard failure → `502`; gPAS failure rolls back the gICS write |
| MongoDB write | Always happens | Only after **both** external calls succeed |
| `consent_history` (§4) | **Not** written | Written |

The soft flow exists only for backward compatibility with an older inline export card and is intentionally not wired into the interval-tracking model below — it builds its pseudonym via the non-idempotent `gpas.get_or_create()`, which the interval logic can't rely on consistently.

### The UNKNOWN-status bug (fixed)

`gics_service.get_consent_status()` used to collapse four genuinely different situations into the single string `"UNKNOWN"`: gICS being unreachable, a SOAP fault that wasn't "not found," an unparseable response, and a legitimate "this patient has no consent record yet" answer. Because it never raised, the sync job's `except Exception` couldn't tell a real gICS outage apart from a patient who simply hasn't consented — a transient timeout for one patient was silently written as `research_eligible: False` and counted as an ordinary state change, not an error.

**Fix:** `get_consent_status_detailed()` now returns `{"status", "ok", "error"}` and keeps the distinction. The sync job (§6) uses it: `ok=False` goes into `error_count`/`errors[]` with that patient's eligibility left untouched; only a genuine gICS-confirmed `UNKNOWN` (`ok=True`) maps to ineligible, the same as `REJECTED`. The original `get_consent_status()` is unchanged and still collapses everything to a plain string, since every other caller (`accept_consent()`'s idempotency check, `GET /api/consent/status`, `diagnose_consent_stack()`) is written to treat "gICS down" and "no consent on record" the same way **on purpose**.

---

## 3. Pseudonym Lifecycle

| Event | What happens |
|---|---|
| Patient registration | `gpas.get_or_create()` — fire-and-forget; failure doesn't block registration |
| Consent grant (strict) | `gpas.get_or_create_pseudonym()` — hard failure, rolls back the gICS write on error |
| Consent revoke | Pseudonym **retained** in gPAS and MongoDB — revoke is prospective, not destructive |
| Patient re-grants consent | **Same** pseudonym returned (gPAS's create is idempotent) |
| Account deletion | Only the local cache (`patient_fhir_identifiers.pseudonym`) is deleted; the gPAS record is **retained** (Treuhandstelle mapping must survive account deletion) |
| Admin facility reactivation | Old pseudonym deleted from gPAS, a genuinely new one created (see [Part 2 §10](02-doctor-journey.md#10-admin-facility-reactivation)) |

**The full pseudonym is never sent to the mobile client at any point** — only the last 4 characters (`pseudonymSuffix`), shown as `****XXXX`. This holds even for the strict-accept response and the admin-reactivation response.

---

## 4. Identified vs. Research Data: the Collections

The core design rule: identified data and pseudonymised research data live in **physically separate collections**, not separate fields of the same one. If `research_vitals` is ever exported or queried incorrectly, there is nothing in it that links back to a real person.

### `patient_identifiers` — one document per patient

| Field | Type | Written by |
|---|---|---|
| `patient_id` | string | — (keys the document; same `str(users._id)` used everywhere else) |
| `doctor_sharing` | bool | Patient, via `PATCH /api/patient/doctor-sharing` (see [Part 1 §10](01-patient-journey.md#10-managing-authorized-doctors--data-sharing)) — independent of gICS entirely |
| `gics_consent_status` | `"accepted"` \| `"revoked"` \| `"unknown"` | The research sync job (§6), cached from a live gICS query |
| `research_eligible` | bool | The research sync job — fast flag researcher-facing queries can filter on |
| `research_pseudonym` | string \| null | The research sync job — resolved from `patient_consents.pseudonym` for each currently-eligible patient |

`get_doctor_sharing()` defaults to `True` for a patient with no document yet, for the same reason `research_eligible` defaults conservatively — shipping this couldn't silently cut off access or eligibility for everyone who existed before the field did.

### `consent_history` — append-only interval log

One row per grant/revoke *event*, not a single overwritten pair of fields — so a patient can grant, revoke, and re-grant any number of times and the full history survives:

```
pseudonym   granted_at            revoked_at
ABCD-1234   2026-01-10T09:00Z     2026-02-15T14:00Z
ABCD-1234   2026-03-01T10:30Z     2026-05-20T08:00Z
ABCD-1234   2026-07-02T11:00Z     null              ← still active
```

Only the three **strict** consent routes write here: accept, revoke, and admin reactivation. A reading at time `T` counts as "collected under active consent" if any row satisfies `granted_at <= T AND (revoked_at IS NULL OR revoked_at > T)`.

**Why this matters in practice:** without per-interval tracking, a vital recorded while consent was revoked would still get mirrored into research data the moment the patient later reactivates — because a simple "is this patient eligible right now" check has no memory of when they weren't. The interval check closes that gap.

### The five `vitals_*` source collections

Vitals are **not** one collection — they're split by type, each keyed on the real `patient_id`, linked by a shared `reading_id` for readings taken together:

| Collection | LOINC | Written by |
|---|---|---|
| `vitals_blood_pressure` | `55284-4` | Manual entry |
| `vitals_heart_rate` | `8867-4` | Manual entry |
| `vitals_weight` | `29463-7` | Manual entry |
| `vitals_steps` | `41950-7` | Health Connect only |
| `vitals_blood_sugar` | `15074-8` | Reserved — no writer yet |

Any code that mirrors vitals into research data has to iterate all five (`utils.vitals_storage.ALL_VITALS_COLLECTIONS`), not query a single table.

### `research_vitals` — the de-identified mirror

Built by `utils/research_mirror.py::mirror_patient_vitals(db, patient_id, research_pseudonym)`:

- Reads `consent_history` intervals for the pseudonym and keeps only readings whose `effectiveDateTime` falls inside an open `[granted_at, revoked_at)` window.
- **Fails closed on timestamps** — a reading with a missing or unparseable `effectiveDateTime` is never mirrored, rather than guessed at.
- **De-identifies** before writing: strips `patient_id`, `subject`, `performer`, `recorded_by`, `note`; stamps `research_pseudonym`, `source_collection`, `source_observation_id`, `mirrored_at`.
- **Idempotent by upsert**, not by a "synced" flag on the source data — the dedup key is `(research_pseudonym, source_collection, source_observation_id)`, backed by a unique index. This trades "cheap to query" for "self-healing": a reading that wasn't coverable last sync (e.g. consent hadn't been granted yet) is naturally reconsidered on the next sync, with no separate backfill path needed.
- Only ever **inserts** — there is no code path that updates or deletes a `research_vitals` row from this function, which is what makes "revoke doesn't retroactively delete already-mirrored data" true by construction rather than by convention.

### `sync_issues` — standing problems, not one-off log lines

Two conditions used to be visible only as a log line that vanished the moment the next sync overwrote it. Now they persist as **one open document per `(patient_id, issue_type)`**, upserted (not appended — this tracks current state, not history):

| `issue_type` | Meaning | Resolved when |
|---|---|---|
| `missing_pseudonym` | Patient is `research_eligible` but has no `patient_consents.pseudonym` yet — mirroring is skipped for them this run | A later sync finds a pseudonym |
| `gics_query_failure` | This patient's gICS query keeps failing across syncs | A later query for the same patient succeeds |

An `occurrence_count` increments every time an already-open issue re-fires, which is what turns "has this been broken across multiple syncs" into a visible number instead of something an admin has to infer by comparing timestamps. Read via `GET /api/admin/sync-issues` (§7) — there is no manual dismiss; issues only clear when a later sync stops seeing the condition.

---

## 5. Erasure Requests: a Two-Step Destructive Action

Revoking consent is **prospective only** — it stops future mirroring, it does not delete data already mirrored into `research_vitals`. Deleting that already-shared data is a deliberately separate, heavier action, split into two steps so a single patient click can never trigger an irreversible deletion:

```
Step 1 — Patient requests erasure   🚧 NOT BUILT
  POST /api/patient/erasure-request would create a "pending" erasure_requests
  document. Explicitly held for later — this endpoint doesn't exist yet.

Step 2 — Admin reviews and approves   ✅ BUILT
  GET  /api/admin/erasure-requests            — list, with a live-computed
                                                 affected_row_count per request
  POST /api/admin/erasure-requests/<id>       — approve (permanently deletes
                                                 matching research_vitals rows)
                                                 or deny (touches no data)
```

**Practical consequence today:** the admin approval queue is real, working code sitting in front of an always-empty collection — `GET /api/admin/erasure-requests` correctly returns `{"requests": []}` until step 1 exists, not because anything is broken.

`erasure_requests` document shape:

| Field | Type | Notes |
|---|---|---|
| `patient_id` | string | Who requested erasure |
| `research_pseudonym` | string | Which pseudonym's `research_vitals` rows are targeted |
| `requested_at` | ISO datetime | |
| `status` | `pending` \| `approved` \| `denied` | |
| `reviewed_by` / `reviewed_at` | string / ISO datetime \| null | Set once an admin acts |
| `reason` | string \| null | Optional, especially useful on denial |

Approval is a synchronous `research_vitals.delete_many({research_pseudonym})` — no soft-delete, no undo. The two-step design *is* the safeguard; the human review at approval time is the confirmation, which is why the mobile screen (§7) gates the approve action behind a typed `DELETE` confirmation rather than a single tap.

---

## 6. The Researcher Journey

### Login

`POST /login` with `user_type: "researcher"`. This role was silently rejected until a bug fix: `auth_routes.py` used to maintain its own `VALID_USER_TYPES` list that never included `"researcher"`, so no researcher account — including one inserted by hand — could log in or even self-register. It now imports the list from `utils/auth.py` instead of keeping a second copy. There's no researcher provisioning flow beyond ordinary self-registration (`POST /register`, `user_type: "researcher"`).

### Sync screen (`research/sync.tsx`)

The researcher's only screen today. Reached via **Profile → RESEARCH → Sync Consent Status** — researchers are redirected to the Profile tab on login rather than a dedicated dashboard, since `research/sync.tsx` lives outside the tab navigator (like `ehr/consent` and `settings/doctors`) and a direct `router.replace()` into it would strand the researcher with no tab bar and no way back.

It shows a "last synced" badge (from `GET /api/research/sync/status`) and a single **Sync Now** button.

### `POST /api/research/sync` — what one click does

A single request runs, per patient, in one loop:

1. **Refresh eligibility.** Query gICS (`get_consent_status_detailed()`); write `research_eligible` + `gics_consent_status` to `patient_identifiers`. A query failure for one patient is recorded in `error_count`/`errors[]` and flagged into `sync_issues` (`gics_query_failure`) — it does **not** overwrite that patient's existing eligibility state.
2. **Mirror vitals for eligible patients**, in the same per-patient pass — not a separate sweep. Resolves `research_pseudonym` from `patient_consents.pseudonym`, writes it to `patient_identifiers`, and calls `mirror_patient_vitals()` (§4). If no pseudonym exists yet, that's recorded in `no_pseudonym_count` and flagged into `sync_issues` (`missing_pseudonym`) instead of failing anything.

```json
{
  "synced_at": "2026-08-11T12:00:00+00:00",
  "synced_by": "<researcher user id>",
  "total_patients": 42,
  "processing_count": 5,
  "error_count": 1,
  "newly_eligible": 2,
  "newly_ineligible": 1,
  "unchanged": 39,
  "vitals_mirrored": 120,
  "vitals_considered": 340,
  "no_pseudonym_count": 1,
  "errors": [{ "patient_id": "...", "gics_error": "..." }],
  "duration_seconds": 3.42
}
```

`error_count > 0` in a `200` response is a **partial** success — the rest of the patients still synced; the screen surfaces `errors[]` without treating the whole run as failed. Only a `502` (gICS completely unreachable before the loop even starts) is a hard failure, shown as "🔌 gICS service unreachable."

**Why on-demand, not scheduled:** there is no scheduler infrastructure (APScheduler/Celery/cron) anywhere in this codebase. Rather than build one to solve a staleness problem, the researcher explicitly triggers a sync right before they need fresh data — trading a fixed staleness window for "you get exactly how fresh you asked for, and staleness is visible in the UI (`stale_minutes`) rather than hidden behind a background job's lag." The trade-off is real: a researcher who never clicks sync can act on stale data with no automatic backstop.

**Idempotency:** running the sync twice back-to-back is safe — the second run reports "unchanged" for anything that didn't move, and the vitals mirror is idempotent by its own dedup index (§4).

---

## 7. The Admin Journey

Two read/action surfaces, both admin-only (see §8 for why this is stricter than other doctor-or-admin routes elsewhere in the app).

### Sync Issues (`admin/sync-issues.tsx`)

Reached via **Profile → ADMINISTRATION → Sync Issues**. A filterable, read-only list from `GET /api/admin/sync-issues`:

- Filter chips: All / Missing Pseudonym / gICS Query Failure.
- A "show resolved issues" toggle (`include_resolved`).
- Each card shows the issue type, patient ID, detected/last-seen/resolved timestamps, free-form context, and — for a repeated issue — an occurrence badge (`×4`).
- **No manual dismiss/acknowledge action exists.** Issues only clear when a later sync stops seeing the condition. If a manual acknowledge is ever wanted, that's new backend work, not something this screen can currently do.

### Erasure Requests (`admin/erasure-requests.tsx`)

Reached via **Profile → ADMINISTRATION → Erasure Requests**. A status-filterable list (`pending` / `approved` / `denied` / `all`) from `GET /api/admin/erasure-requests`, each row showing `affected_row_count` — the live count of `research_vitals` rows that would be deleted — so the blast radius is visible *before* approving, not just in the response after.

**Approve flow:** opens a modal that requires the admin to type the literal word `DELETE` before the destructive button enables. The modal explicitly states the row count and pseudonym being deleted. On confirm, `POST /api/admin/erasure-requests/<id>` `{"action": "approve"}` runs a synchronous, permanent `delete_many()` — there is no undo.

**Deny flow:** a lighter modal with an optional reason field; `{"action": "deny", "reason": "..."}` touches no data.

**Race handling:** if two admins (or a double-tap) act on the same request, the second call gets a `409` ("already actioned") — the screen shows a neutral alert and refreshes the list rather than a generic error.

**Today, this queue is legitimately always empty for `pending`** — the patient-facing creation endpoint doesn't exist (§5). The empty state says so explicitly rather than implying something is broken.

---

## 8. Auth Model Summary

| Action | Who | Why |
|---|---|---|
| Trigger research sync | `researcher` only | Scoped to the one role that needs it |
| View sync issues | `admin` only | Read-only, low-stakes — could reasonably extend to doctors later if they're expected to help chase missing pseudonyms, but that's not built |
| Approve/deny erasure | `admin` only, **not** doctor-or-admin | Erasure permanently deletes data already possibly in active research use — a strictly higher blast radius than `admin_reactivate_consent()` (doctor-or-admin), which only issues a new, reversible pseudonym |
| Facility reactivation | `doctor` **or** `admin` | Reversible, non-destructive — see [Part 2 §10](02-doctor-journey.md#10-admin-facility-reactivation) |

### Dev admin seed — explicitly temporary

A hardcoded admin account (`admin` / `1234`) is seeded automatically on backend startup (`main.py::_ensure_dev_admin_account()`) purely so `admin_routes.py` is reachable without a manual database insert during development. This is **not** a real provisioning flow, and the login screen's "tap to fill" demo box for the admin role labels it as such. `POST /register` still allows anyone to self-register a second admin account — that door remains open independently of this seed, and is a known gap worth closing before any real deployment.

---

## 9. Infrastructure: Local Docker Stack vs. Cloud

| Service | Local Docker | Cloud (Render) |
|---|---|---|
| Backend (Flask) | ✓ | ✓ (free tier, cold starts) |
| MongoDB | Atlas (both environments point at the same Atlas cluster) | ✓ |
| gICS | ✓ (`mosaicgreifswald/gics`) | ✗ — not deployed |
| gPAS | ✓ (`mosaicgreifswald/gpas`) | ✗ — not deployed |
| MariaDB (shared by gICS/gPAS) | ✓ | — |

**Consequence:** research sync, consent accept/revoke, and admin facility reactivation all require the **local Docker stack** to actually reach gICS/gPAS. Against the cloud deployment, these calls return `502`, which the relevant screens turn into an explanatory message rather than a raw error (§2, and [Part 1 §11](01-patient-journey.md#11-research-consent)).

**Schema-fix services:** gICS and gPAS use EclipseLink JPA DDL that generates MariaDB columns too narrow for its UTF-8MB4 index limits out of the box. Two one-shot services (`gpas-schema-fix`, `gics-schema-fix`, `restart: "no"`) poll for the tables to exist, then widen the offending columns. They don't block startup.

### Relevant environment variables

| Variable | Default | Notes |
|---|---|---|
| `GICS_URL` | `http://gics:8080` | |
| `GICS_DOMAIN` | `morafek-data-sharing` | Consent domain |
| `GICS_TIMEOUT` | `10` | Seconds |
| `GPAS_URL` | `http://gpas:8080` | |
| `GPAS_DOMAIN` | `morafek-patients` | Pseudonym domain |
| `GPAS_ENABLED` | `true` | Set `false` to skip gPAS entirely (e.g. local dev without the full stack) — consent still records in gICS/Mongo, pseudonym fields stay `null`, and FHIR export falls back to the Mongo `_id` |
| `GICS_LOG_SOAP` | `0` | Set `1` to log outbound SOAP envelopes |

---

## 10. What's Not Built Yet

Keeping this list explicit, since several of the docs this file replaces were written mid-implementation and it's easy to assume more exists than actually does:

- **`POST /api/patient/erasure-request`** — the patient-facing side of §5. Without it, the admin erasure queue is real code with nothing to review.
- **Researcher data access/export** — `GET /api/research/data/patients` and `POST /api/research/data/export` are placeholder comments in `research_routes.py` only. A researcher can trigger a sync and see aggregate stats, but there is no endpoint to actually read `research_vitals` rows yet.
- **Manual acknowledge/dismiss for sync issues** — issues only self-resolve; there's no admin action to hide one early.
- **Real admin/researcher provisioning** — both roles exist only via the dev seed (admin) or open self-registration (researcher/admin alike via `POST /register`). No invite or promotion flow exists.
- **A background/scheduled sync** — by design, for now (§6) — but worth revisiting if the on-demand model proves insufficient once researchers actually rely on it day to day.

---

## 11. Research & Admin API Reference

All routes require `Authorization: Bearer <token>`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/research/sync` | researcher | Refresh eligibility + mirror vitals for all patients |
| GET | `/api/research/sync/status` | researcher | Last sync timestamp + stats |
| GET | `/api/admin/sync-issues` | admin | List standing sync problems |
| GET | `/api/admin/erasure-requests` | admin | List erasure requests (+ live `affected_row_count`) |
| POST | `/api/admin/erasure-requests/<request_id>` | admin | Approve (destructive) or deny |
| POST | `/api/consent/admin/reactivate/<patient_id>` | doctor/admin | Issue a fresh pseudonym (see [Part 2 §10](02-doctor-journey.md#10-admin-facility-reactivation)) |

For the patient-facing consent routes (`/api/consent/accept`, `/revoke`, `/status`, `/diagnose`), see [Part 1 §11](01-patient-journey.md#11-research-consent).
