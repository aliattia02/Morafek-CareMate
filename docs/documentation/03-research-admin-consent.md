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
10. [First-Time gICS Setup (Manual, via Admin UI)](#10-first-time-gics-setup-manual-via-admin-ui)
11. [What's Not Built Yet](#11-whats-not-built-yet)
12. [Research & Admin API Reference](#12-research--admin-api-reference)

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
| **gICS** | Whether a patient has an active research-consent record | `services/gics_service.py` — SOAP calls: `addConsent`, `refuseConsent`, `get_consent_status()` / `get_consent_status_detailed()`, `get_current_template()` |
| **gPAS** | The identity ↔ pseudonym mapping | `get_or_create()` (fire-and-forget), `get_or_create_pseudonym()` (idempotent, hard-failure variant), `delete_pseudonym()` |

Both run **only in the local Docker development stack** (`docker-compose.yml`) — they are **not deployed to the cloud**. The production backend runs on Render's free tier; from there, gICS/gPAS calls fail with a connection error that the relevant routes turn into a `502`. The mobile app's consent screen specifically detects this and shows "🏥 Please visit your hospital" instead of a raw error (see [Part 1 §11](01-patient-journey.md#11-research-consent)).

### gICS identity today: domain `Morafek`, signer-ID type `IMI`

The gICS **domain** the backend talks to is **not** a fixed name baked into gICS itself — it's whatever exists in gICS's own database, created by hand through its admin UI (`http://localhost:8082/gics-web/`), and the backend has to be told what that is via env vars. As of 2026-08-12 this domain is named **`Morafek`**, with signer-ID type **`IMI`** — earlier in this project's history it was `morafek-data-sharing` / `morafek-patient-id`; the domain was recreated under the ENRICH policy work and the backend config was updated to match. **This can change again** any time someone recreates or renames the domain in gICS's admin UI — if you ever see every gICS call failing with a raw `500` (not a clean SOAP fault), the domain/template/module name mismatch described in §10 is the first thing to check, verified live, not assumed.

### SOAP operations that don't actually exist in this gICS version

Two operations `gics_service.py` originally called turned out not to exist in this gICS instance's WSDL at all — found by checking the WSDL directly (`GET /gics/gicsService?wsdl`) rather than trusting a generic `500 Internal Server Error`, which is all gICS returns for a call to an operation it doesn't recognize (a real SOAP fault with a "not recognized" message is only visible in the raw response body — `resp.raise_for_status()` throws before that body is ever inspected unless you catch it explicitly).

| Called (wrong) | Actually exists | Fixed in |
|---|---|---|
| `getCurrentPolicyStatesForPersonAndTemplate` | `getPolicyStatesForPolicyNameAndSignerIds` | `get_consent_status_detailed()` |
| `revokeConsent` | `refuseConsent` | `revoke_consent()` |

Both had been silently masked before these fixes: `get_consent_status()` never raised (collapsed every failure to a plain `"UNKNOWN"` string, indistinguishable from a genuine "hasn't consented" answer), and the revoke route logged a warning on failure but still told the client `{"success": true}` and marked MongoDB revoked regardless — reproduced live: a patient's gICS record stayed `ACCEPTED` after the app reported their revoke as successful. Fixed by using the real operations and making `revoke_consent_strict()` (`POST /api/consent/revoke`) fail with `502` instead of lying about success when gICS genuinely errors.

**A related read-side bug, found while fixing the above:** `getPolicyStatesForPolicyNameAndSignerIds` returns a signer's **full history** for a policy, not just the current state — `refuseConsent` *appends* a new record rather than replacing the prior one. Picking the first `<status>` tag in the response (the original approach) silently returned stale data for any patient with more than one record. Fixed to walk every `<signedPolicies>` entry and pick the one with the latest `<consentKey><consentDate>` — and because that timestamp is only second-precision, an accept immediately followed by a revoke can land both records in the same second, which needed `>=` instead of a strict `>` in the tie-break to avoid keeping the older record on an exact tie (reproduced live before the fix: status read back as `ACCEPTED` immediately after a successful revoke).

### Two document types: Consent vs. Withdrawal

gICS models a `CONSENT` action and a `REVOCATION` (Widerruf) action as genuinely separate **document types**, each with its own admin-UI section (Documents → Consents / Withdrawals / Refusals) and its own template. Originally `revoke_consent()` reused the Consent template's key for `refuseConsent` — it worked (gICS doesn't enforce document Type on that operation), but every withdrawal filed under "Consents" in gICS's UI instead of its own "Withdrawals" section, which is the wrong document for what actually happened.

Fixed by creating a second, `REVOCATION`-type template (`withdrawal_wearable_health_data`) and pointing `revoke_consent()` at it (`_WITHDRAWAL_TEMPLATE_NAME`/`_WITHDRAWAL_TEMPLATE_VERSION`, separate from `_TEMPLATE_NAME`/`_TEMPLATE_VERSION`). **The critical requirement:** the Withdrawal template must have the **same module** assigned as the Consent template (`wearable_health_data_recording`), reused via "Search and sort modules" — not a freshly-created one. Status reads (`getPolicyStatesForPolicyNameAndSignerIds`) query by **policy name**, domain-wide, not scoped to a template — as long as both templates share the module (and therefore the policy it's assigned to), a withdrawal recorded against the Withdrawal template is still picked up by the exact same status-read code that already existed, with zero changes needed there. See §10 for the full setup walkthrough.

### Viewing the actual consent document text

`GET /api/consent/template` (patient-only) fetches the live title/header/footer/module text from gICS's `listCurrentConsentTemplates` for whichever template `_TEMPLATE_NAME`/`_TEMPLATE_VERSION` currently points at, and the mobile consent screen has a **"View full consent document"** button that renders it — see [Part 1 §11](01-patient-journey.md#11-research-consent) for the patient-facing side. This is purely additive and read-only: it does not touch `accept_consent()`/`revoke_consent_strict()`, which keep working exactly as before regardless of whether this call succeeds. One thing worth knowing if you ever edit this content in gICS's admin UI: **type directly with the Editor tab's formatting buttons (Heading/Text), never paste raw HTML into the "HTML" source tab** — content pasted that way gets HTML-entity-escaped *again* on save (e.g. `<p>` becomes `&amp;lt;p&amp;gt;`), and `get_current_template()` has to run a repeated-unescape pass (`_deep_html_unescape()`) to undo it. See §10.9.

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

**Schema-fix services:** gICS and gPAS use EclipseLink JPA DDL that generates MariaDB columns too narrow for its UTF-8MB4 index limits out of the box. Two one-shot services (`gpas-schema-fix`, `gics-schema-fix`, `restart: "no"`) poll for the tables to exist, then widen the offending columns. They don't block startup. `gics-schema-fix` has picked up a new fix as of 2026-08-12 ("FIX 6"): gICS's own admin-UI **Dashboard** statistics feature (the "Refresh" button showing consent/withdrawal counts) failed with `Data truncation: Data too long for column 'stat_attr'` the first time it was used with real template names — `stat_value.stat_attr` was `VARCHAR(50)`, widened to `VARCHAR(255)`. Purely cosmetic (only affects gICS's own dashboard display, not anything the app calls) but worth knowing: unlike the other fixed columns, `stat_value` is created **lazily** on first Dashboard use rather than at domain-creation time, so a genuinely fresh stack may need this `ALTER` run by hand once if the schema-fix service happens to run before the table exists — see the comment in `docker-compose.yml` right above "FIX 6".

### Relevant environment variables

Every `GICS_*` value below except `GICS_URL`/`GICS_TIMEOUT`/`GICS_LOG_SOAP` must match something that actually exists in gICS's admin UI, **exactly** — a mismatch fails closed as an unhandled `500`, not a helpful error. See §10 for how to (re)create these from scratch and verify each one live before setting it here.

| Variable | Current value | Notes |
|---|---|---|
| `GICS_URL` | `http://gics:8080` | |
| `GICS_DOMAIN` | `Morafek` | Consent domain — **case-sensitive**, verify with `listDomains` (§10.7) |
| `GICS_SIGNER_ID_TYPE` | `IMI` | Must match the domain's configured signer-ID type exactly |
| `GICS_TEMPLATE_NAME` | `Consent to Wearable Health Data Recording` | The **Consent**-type template. SOAP name is the Label text, not the admin UI's Key field — see §10.8 |
| `GICS_TEMPLATE_VERSION` | `1.3` | Version history: v1.0 (original, permanently double-escaped content, §10.9) → v1.2 (fixed the escaping, but the duplicate silently dropped the module's policy assignment — **every status read came back `UNKNOWN`, live, for a period** — see §10.7's incident writeup) → **v1.3** (clean content, policy assignment explicitly re-confirmed before being trusted). Full history in §10.11 |
| `GICS_WITHDRAWAL_TEMPLATE_NAME` | `Withdrawal of Consent to Wearable Health Data Recording` | The **Withdrawal**-type template used by `revoke_consent()` — see §2 "Two document types". Note this is a different SOAP identity than the original `withdrawal_wearable_health_data` (v1.0) — not a version of it, a separate template lineage that happened to fall back to Label naming (§10.8) |
| `GICS_WITHDRAWAL_TEMPLATE_VERSION` | `1.3` | Bumped alongside the Consent template in the same v1.3 pass, same policy-assignment fix |
| `GICS_MODULE_NAME` | `Wearable Health Data Recording` | **Not** the old snake_case `wearable_health_data_recording` — the v1.3 duplicate fell back to the Label (Title Case, spaces) the same way templates did earlier. Assigned to both templates above |
| `GICS_MODULE_VERSION` | `1.3` | **Only relevant to `addConsent`** (`moduleStates` entry) — `refuseConsent` and the status-read operations never reference a module version at all |
| `GICS_POLICY_NAME` | `enrich_consent_policy` | Used by status-read queries (`getPolicyStatesForPolicyNameAndSignerIds`) — the one thing that stayed constant through every version bump above |
| `GICS_POLICY_VERSION` | `1.0` | Not currently sent in any envelope — kept for parity |
| `GICS_TIMEOUT` | `10` | Seconds |
| `GICS_LOG_SOAP` | `0` | Set `1` to log outbound SOAP envelopes |
| `GPAS_URL` | `http://gpas:8080` | |
| `GPAS_DOMAIN` | `morafek-patients` | Pseudonym domain — created via gPAS's own admin UI (`http://localhost:8080/gpas-web/`), same "verify, don't assume" caveat applies |
| `GPAS_ENABLED` | `true` | Set `false` to skip gPAS entirely (e.g. local dev without the full stack) — consent still records in gICS/Mongo, pseudonym fields stay `null`, and FHIR export falls back to the Mongo `_id` |

---

## 10. First-Time gICS Setup (Manual, via Admin UI)

`backend/gics_setup.py` exists but targets an **older** domain-naming scheme (`morafek-data-sharing` / `morafek-patient-id`) that predates everything in this section — it does not describe or create what's actually running today. Every domain/policy/module/template in gICS right now was created **by hand** through gICS's admin UI on 2026-08-12, with each step verified against a live SOAP call before the corresponding `backend/.env` variable was set — not assumed from what the admin UI displayed. Follow this whenever standing the stack up from a fresh MariaDB volume (e.g. after `docker compose down -v`), or when reconfiguring the consent domain.

**Admin UI:** `http://localhost:8082/gics-web/` — no login in this dev deployment (the container ships open; not something to expose beyond localhost).

### 10.1 Domain

Options → Domains → new domain.
- **Label:** whatever you want (currently `Morafek`)
- **Signer-IDs:** the identifier type the app will sign patients with — this becomes `GICS_SIGNER_ID_TYPE` (currently `IMI`)

### 10.2 Policy

Forms → Policies → new. Label + an explicit **Key** (don't leave it blank — see §10.8 for why that matters). → `GICS_POLICY_NAME` (currently `enrich_consent_policy`).

### 10.3 Module

Forms → Modules → new. Assign the policy from §10.2. Key → `GICS_MODULE_NAME` (currently `Wearable Health Data Recording` — see §10.8, this one fell back to Label too on its last version bump). Write the Title/Text using the **Editor** tab's formatting toolbar — not the **HTML** tab (§10.9).

**If you ever duplicate this module to fix content later (as happened going from v1.0 to v1.2, §10.7):** the policy assignment does **not** automatically carry over. Re-open the duplicated module and explicitly re-attach the policy before trusting the new version — verify via `<assignedPolicies>` in a live `listCurrentConsentTemplates` call (§10.7), not by assuming it copied across.

### 10.4 Consent template

Forms → Templates → new.
- **Type:** Consent
- Label / Key / Version — **start at `1.0`** for a genuinely fresh setup; this deployment is currently on `1.3` only because of the version-bump history in §10.11 (fixing mistakes), not because a new setup needs to start there. Type the content correctly the first time (Editor tab, §10.9) and you should never need to bump it at all.
- Title / Header / Footer via the Editor tab (§10.9)
- **Search and sort modules** → select the module from §10.3

This button is disabled until Label and Version are filled in — if it looks stuck, that's why, not a real blocker.

### 10.5 Withdrawal template

Forms → Templates → new.
- **Type:** Withdrawal
- **Reuse the exact same module from §10.3** — search for it and select it, do **not** create a new one. This is the single most important step in this whole setup: status reads query by policy name across the whole domain, and the policy is only reachable through the module it's assigned to. A fresh module here would silently disconnect withdrawals from everything the app already reads.
- Answer options: check only **"Yes (Withdrawn)"**; leave "Consent again," "Object," "Not asked," and "No" unchecked
- **Mandatory:** checked (matches the Consent template's module)
- **Preselection:** "Yes (Withdrawn)"

Same versioning note as §10.4 — start at `1.0` for a fresh setup.

→ `GICS_WITHDRAWAL_TEMPLATE_NAME` / `GICS_WITHDRAWAL_TEMPLATE_VERSION` (currently `Withdrawal of Consent to Wearable Health Data Recording` / `1.3` on this deployment — see §10.8, the Key field fell back to Label here).

### 10.6 gPAS domain

Separately, via gPAS's own admin UI (`http://localhost:8080/gpas-web/` → Domains → New domain). Same Label-vs-Key split as gICS's templates, confirmed live the same way: the domain list displays **Label = `Morafek`**, but the actual SOAP `domainName` — what `GPAS_DOMAIN` in `.env` must match — is the **Key**, `morafek-patients`. Confirmed empirically, not just asserted: every `getOrCreatePseudonymFor` call using `GPAS_DOMAIN=morafek-patients` has succeeded (6 pseudonyms on record as of this writing), which is only possible if that's the real domain name gPAS is matching against.

| Field | Value used | Why |
|---|---|---|
| Label | `Morafek` | Display only |
| **Key** | **`morafek-patients`** | The real `GPAS_DOMAIN` — verify via the domains list if this every needs re-confirming, same as gICS |
| Allow multiple pseudonyms for the same original value | Unchecked | The app relies on `getOrCreatePseudonymFor` returning the *same* pseudonym on every call for a given patient — checking this would break that idempotency guarantee the whole consent-history/reactivation design assumes |
| Allow deletion of pseudonyms | Checked (recommended) | Needed for the admin facility-reactivation flow, which calls `deletePseudonym`. Not independently re-verified this session — flagging as recommended based on the original setup guidance, not re-confirmed live the way the Key was |
| Automatic deletion of pseudonyms → Activate | Unchecked | This project's design deliberately retains pseudonyms forever, even past account deletion (§3) — auto-deletion would silently violate that |
| Pseudonym length / alphabet / check digit | Not functionally significant | The app only ever treats the returned pseudonym as an opaque string (sliced to its last 4 characters for display) — any reasonable generator settings work |

**Not yet re-verified live:** the exact checkbox state of "Allow deletion of pseudonyms" on the domain as it exists today — gPAS's admin UI didn't offer an easy read-only detail view to confirm without risking an edit (the domain already has pseudonyms on it, and gPAS's own UI warns that domains with pseudonyms have limited editability). If the admin facility-reactivation flow (`POST /api/consent/admin/reactivate/<patient_id>`) is ever exercised and its `deletePseudonym` call fails, check this setting first.

### 10.7 Verify, don't assume

This is the step that actually matters. gICS fails closed on any name mismatch: a wrong domain/template/module/policy name doesn't produce a clean SOAP fault, it throws an unhandled server exception → a raw `500 Internal Server Error` with no indication of which field was wrong. Every value from §10.1–10.6 must be confirmed with a live query before it goes into `backend/.env`:

```bash
# List domains — confirms the real domain name + signer-ID type
curl -s -X POST http://localhost:8082/gics/gicsService \
  -H "Content-Type: text/xml; charset=utf-8" -H "SOAPAction:" --data '<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:gics="http://cm2.ttp.ganimed.icmvc.emau.org/">
  <soapenv:Body><gics:listDomains/></soapenv:Body>
</soapenv:Envelope>'

# List current templates for a domain — confirms the real template/module/policy
# names and versions, and which module each template actually has assigned
curl -s -X POST http://localhost:8082/gics/gicsService \
  -H "Content-Type: text/xml; charset=utf-8" -H "SOAPAction:" --data '<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:gics="http://cm2.ttp.ganimed.icmvc.emau.org/">
  <soapenv:Body><gics:listCurrentConsentTemplates><domainName>Morafek</domainName></gics:listCurrentConsentTemplates></soapenv:Body>
</soapenv:Envelope>'
```

In the `listCurrentConsentTemplates` response, read the `<key><name>` that's a **direct child of `<currentConsentTemplates>`** (the template's own key) — not the one nested inside `<assignedModules><module><key>`, which is the *module's* key. See §10.8 for why the template's own name can differ from what you typed into the Key field.

**Name/version matching alone is not enough — a real incident, not a hypothetical.** When the Consent template was first duplicated to fix the double-escaping (v1.0 → v1.2), the new module's **`<assignedPolicies>` list came back empty** — the policy attachment wasn't carried over by the duplicate action, even though the template/module names and versions all matched correctly and `addConsent`/`refuseConsent` both reported success against it. Nothing failed loudly: `addConsent` doesn't validate that a module has a policy before accepting a write, so every accept/revoke call kept returning `200`. The damage was silent and systemic — with no `enrich_consent_policy` record ever created, **every status read came back `UNKNOWN`**: the patient-facing status check, `accept_consent()`'s own idempotency check, and the research sync's eligibility check all silently failed to see any consent that had ever been granted. This ran live for a period before being caught by directly checking `<assignedPolicies>` in the SOAP response, not by anything erroring.

**So "verify" means two separate checks, not one:**
1. Names and versions match what you're about to put in `.env` (the check above).
2. **Each module actually has the expected policy under `<assignedPolicies><policy><key>`** — confirm this explicitly after *any* duplicate/version-bump action, not just the first time a template is created:

```bash
# Same listCurrentConsentTemplates call as above — but this time read
# <assignedModules><module><assignedPolicies><policy><key><name> for each
# module, not just the module's own name/version. An empty <assignedPolicies/>
# is the exact failure mode this note exists for.
```

Only trust a new version once *both* checks pass — the same way v1.3 (§10.11) was confirmed before it went into `.env`, after v1.2 was found broken by exactly this second check.

### 10.8 Gotcha: Label vs. Key

For **Policies** and an explicitly-typed **Key**, that Key is what SOAP calls it. For **Templates** — and, it turns out, **Modules too** once a duplicate is involved — it's inconsistent, and only verifiable live: whenever a Key field was left blank (either on original creation or, seemingly, whenever gICS's "duplicate" action was used), gICS fell back to the **Label** text as the SOAP name instead. This has now happened three separate times on this deployment, to three different objects:

| Object | Explicit Key typed? | SOAP name actually used |
|---|---|---|
| Consent template (original, v1.0) | No | Label: `Consent to Wearable Health Data Recording` |
| Withdrawal template (**original** `withdrawal_wearable_health_data`, v1.0 — no longer referenced by `.env`) | Yes | The Key, as expected |
| Withdrawal template (**current**, v1.3) | No (duplicated from the original without re-typing it) | Label: `Withdrawal of Consent to Wearable Health Data Recording` |
| Module (current, v1.3) | No (same — duplicated without re-typing) | Label: `Wearable Health Data Recording` (Title Case, spaces — not the original snake_case key) |

The pattern is simpler than it first looks: it's not about fresh-creation-vs-duplication — it's just **whether the Key field was actually typed into**, every time. The original Consent template was created fresh (not a duplicate) and still fell back to Label, because Key was left blank there too. The one common trap across all three fallback cases: **duplicating an object does not carry the original's Key into the copy's Key field** — it's easy to assume it did and skip re-typing it, and gICS gives no warning when you don't. Don't assume either way for anything new — run the `listCurrentConsentTemplates` check in §10.7 and use exactly what it returns.

### 10.9 Gotcha: the HTML editor double-escapes pasted source

If you paste raw HTML source (e.g. `<p>Some text</p>`) into a Title/Header/Footer/module Text field's **HTML** tab, gICS's rich-text editor treats it as literal text and HTML-escapes it *again* when it saves — you get `&amp;lt;p&amp;gt;Some text&amp;lt;/p&amp;gt;` stored, not real tags. This happened to the original Consent template's content, and `get_current_template()` has to run a repeated-unescape pass (`_deep_html_unescape()` in `gics_service.py`) to undo it before the mobile app can render it. Avoid it going forward: use the **Editor** tab's toolbar (Heading 1/2/3, Text, bold/italic) and type normally — never paste HTML source into the HTML tab.

### 10.10 Set the env vars and restart

Update `backend/.env` with every value confirmed in §10.7 (see the table in §9). Then:

```bash
# Env-only change (no gics_service.py edits) — restart is enough:
docker compose up -d backend

# If gics_service.py itself changed too — image must be rebuilt, a plain
# restart will still run the OLD code:
docker compose build backend && docker compose up -d backend
```

The second form is easy to forget and produces a confusing symptom: `docker exec morafek-backend env | grep GICS_` shows the new values, but the actual behavior doesn't change, because the container's Python source is still the old code baked into the image from the last build. If a fix "doesn't seem to work" after an env change, check whether source changed too before assuming the fix itself is wrong.

### 10.11 Reference: exact content in use today

The real field values and text content currently configured, for reproducing this exactly or reviewing what's actually live. **Full version history, 2026-08-12:**

1. **v1.0** — original content. The Consent template's Title/Header (created via the HTML tab) showed up as literal double-escaped tag text even inside gICS's own admin editor — the escaping happened at save time, baked into the stored content, not just an artifact of our app's rendering.
2. **v1.2** — duplicated to fix the escaping (once a template has signed consents against it, gICS restricts further editing — §2's "already final" note — so the fix had to be a new version, gICS's own suggested path). Content came out clean, **but the duplicate silently dropped the module's policy assignment** — every status read (patient status check, accept's idempotency check, research sync eligibility) came back `UNKNOWN` for the entire time this version was live, with nothing erroring to flag it. Root-caused by checking `<assignedPolicies>` directly, not by anything failing loudly — full incident writeup in §10.7.
3. **v1.3** — the actual current version. Same clean content as v1.2, policy assignment explicitly re-confirmed present before being trusted.

Both the Consent **and** Withdrawal templates went through this same v1.0 → v1.2 → v1.3 progression together (versioned in the same passes). The sections below show the current v1.3 content, with v1.0 preserved collapsed for historical reference — it's still the exact wording the earliest signed consents point at.

**Policy** (`enrich_consent_policy`)
| Field | Value |
|---|---|
| Label | ENRICH Consent Policy |
| Key | `enrich_consent_policy` |
| Version | 1.0 |

### Module — current version **v1.3**, Key `Wearable Health Data Recording`

Version history: **v1.0** (original, permanently double-escaped) → **v1.2** (fixed the escaping, but the duplicate silently dropped `<assignedPolicies>` — broken for status reads the whole time it was configured, see §10.7) → **v1.3** (clean content, policy explicitly re-confirmed attached before being trusted). Also note the Key itself changed on the v1.0→v1.2 step: it's `Wearable Health Data Recording` (Title Case, spaces) now, not the original snake_case `wearable_health_data_recording` — another Label-fallback instance (§10.8).

Two real content changes beyond fixing the escaping, worth knowing before assuming this is still draft text: **"Storage & retention" is now answered ("10 Years")**, and **"Your rights" now commits to an actual policy (delete previously-recorded data on withdrawal)**. "What we do with it" is still a bracketed placeholder — the one thing left before this is legally usable copy, not draft text.

| Field | Value |
|---|---|
| Label | Wearable Health Data Recording |
| Key (= SOAP name) | `Wearable Health Data Recording` |
| Version | **1.3** |
| Short description | *Consent to record and process biometric/health readings from your wearable device.* |
| Title | `<h2><span style="background-color: rgb(238, 238, 238);">Health & Biometric Data from Your Wearable Device</span></h2>` — the inline `background-color` is a harmless leftover from pasting formatted text into the Editor tab rather than typing fresh; invisible in the app since the mobile renderer strips all styling |
| Assigned policy | ENRICH Consent Policy v1.0 — **confirmed present** via live `<assignedPolicies>` check (§10.7), not just assumed from the name matching |

```html
<div>We would like to record and process health-related data from your wearable device,
such as heart rate, sleep patterns, activity levels, or other biometric readings. This is
considered special category (health) data under data protection law and requires your
explicit consent.</div>
<div><strong>What we do with it:</strong> [ monitoring, diagnostics, research, sharing with
your care provider]</div>
<div><strong>Storage &amp; retention:</strong> [10 Years ]</div>
<div><strong>Your rights:</strong> You can withdraw this consent at any time. If you
disagree or withdraw, we will stop recording this data going forward, and delete
previously recorded data.</div>
```

*(v1.3's content is identical to v1.2's — the fix between those two versions was the policy assignment, not the text. See below for the original v1.0 wording.)*

<details>
<summary>v1.0 (superseded 2026-08-12 — kept for reference only, no longer live)</summary>

Original content. Double-escaped title (`<div>&lt;h3&gt;...&lt;/h3&gt;&lt;/div&gt;`) and all three fields still bracketed placeholders:

```html
<p>We would like to record and process health-related data from your wearable
device, such as heart rate, sleep patterns, activity levels, or other
biometric readings. This is considered special category (health) data
under data protection law and requires your explicit consent.</p>

<p><strong>What we do with it:</strong> [describe purpose — e.g. monitoring,
diagnostics, research, sharing with your care provider]</p>

<p><strong>Storage &amp; retention:</strong> [state how long and where]</p>

<p><strong>Your rights:</strong> You can withdraw this consent at any time.
If you disagree or withdraw, we will stop recording this data going forward,
[and/or delete previously recorded data — state your actual policy].</p>
```

</details>

### Consent template — current version **v1.3**

v1.0 → v1.2 → v1.3, same history as the module above (they were versioned together each time). `GICS_TEMPLATE_VERSION`/`GICS_MODULE_VERSION` in `.env` point at v1.3, confirmed live — both name/version match *and* the module's policy assignment is present — before being trusted (§10.7). The 23 consents signed under v1.0, and however many signed during the brief v1.2 window, are untouched and remain historically valid against their exact wording at the time — this is the actual point of template versioning, not a side effect to work around.

| Field | Value |
|---|---|
| Type | Consent |
| Label | Consent to Wearable Health Data Recording |
| Key | Consent to Wearable Health Data Recording *(identical to Label — see §10.8)* |
| Version | **1.3** |
| Title | `<h2>Consent for Recording and Processing of Wearable Health Data</h2>` — clean, single-escaped, confirmed live |
| Header | See below |
| Footer | *(empty)* |
| Module | Wearable Health Data Recording **v1.3** (above) — Mandatory: Yes, Answer options Yes (Accepted) / No (Declined), Preselection: `--None--` (changed from v1.0's `Yes` — worth a deliberate look if that default matters to you) |

```html
Please read the following information carefully before providing your
consent. This document explains how we collect, store, and use health and
biometric data recorded by your wearable device

You may agree or disagree to each section individually. You can withdraw
your consent at any time, see Section "Your Rights" below.
```

<details>
<summary>v1.0 (superseded — kept for reference; still the version the earliest signed consents point at)</summary>

```html
<p>Please read the following information carefully before providing your
consent. This document explains how we collect, store, and use health and
biometric data recorded by your wearable device.</p>
<p>You may agree or disagree to each section individually. You can withdraw
your consent at any time — see Section "Your Rights" below.</p>
```

</details>

### Withdrawal template — current version **v1.3**, a *different* SOAP identity than the original

Not a version bump of `withdrawal_wearable_health_data` — the Key field wasn't carried over when the v1.2/v1.3 duplicates were made, so gICS fell back to the Label as the SOAP name (§10.8). The original `withdrawal_wearable_health_data` v1.0 template **still exists and is still "current"** in gICS, as a separate, parallel lineage — it's simply no longer what `.env` points at. Same policy-assignment fix as the Consent template applies here too, confirmed via the same live check.

| Field | Value |
|---|---|
| Type | Withdrawal |
| Label | Withdrawal of Consent to Wearable Health Data Recording |
| Key (= SOAP name) | `Withdrawal of Consent to Wearable Health Data Recording` *(fell back to Label — not a distinct Key this time, unlike the original v1.0 template)* |
| Version | **1.3** |
| Title | `<h2>Withdrawal of Consent for Wearable Health Data Recording</h2>` |
| Header | *By submitting this, you are withdrawing your previously given consent to record and process health data from your wearable device. This applies going forward — see the original consent document for how previously recorded data is handled.* |
| Module | Wearable Health Data Recording **v1.3** (same module as the Consent template — see §10.5), policy assignment confirmed, Preselection: Yes (Withdrawn) |

<details>
<summary>The original withdrawal_wearable_health_data v1.0 (still exists in gICS, no longer referenced by .env)</summary>

Left in place, untouched — created clean from the start (Editor tab, no escaping issue to ever fix), so there was never a reason to retire it. It's simply not what `GICS_WITHDRAWAL_TEMPLATE_NAME` points at anymore. If a future duplicate ever explicitly sets the Key field, a new REVOCATION-type template could end up with this exact name again — verify via `listCurrentConsentTemplates` (§10.7) if that ever seems to be happening, rather than assuming which one is live.

| Field | Value |
|---|---|
| Key | `withdrawal_wearable_health_data` |
| Version | 1.0 |
| Module | Wearable Health Data Recording v1.0 (its own independent assignment) |

</details>

---

## 11. What's Not Built Yet

Keeping this list explicit, since several of the docs this file replaces were written mid-implementation and it's easy to assume more exists than actually does:

- **`POST /api/patient/erasure-request`** — the patient-facing side of §5. Without it, the admin erasure queue is real code with nothing to review.
- **Researcher data access/export** — `GET /api/research/data/patients` and `POST /api/research/data/export` are placeholder comments in `research_routes.py` only. A researcher can trigger a sync and see aggregate stats, but there is no endpoint to actually read `research_vitals` rows yet.
- **Manual acknowledge/dismiss for sync issues** — issues only self-resolve; there's no admin action to hide one early.
- **Real admin/researcher provisioning** — both roles exist only via the dev seed (admin) or open self-registration (researcher/admin alike via `POST /register`). No invite or promotion flow exists.
- **A background/scheduled sync** — by design, for now (§6) — but worth revisiting if the on-demand model proves insufficient once researchers actually rely on it day to day.

---

## 12. Research & Admin API Reference

All routes require `Authorization: Bearer <token>`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/research/sync` | researcher | Refresh eligibility + mirror vitals for all patients |
| GET | `/api/research/sync/status` | researcher | Last sync timestamp + stats |
| GET | `/api/admin/sync-issues` | admin | List standing sync problems |
| GET | `/api/admin/erasure-requests` | admin | List erasure requests (+ live `affected_row_count`) |
| POST | `/api/admin/erasure-requests/<request_id>` | admin | Approve (destructive) or deny |
| POST | `/api/consent/admin/reactivate/<patient_id>` | doctor/admin | Issue a fresh pseudonym (see [Part 2 §10](02-doctor-journey.md#10-admin-facility-reactivation)) |

For the patient-facing consent routes (`/api/consent/accept`, `/revoke`, `/status`, `/diagnose`, `/template`), see [Part 1 §11](01-patient-journey.md#11-research-consent).
