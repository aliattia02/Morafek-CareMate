# Identified vs. Research Data Stores — Implementation Reference

> **Status:** Partially implemented as of 2026-08-11. Phase 1 (`consent_history`
> + `patient_identifiers.doctor_sharing`) has shipped and is verified against
> the actual `consent_routes.py` / `doctor_routes.py` / `patient_routes.py` /
> `main.py` diffs applied on that date. Phase 2 (`research_vitals`, the sync
> job, `erasure_requests`) was originally proposed-only, but **part of it has
> now shipped**: `research_routes.py::sync_research_consent_status()`
> implements the eligibility half of the sync job (§4) — it writes
> `patient_identifiers.gics_consent_status` and `patient_identifiers.research_eligible`
> on demand via `POST /api/research/sync`. `erasure_requests` is untouched and
> still fully proposed-only. Each section below is now labeled ✅ **Implemented**,
> 🚧 **Deferred (Phase 2 / Phase 2.5)**, or ⚠️ **Spec corrected** (where the
> original proposal didn't match the real schema and had to be adapted). This
> extends `consent-gics-gpas-reference.md` (§10 MongoDB Data Model, §8 Consent
> Flows), which was updated in the same pass — see that file's §16.
>
> **New file, Phase 1:** `backend/utils/consent_history.py` — owns all
> `consent_history` and `patient_identifiers` reads/writes described below.
> **`research_routes.py`** now also writes `patient_identifiers` directly
> (`gics_consent_status`, `research_eligible`) — see §2.1 and §4.
>
> **New file, Phase 2.5 (this pass):** `backend/utils/research_mirror.py` —
> the vitals-mirroring half's core logic is now written:
> `mirror_patient_vitals(db, patient_id, research_pseudonym)` reads
> `consent_history` intervals via `get_consent_intervals()`, walks all five
> `vitals_*` collections for one patient, de-identifies and upserts the
> in-window readings into a single `research_vitals` collection keyed on
> `(research_pseudonym, source_collection, source_observation_id)`, and fails
> closed on any reading with a missing/unparseable `effectiveDateTime`.
> `main.py::_ensure_mongo_indexes` now creates the two `research_vitals`
> indexes this function needs (`idx_research_vitals_dedup`,
> `idx_research_vitals_pseudonym_time`). **What this pass does *not* include:
> a caller.** No route in this codebase invokes `mirror_patient_vitals()`
> yet — `research_routes.py` was not part of this update, so
> `sync_research_consent_status()` still only runs the eligibility loop (§4).
> `patient_identifiers.research_pseudonym` is therefore still unwritten: the
> function accepts a pseudonym as an argument but nothing yet computes one
> (from `patient_consents.pseudonym`, per `consent-gics-gpas-reference.md`
> §13 Known Issue #2) and passes it in. See §2.4 and §4 for what remains.
>
> **Design decision, same day:** the Phase 2 sync (§4) is now
> researcher-triggered on demand rather than run on a fixed schedule — see
> §7.3 for the full record. This replaces the earlier "hourly, on the hour"
> proposal everywhere it appeared in this file (§1.1, §4, §5.4, §7.3, §8).
> The on-demand trigger model has since been **built for the eligibility
> half** (`POST /api/research/sync`, `GET /api/research/sync/status`) — see
> §7.3. Vitals mirroring under that same trigger is still 🚧 Phase 2.5 — the
> decision is settled, that half of the code isn't written.

---

> **Re-verified 2026-08-11, later pass — the paragraph above is now stale
> and wrong, not just incomplete.** Re-checked every claim in this file
> directly against the current `research_routes.py`, `research_mirror.py`,
> and `main.py` (not just the earlier pass's summary of them). The premise
> "Phase 2.5 mirroring logic is written but nothing calls it" **no longer
> holds**: `research_routes.py::sync_research_consent_status()` now
> resolves `research_pseudonym` from `patient_consents.pseudonym` and calls
> `mirror_patient_vitals()` for every currently-eligible patient, in the
> same per-patient loop as the eligibility refresh — not as a second,
> separately-triggered pass. Concretely, that means:
> - `patient_identifiers.research_pseudonym` **is now written** (§2.1) —
>   the "still unwritten" callout above and in §2.1 is no longer accurate.
> - `research_vitals` **is now populated** by a sync run, not just
>   theoretically writable (§2.4) — the mirroring function has a live
>   caller.
> - The "eligibility half done, vitals half deferred" framing that runs
>   through §1.1, §4, §5.1, §5.4, §7.3, and the §8 table below is
>   corrected in place in each of those sections — search this file for
>   "2026-08-11, later pass" to find every spot that changed.
> - What's genuinely still true from the paragraph above: there is still
>   no researcher-portal UI button calling either endpoint (§7.3), and
>   `erasure_requests` is still fully unbuilt (§2.5, §7.2) — confirmed
>   against `research_routes.py`'s own placeholder comment block, which
>   still only lists those as future endpoints.
>
> **Also this pass — resolved the UNKNOWN-mapping open question** flagged
> in §2.1 below (`_normalize_gics_status()`'s handling of gICS `UNKNOWN`).
> Tracing it uncovered a real bug, not just a missing policy: `gics_service.
> get_consent_status()` was collapsing four different situations — gICS
> unreachable, a non-"not found" SOAP fault, an unparseable response, and a
> genuine "no consent record for this patient" answer — into the same
> `"UNKNOWN"` string, and it never raised, so the sync loop's
> `except Exception` could never distinguish a real gICS failure from a
> legitimate "hasn't consented" state. A transient gICS timeout for one
> patient was silently written as `research_eligible: False` and counted
> as a normal state change, not an error. Fixed by adding
> `gics_service.get_consent_status_detailed()`, which returns
> `{"status", "ok", "error"}` and keeps that distinction; the sync job now
> uses it, routes real failures into `error_count`/`errors[]` and leaves
> `research_eligible` untouched for them, and only maps a genuine
> gICS-confirmed `UNKNOWN` to ineligible. `get_consent_status()` itself is
> unchanged — every other caller (`accept_consent()`'s idempotency check,
> `GET /api/consent/status`, `diagnose_consent_stack()`) is written to
> treat "gICS down" and "no consent on record" the same way on purpose, and
> changing that contract was out of scope for this fix. See §2.1 and §4.

---

> **Same day, next pass — admin routes (admin-routes-plan.md).** Two
> follow-on gaps from the pass above now have a real admin-facing surface,
> in a new file, `backend/routes/admin_routes.py` — admin-only (not
> doctor-or-admin; see §4.1 of admin-routes-plan.md for why erasure
> approval specifically needed a stricter gate than
> `admin_reactivate_consent()`'s doctor-or-admin pattern):
> - **`sync_issues` — new collection, §2.6.** The missing-pseudonym gap
>   this file's §2.4 flagged as "worth a follow-up" now persists to a
>   collection instead of just a log line, and — per explicit direction —
>   also tracks *repeated* `gics_query_failure`s the same way, not only
>   missing pseudonyms. Self-healing: an issue clears itself the moment a
>   later sync no longer sees the condition. Read via
>   `GET /api/admin/sync-issues`.
> - **`erasure_requests` — partially real, §2.5/§5.3/§7.2 updated.** The
>   collection, indexes, and the admin *approval* side
>   (`GET /api/admin/erasure-requests`,
>   `POST /api/admin/erasure-requests/<id>`) are now built. The
>   patient-facing *creation* endpoint (`POST /api/patient/erasure-request`)
>   is explicitly **held for later** — so the admin queue is real code
>   sitting in front of an empty collection today, not a stub.
>
> **Also this pass:**
> - `auth_routes.py` had its own `VALID_USER_TYPES` list, missing
>   `"researcher"` — since `login()` gates on it before ever touching the
>   database, this meant no researcher account could log in *or* register,
>   even one inserted by hand. The entire research-sync feature this file
>   describes was unreachable through the real auth flow. Fixed by
>   importing the list from `utils/auth.py` instead of maintaining a
>   second copy. Not really a data-store-separation change, noted here
>   only because it's what makes everything else in this file reachable
>   at all.
> - `auth_routes.py::delete_account()` (DSGVO Art. 17) now also wipes
>   `patient_identifiers` and `sync_issues` — both identified,
>   `patient_id`-keyed data that postdate this route and were never added
>   to its cleanup list. `consent_history` and `research_vitals` remain
>   deliberately untouched, same reasoning as the existing gPAS-pseudonym
>   retention decision already in that route. See §2.1 and §2.6.
> - A **temporary, insecure dev admin account** (username `admin`,
>   password `1234`) is now seeded on backend startup
>   (`main.py::_ensure_dev_admin_account()`), so `admin_routes.py` is
>   reachable without a manual DB insert. Explicitly not a real
>   provisioning flow — flagged in code and here so it isn't mistaken for
>   one. `auth_routes.py`'s `/register` endpoint still allows anyone to
>   self-register a second admin account too; that door is still open,
>   independent of this seed.

---

## Table of Contents

1. [Design principle](#1-design-principle)
2. [Collections](#2-collections)
3. [Consent history semantics](#3-consent-history-semantics)
4. [Sync job algorithm](#4-sync-job-algorithm)
5. [Edge cases and decisions](#5-edge-cases-and-decisions)
6. [Example queries](#6-example-queries)
7. [Resolved decisions](#7-resolved-decisions)
8. [Implementation status summary](#8-implementation-status-summary-2026-08-11)

---

## 1. Design principle

Identified data (things that link back to a real patient) and pseudonymized
research data live in **separate collections**, not separate columns of the
same collection. The boundary is enforced by what data physically exists
where, not only by which queries the application chooses to run.

This mirrors the reason gICS/gPAS exist at the identity layer in the first
place — a pseudonym instead of a real ID — extended to the vitals data itself.
If `research_vitals` is ever exported, backed up, or queried incorrectly,
there is no identifying field in it to link back to a person. **✅ Mirroring
logic implemented and reachable (2026-08-11, later pass)** —
`utils/research_mirror.py` builds `research_vitals` documents this way (it
strips `patient_id`, `subject`, `performer`, `recorded_by`, and `note` before
writing — see §2.4), and `research_routes.py::sync_research_consent_status()`
now calls it for every currently-eligible patient on each sync run — the
collection is populated the moment a researcher (or anyone with the
endpoint) triggers `POST /api/research/sync`. It's already true for
`consent_history`, which is live: it's keyed on pseudonym only, never
`patient_id`.

Three independent consent tracks feed into this model (see
`consent-gics-gpas-reference.md` for the two TTP-backed ones):

| Track | Mechanism | Governs | Status |
|---|---|---|---|
| App identity | The existing `users._id` / `patient_id` string (see §2.1 correction below) | Whether the app functions at all | ✅ Already existed |
| Doctor data-sharing | Plain MongoDB flag, `patient_identifiers.doctor_sharing` | Whether a doctor can read the patient's data | ✅ Implemented |
| Research consent | gICS + gPAS | Whether `research_vitals` receives this patient's readings | ✅ Implemented — eligibility caching (`gics_consent_status`/`research_eligible`) and `research_vitals` mirroring both run in the same on-demand sync (§2.1, §4); confirmed wired 2026-08-11, later pass |

### 1.1 How gICS and gPAS touch these collections

Status update: this table was written as a proposal against
`consent-gics-gpas-reference.md` §8.3/§8.4/§8.5 as they existed before this
implementation pass. The `consent_history` row is now **✅ implemented** —
`consent-gics-gpas-reference.md` §8.3, §8.4, and §8.5 have been updated in
place to describe the real write. The `gICS` → `patient_identifiers.gics_consent_status`
row is now **✅ implemented** too — `research_routes.py::sync_research_consent_status()`
performs exactly this refresh on demand (§4, §7.3). The `research_vitals` row
is now **✅ implemented and wired** (2026-08-11, later pass) —
`utils/research_mirror.py` does exactly what this row describes, and
`sync_research_consent_status()` now calls it for every currently-eligible
patient on each sync run.

| Service | Touches | How |
|---|---|---|
| gICS | `patient_identifiers.gics_consent_status` | Refreshed by the researcher-triggered sync (§4) — no longer a background schedule, see §7.3 — mirroring `gics.get_consent_status()` — consent-gics-gpas-reference.md §6.1 |
| gICS | `consent_history` | Every strict accept/revoke that successfully calls gICS (consent-gics-gpas-reference.md §8.3 step 2, §8.4 step 1) would need to also append a new interval row — open one on accept, close the open one on revoke. **This write does not exist in either route today; it is new work this design depends on.** |
| gPAS | `consent_history` | The `pseudonym` field on every row is the value `gpas.get_or_create_pseudonym()` returns (consent-gics-gpas-reference.md §6.2, §8.3 step 3). Since that call is idempotent, a patient-initiated re-grant always appends a row under the *same* pseudonym (§3 below); only admin/facility reactivation (§8.5, `gpas.delete_pseudonym()` + re-create) produces a genuinely new one. |
| gPAS | `research_vitals` | `research_pseudonym` is the same gPAS-issued value, copied at the point `consent_history` shows an active interval covering the reading — this is exactly what `research_mirror.mirror_patient_vitals(db, patient_id, research_pseudonym)` does. No `uuid` ever appears here — gPAS is the only service in this design that ever sees an identifier capable of pseudonymizing this collection. **Resolved (2026-08-11, later pass):** `sync_research_consent_status()` now resolves `research_pseudonym` from `patient_consents.pseudonym` for every currently-eligible patient and passes it into `mirror_patient_vitals()`, writing the value back onto `patient_identifiers.research_pseudonym` in the same step. If a patient is eligible but has no `patient_consents.pseudonym` yet, the sync logs a warning and skips mirroring for them that pass rather than failing the sync — see §4's edge-case note. |

Practically: **gICS decides *when* an interval opens or closes; gPAS decides
*who*** — which pseudonym that interval belongs to, and which pseudonym
`research_vitals` rows get mirrored under. `consent_history` is the one
collection both services write into, for different fields, at different
moments within the same accept/revoke request. Neither service ever touches
`patient_vitals` or `research_vitals`'s reading data directly — vitals
content itself only ever moves through the sync job (§4), which reads
`consent_history` but doesn't call gICS or gPAS at request time.

---

## 2. Collections

### 2.1 `patient_identifiers` — ✅ Implemented, ⚠️ spec corrected

One document per patient. Identified data. Lives in
`backend/utils/consent_history.py` (`get_doctor_sharing()` /
`set_doctor_sharing()`); unique index `idx_patient_identifiers_unique` on
`patient_id`, created in `main.py::_ensure_mongo_indexes`.

**Lifecycle, added 2026-08-11:** cleaned up on account deletion —
`auth_routes.py::delete_account()` (DSGVO Art. 17) now `delete_many()`s
this collection by `patient_id` alongside the existing EHR collections.
Wasn't wired in when that route was first written, since this collection
postdates it. `research_pseudonym` here is just a locally-cached copy of
the same gPAS pseudonym in `patient_fhir_identifiers` (also deleted on
account deletion), so removing it fits the same "delete the local cache,
the authoritative link stays in gPAS" reasoning that route already applies
to that field — this isn't a new policy, just catching a field that didn't
exist yet the last time that reasoning was applied.

| Field | Type | Description | Status |
|---|---|---|---|
| `patient_id` | `string` | **Corrected from `uuid`.** There is no separate local-UUID identity in the real app — every other collection (`users`, `patient_consents`, `patient_fhir_identifiers`, all `vitals_*`) already keys on `str(users._id)` as `patient_id`. Introducing a second identity field here would just be something else to keep in sync, for no benefit. | ✅ Implemented as `patient_id` |
| `doctor_sharing` | `bool` | Patient-controlled, independent of gICS entirely. | ✅ Implemented |
| `gics_consent_status` | `string` | Cached live status: `"accepted"` \| `"revoked"` \| `"unknown"` | ✅ Implemented — written by `research_routes.py::sync_research_consent_status()` |
| `research_pseudonym` | `string \| null` | Full gPAS pseudonym. Research-only. Never exposed to the client. | ✅ Implemented (2026-08-11, later pass) — `research_routes.py::sync_research_consent_status()` resolves it from `patient_consents.pseudonym` for each currently-eligible patient and writes it here before calling `research_mirror.mirror_patient_vitals()` |
| `research_eligible` | `bool` | Fast flag consumed by researcher queries. | ✅ Implemented — written by `research_routes.py::sync_research_consent_status()` |

**Update, same pass:** `gics_consent_status` and `research_eligible` are now
real — `research_routes.py::sync_research_consent_status()` writes both,
triggered on demand via `POST /api/research/sync` (§4, §7.3). Both values
follow the normalized ACCEPTED/REJECTED/UNKNOWN status
`gics_service.get_consent_status()` returns (`consent-gics-gpas-reference.md`
§6.1). **How `UNKNOWN` maps to `research_eligible` — resolved 2026-08-11,
later pass.** This was flagged as raised-but-undecided in an earlier pass of
this file. Tracing it turned up a real bug underneath the open question:
`get_consent_status()` collapsed four different situations into the same
`"UNKNOWN"` string — gICS unreachable, a non-"not found" SOAP fault, an
unparseable response, and a genuine "no consent record for this patient"
answer — and never raised, so the sync loop's `except Exception` could never
tell a real gICS failure apart from a legitimate "hasn't consented" state. A
transient gICS timeout for one patient was silently written as
`research_eligible: False` and counted as a normal state change, not an
error. Fixed by adding `gics_service.get_consent_status_detailed()`, which
returns `{"status", "ok", "error"}`; `sync_research_consent_status()` now
uses it, routes a failed query (`ok=False`) into `error_count`/`errors[]`
and leaves `research_eligible` untouched for that patient, and only maps a
*genuine* gICS-confirmed `UNKNOWN` (`ok=True`) to `research_eligible=False`,
same as `REJECTED` — there's nothing to be eligible for until the patient
actually consents. `get_consent_status()` itself still collapses everything
to a plain string and is unchanged, since every other caller
(`accept_consent()`'s idempotency check, `GET /api/consent/status`,
`diagnose_consent_stack()`) is written to treat "gICS down" and "no consent
on record" the same way on purpose.

**`research_pseudonym` is now real (2026-08-11, later pass).** An earlier
pass of this file said nothing writes it — that's no longer true.
`research_mirror.mirror_patient_vitals()` (Phase 2.5, §4) still just accepts
a pseudonym and mirrors readings under it, but `sync_research_consent_status()`
now resolves *which* pseudonym to pass — from `patient_consents.pseudonym`,
per `consent-gics-gpas-reference.md` §13 Known Issue #2's resolved answer —
and writes it back onto `patient_identifiers.research_pseudonym` in the same
step, for every patient currently `research_eligible`. This field is now
safe to read for eligible patients; it stays unset for patients who have
never been eligible in a sync pass, and for eligible patients who don't yet
have a `patient_consents.pseudonym` (logged as a warning, not an error — see
§4).

**Default behaviour, called out explicitly because it's a real decision, not
a formatting detail:** `get_doctor_sharing()` returns `True` when a patient
has no `patient_identifiers` doc yet (i.e. every existing patient today, and
every new patient until they first touch the toggle). This was chosen so
shipping the AND-gate in §7.1 doesn't silently cut off doctor access for the
entire existing patient base — see `DEFAULT_DOCTOR_SHARING` in
`consent_history.py` if an opt-in model (default `False`) is wanted instead.

### 2.2 `consent_history` — ✅ Implemented

Append-only. One row per grant or revoke event. Supports any number of
grant/revoke cycles for a single pseudonym (see §3). Compound index
`idx_consent_history_pseudonym_granted` on `(pseudonym, granted_at)`, created
in `main.py::_ensure_mongo_indexes`. All reads/writes go through
`open_consent_interval()` / `close_consent_interval()` in
`backend/utils/consent_history.py` — no route touches this collection
directly.

| Field | Type | Description |
|---|---|---|
| `pseudonym` | `string` | Which research identity this interval belongs to |
| `granted_at` | `ISO datetime` | Start of an active-consent interval |
| `revoked_at` | `ISO datetime \| null` | End of interval. `null` means still active. |

**Scoping decision, not in the original spec:** only the three **strict**
routes write here — `POST /api/consent/accept`, `POST /api/consent/revoke`,
`POST /api/consent/admin/reactivate/<patient_id>`. The **legacy**
`/api/patient/consent` grant/revoke routes are intentionally *not* wired in.
They're kept only for backward compatibility with the inline export card,
and they build their pseudonym via the soft `gpas.get_or_create()` rather
than the strict idempotent `gpas.get_or_create_pseudonym()` the interval
logic assumes — wiring them in would risk tracking intervals against a
pseudonym that route doesn't guarantee consistently. If the legacy routes
turn out to still be in active use, revisit this.

### 2.3 `patient_vitals` — ⚠️ Spec corrected: does not exist, and won't

This collection, as originally specified (one document per reading, keyed
on `uuid`), **does not exist and shouldn't be built** — the real vitals
schema, already shipped and unrelated to this effort, is materially
different. See `backend/utils/vitals_storage.py`:

Vitals are split across **five per-type collections**, all keyed on the real
`patient_id` (not a separate app UUID), linked by a shared `reading_id` for
readings recorded together in one request:

| Collection | LOINC | Written by |
|---|---|---|
| `vitals_blood_pressure` | `55284-4` (systolic+diastolic panel) | `fan_out_reading()` |
| `vitals_heart_rate` | `8867-4` | `fan_out_reading()` |
| `vitals_weight` | `29463-7` | `fan_out_reading()` |
| `vitals_steps` | `41950-7` | Health Connect only, via `fhir_health_connect.py` |
| `vitals_blood_sugar` | `15074-8` | Reserved — no writer yet, per `vitals_storage.py`'s own docstring |

`utils.vitals_storage.ALL_VITALS_COLLECTIONS` is the authoritative list.
**Any future sync job (§4) must iterate this tuple, not a single
collection** — this is the biggest structural change Phase 2 needs to make
versus the original proposal below.

### 2.4 `research_vitals` — ✅ Implemented and wired (2026-08-11, later pass)

The single-vs-five-collections question §2.4 previously flagged as
undecided **is now resolved by the code**: `utils/research_mirror.py`
implements option (b) — one generic `research_vitals` collection, not five
parallel `research_vitals_*` collections. Each document keeps the source
`vitals_*` collection name as a plain string field rather than being split
across collections, so a researcher-facing read is a single `find()` with
an optional `source_collection` filter, not a fan-out across five
collections.

`mirror_patient_vitals(db, patient_id, research_pseudonym)`:
- Reads `consent_history` intervals for `research_pseudonym` via
  `get_consent_intervals()` (§3) and, for each of the five collections in
  `utils.vitals_storage.ALL_VITALS_COLLECTIONS`, keeps only readings whose
  `effectiveDateTime` falls inside an open `[granted_at, revoked_at)`
  window — the same interval-coverage check §3/§4 already specified.
- **Fails closed on timestamps:** a reading with a missing or unparseable
  `effectiveDateTime` is never mirrored, rather than guessed at.
- **De-identifies** each document before writing it — strips `patient_id`,
  `subject`, `performer`, `recorded_by`, and `note` — and stamps
  `research_pseudonym`, `source_collection`, `source_observation_id`
  (`doc["id"]` or the stringified `_id`), and `mirrored_at`.
- **Idempotent by upsert**, not by a `synced_to_research` flag on the
  source documents (⚠️ a correction from the §4 pseudocode below — see §4
  for why). The dedup key is
  `(research_pseudonym, source_collection, source_observation_id)`, backed
  by the unique index `idx_research_vitals_dedup` (added to
  `main.py::_ensure_mongo_indexes` in this same pass). A second index,
  `idx_research_vitals_pseudonym_time`, supports the researcher-facing read
  pattern (`research_pseudonym` + `effectiveDateTime`, descending).
- Returns `{"considered", "mirrored", "skipped_existing"}` counts; no-ops
  (all zeros) if `research_pseudonym` is falsy or has no `consent_history`
  yet.

**Now wired (2026-08-11, later pass).** An earlier pass of this file said
nothing calls `mirror_patient_vitals()` and that the missing piece was a
loop over eligible patients. That loop is now in
`research_routes.py::sync_research_consent_status()`, in the same
per-patient pass as the `research_eligible` refresh — not a separate sweep.
For each patient found `research_eligible` this pass, the sync resolves
`research_pseudonym` from `patient_consents.pseudonym`, writes it to
`patient_identifiers`, and calls `mirror_patient_vitals()`. It runs on every
sync for every currently-eligible patient (not just newly-eligible ones),
consistent with this file's own "no `synced_to_research` flag" design below
— re-scanning is cheap at per-patient scale and self-healing if a reading's
coverage becomes true only on a later run. If an eligible patient has no
`patient_consents.pseudonym` yet, the sync logs a warning and skips
mirroring for them that pass rather than failing the whole sync — this edge
case isn't yet surfaced in the sync response's stats, only in the server
log (worth a follow-up: a `no_pseudonym_count` alongside `error_count`).

Real document shape (supersedes the single-collection proposal originally
sketched here, which predates the actual field names below):

| Field | Type | Description |
|---|---|---|
| `research_pseudonym` | `string` | gPAS pseudonym. The only identifying-ish field — resolves back to a person only via gPAS. |
| `source_collection` | `string` | Which of the five `vitals_*` collections this reading came from (e.g. `"vitals_heart_rate"`) |
| `source_observation_id` | `string` | The source document's own `id` field, or its stringified `_id` if `id` is absent — half of the dedup key |
| `mirrored_at` | `ISO datetime` | When this mirror pass wrote the document (not the reading time) |
| *(all other source fields)* | — | Copied through as-is, minus the stripped identifying fields (`patient_id`, `subject`, `performer`, `recorded_by`, `note`) — includes the reading's own `effectiveDateTime` and value fields exactly as `vitals_storage.py` stores them |

### 2.5 `erasure_requests` — ⚠️ Admin approval side implemented, patient-facing creation still deferred (2026-08-11, later pass)

Collection, indexes, and the schema below are now real — no longer just a
proposal. What's built vs. not, precisely:

| Piece | Status | Where |
|---|---|---|
| Collection + indexes | ✅ Implemented | `main.py::_ensure_mongo_indexes` (`idx_erasure_requests_status_requested`, `idx_erasure_requests_patient`) |
| Admin approval queue | ✅ Implemented | `backend/routes/admin_routes.py::list_erasure_requests()` — `GET /api/admin/erasure-requests` |
| Admin approve/deny action | ✅ Implemented | `backend/routes/admin_routes.py::action_erasure_request()` — `POST /api/admin/erasure-requests/<request_id>`, body `{"action": "approve"\|"deny"}` |
| Patient-facing request creation | 🚧 Deferred, explicitly held for later | — `POST /api/patient/erasure-request` still doesn't exist |

Practical consequence: `GET /api/admin/erasure-requests` is real code
sitting in front of an empty collection today — it will correctly return
`{"requests": []}` until the creation endpoint exists, not because
anything is broken, but because nothing can create a request yet.

| Field | Type | Description |
|---|---|---|
| `patient_id` | `string` | Which patient requested erasure (corrected from `uuid` — see §2.1) |
| `research_pseudonym` | `string` | Which pseudonym's `research_vitals` rows are targeted |
| `requested_at` | `ISO datetime` | When the patient made the request |
| `status` | `string` | `"pending"` \| `"approved"` \| `"denied"` |
| `reviewed_by` | `string \| null` | Admin identifier once actioned |
| `reviewed_at` | `ISO datetime \| null` | When the admin actioned it |
| `reason` | `string \| null` | Added 2026-08-11 — optional note from the reviewing admin, especially useful on denial |

A request only deletes `research_vitals` rows once `status` transitions to
`"approved"` — implemented as a synchronous `delete_many({research_pseudonym})`
in `action_erasure_request()`, no soft-delete or undo. `GET
/api/admin/erasure-requests` includes a live-computed `affected_row_count`
per request (a `research_vitals.count_documents()` alongside the list
query) so an admin sees the blast radius before approving, not after.
While `"pending"`, the data is untouched and still visible to researchers.

**Auth, and why it differs from `admin_reactivate_consent()`:** both admin
routes in this file require `user_type == "admin"` specifically — not
doctor-or-admin, unlike `consent_routes.py::admin_reactivate_consent()`.
That endpoint issues a new pseudonym (reversible, non-destructive); erasure
approval permanently deletes `research_vitals` rows already possibly in
active research use. Different blast radius, different gate. See
`admin-routes-plan.md` §4.1 for the full reasoning.

---

### 2.6 `sync_issues` — ✅ Implemented (2026-08-11, later pass)

Not part of the original proposal — added this pass to close the gap §2.4
flagged: when the sync job found a research-eligible patient with no
`patient_consents.pseudonym` yet, it logged a warning and moved on, with
nothing persisted and nothing visible outside a server log. Per explicit
direction, this collection was scoped to also cover a second, related
problem: a patient whose gICS query keeps failing (unreachable, a SOAP
fault, an unparseable response) across multiple sync runs — previously
visible only in one run's `errors[]`, indistinguishable from a one-off
blip.

One **open document per `(patient_id, issue_type)`** — upserted, not
appended, since this tracks current standing state, not a history of
individually-meaningful events (contrast `consent_history`, §2.2/§3, which
is append-only by design). Two `issue_type` values exist today:

| `issue_type` | Meaning | Flagged from | Resolved from |
|---|---|---|---|
| `"missing_pseudonym"` | Patient is `research_eligible` but `patient_consents.pseudonym` is still empty — mirroring skipped for them this run | The `else` branch of the vitals-mirroring block in `sync_research_consent_status()` | The same block, once a pseudonym is found on a later sync |
| `"gics_query_failure"` | This patient's `get_consent_status_detailed()` call returned `ok=False` | The `if not gics_result["ok"]:` branch | Immediately after a subsequent query for the same patient succeeds |

| Field | Type | Description |
|---|---|---|
| `patient_id` | `string` | Which patient |
| `issue_type` | `string` | Not an enum — kept as a plain string so a future issue type doesn't require a schema migration |
| `detected_at` | `ISO datetime` | First time this *episode* was flagged — reset when a resolved issue re-opens, not a running total since the dawn of time |
| `last_seen_at` | `ISO datetime` | Most recent sync that still saw it |
| `resolved_at` | `ISO datetime \| null` | Set the moment a later sync no longer finds the condition. `null` = still open |
| `occurrence_count` | `int` | Increments every time an already-open issue is re-flagged. This is what makes a *repeated* `gics_query_failure` visible as a number, rather than something the reader has to infer by comparing `detected_at` to `last_seen_at` |
| `context` | `object` | Free-form detail — e.g. `{"research_eligible_since": "..."}` for a missing-pseudonym issue, `{"error": "..."}` for a query failure |

**Concurrency note:** `flag_sync_issue()`/`resolve_sync_issue()`
(`utils/consent_history.py`) do a read-then-write, not a single atomic
update. Acceptable given how this is called today — from the
researcher-triggered, one-at-a-time sync job (§7.3), not a concurrent hot
path — but worth knowing if this collection is ever written from anywhere
else.

**Indexes** (`main.py::_ensure_mongo_indexes`): `idx_sync_issues_patient_type`
(unique, on `patient_id` + `issue_type`) and `idx_sync_issues_resolved`
(sparse, on `resolved_at`) supporting the default "open issues only"
filter.

**Read via** `GET /api/admin/sync-issues` (`backend/routes/admin_routes.py`)
— admin-only, query params `issue_type` and `include_resolved`. This route
never writes to the collection; all writes happen from the sync job, so
there's exactly one place that decides when an issue opens or closes.

**Lifecycle:** cleaned up on account deletion, same as `patient_identifiers`
(§2.1) — `auth_routes.py::delete_account()` now deletes `sync_issues` rows
for the departing patient so they don't sit open forever, referencing an
account that no longer exists (nothing would ever call `resolve_sync_issue()`
for them again, since the sync loop only iterates patients still returned
by `db.users.find({"user_type": "patient"})`).

For the full route contracts (request/response shapes, error cases) for
both `GET /api/admin/sync-issues` and the `erasure_requests` admin routes
in §2.5, see `admin-routes-plan.md` §4.2 and the docstrings in
`backend/routes/admin_routes.py` directly — not duplicated here to avoid
two places drifting apart the way §2.1's `research_pseudonym` status
already did once this pass.

---

## 3. Consent history semantics — ✅ Implemented

A patient can grant, revoke, and re-grant consent any number of times. Each
action appends one row to `consent_history` rather than overwriting a single
pair of fields:

```
pseudonym   granted_at            revoked_at
ABCD-1234   2026-01-10T09:00Z     2026-02-15T14:00Z
ABCD-1234   2026-03-01T10:30Z     2026-05-20T08:00Z
ABCD-1234   2026-07-02T11:00Z     null
```

Because gPAS's `get_or_create_pseudonym` is idempotent (per
`consent-gics-gpas-reference.md` §6.2), a **patient-initiated** re-grant
(`POST /api/consent/accept` after a revoke) always returns the same
pseudonym — so this is one research identity with multiple active intervals,
not multiple identities. Confirmed in code: `accept_consent()` calls
`open_consent_interval(db, pseudonym)` right after the pseudonym is
obtained, and that function is itself idempotent (no-ops if an interval is
already open), so retrying an already-ACCEPTED accept never creates a
duplicate row.

**Exception — admin/facility reactivation (§8.5 of the consent reference):**
that endpoint issues a genuinely new pseudonym. `admin_reactivate_consent()`
reads the OLD pseudonym before it's deleted from gPAS, closes its interval,
then opens a fresh `consent_history` row under the new pseudonym — matching
the original design exactly. This whole block is skipped when
`GPAS_ENABLED=false`, since in that case the gPAS delete/create branch never
ran and the old pseudonym (if any, left over from an earlier gPAS-enabled
session) genuinely wasn't touched — closing its interval in that case would
record an event that didn't happen. 🚧 `research_vitals` rows staying
attributed to the old pseudonym (rather than migrating) is still aspirational
— there's no `research_vitals` yet for anything to stay attributed *in*.

A reading at time `T` is considered "collected under active consent" if any
row for that pseudonym satisfies:

```
granted_at <= T  AND  (revoked_at IS NULL OR revoked_at > T)
```

⚠️ This coverage check is implemented and correct against real data — the
`consent_history` rows exist and are accurate — and now has a real reader:
`research_mirror._reading_in_any_interval()` implements exactly this check
(walking `get_consent_intervals()`'s output in Python, not as a Mongo
query — see §6 for how this differs from the originally-sketched query).
**It's now load-bearing end to end (2026-08-11, later pass)** —
`mirror_patient_vitals()` is called from `sync_research_consent_status()`
on every sync run for every currently-eligible patient, so this check
genuinely gates what lands in `research_vitals` each time a sync runs, not
just when the function happens to be invoked by hand.

---

## 4. Sync job algorithm — ✅ Implemented as one loop (corrected 2026-08-11, later pass)

**Earlier passes of this file got the shape wrong twice, in opposite
directions — worth recording both corrections since either one misleads a
reader who only skims the section header.**

The *original* proposal (and §7.3) described a single sync job doing both
halves in one run — mirror eligible vitals into `research_vitals`, *and*
refresh `research_eligible` — in the same sweep. An *earlier implementation
pass* of this file said that's not what got built, and split this section
into "two independently-runnable pieces, only one of which has a route
calling it" — eligibility refresh wired, vitals mirroring written but
orphaned.

**That earlier-pass correction is itself now wrong.** Re-checked directly
against the current `research_routes.py`: the original single-sweep design
is exactly what's running today. `sync_research_consent_status()`'s
per-patient loop does both, back to back, for every patient on every sync:

| Piece | Logic | Caller |
|---|---|---|
| Eligibility refresh | ✅ `sync_research_consent_status()` | ✅ `POST /api/research/sync` |
| Vitals mirroring | ✅ `research_mirror.mirror_patient_vitals()` | ✅ same request, same per-patient loop as eligibility refresh — not a second pass |

**Trigger model decided (2026-08-11): researcher-triggered, on-demand —
not a background schedule.** No scheduler infrastructure (APScheduler/
Celery/cron) currently exists anywhere in this codebase — that was confirmed
while scoping Phase 1. Rather than stand up scheduler infra to solve a
lag problem, the sync now runs synchronously when a researcher clicks a
"Sync consent status" button in the researcher portal, immediately before
they import a dataset or start a work session. This resolves the runner-shape
decision that Phase 1 scoping deliberately punted — there is no runner to
choose, since it's a plain request-triggered function call, not a scheduled
job. **This is ✅ built, for both halves**: `POST /api/research/sync` runs
`sync_research_consent_status()` synchronously, which refreshes eligibility
*and* mirrors vitals for eligible patients in the same call, and `GET
/api/research/sync/status` reports the combined result. See §7.3 for the
full rationale and lag semantics — they now apply to both halves equally,
since there's only one trigger.

The structural correction the original proposal flagged — **`patient_vitals`
doesn't exist** (§2.3), the real schema is five per-type `vitals_*`
collections — is reflected in the real implementation, but **not the way
the pseudocode below originally proposed**:

- ✅ `mirror_patient_vitals()` does iterate
  `utils.vitals_storage.ALL_VITALS_COLLECTIONS`, per patient, as speced.
- ⚠️ **No `synced_to_research` field was added to the `vitals_*`
  collections**, and none is needed. Instead of marking source documents as
  "already synced" and querying only the unsynced ones, the real
  implementation re-scans every reading for the patient on each call and
  relies on `research_vitals`'s unique dedup index
  (`research_pseudonym`, `source_collection`, `source_observation_id`) to
  make the `update_one(..., upsert=True)` a no-op for readings already
  mirrored. This trades "cheap to query" (a flag) for "no schema change to
  five live collections, and self-healing if a reading's coverage becomes
  true only on a later run" — the same reading that wasn't coverable last
  time is naturally reconsidered next time, with no separate backfill path
  needed. The trade-off: each call re-reads every reading for the patient,
  not just the unsynced ones — fine at per-patient, on-demand scale; worth
  revisiting if this ever runs over the full patient base on a schedule.

```
# ✅ Real shape as implemented, confirmed against research_routes.py and
# utils/research_mirror.py directly (2026-08-11, later pass). One loop,
# one function, per patient — not two separately-triggered pieces.

def mirror_patient_vitals(db, patient_id, research_pseudonym):     # ✅ implemented, utils/research_mirror.py
    if not research_pseudonym: return zero stats                  # ✅ no-op guard
    intervals = get_consent_intervals(db, research_pseudonym)      # ✅ real, from consent_history
    if not intervals: return zero stats                            # ✅ no-op guard
    for collection in ALL_VITALS_COLLECTIONS:                       # ✅ all five, corrected per §2.3
        for reading in db[collection].find({patient_id: patient_id}):
            if reading.effectiveDateTime missing/unparseable:      # ✅ fail-closed, not "skip and hope"
                continue
            if not any interval covers reading.effectiveDateTime:  # ✅ same check as §3/§6
                continue
            deidentified = strip(patient_id, subject, performer, recorded_by, note)
                           + {research_pseudonym, source_collection, source_observation_id, mirrored_at}
            research_vitals.update_one(
                {research_pseudonym, source_collection, source_observation_id},
                {"$setOnInsert": deidentified}, upsert=True)        # ✅ idempotent via unique index, not a flag

# ✅ IMPLEMENTED — research_routes.py::sync_research_consent_status(), one
# loop covering both halves for every patient:
for each patient:
    gics_result = gics.get_consent_status_detailed(patient)          # ✅ added 2026-08-11 — see below
    if not gics_result.ok:                                           # ✅ real gICS failure this patient
        record error, leave research_eligible/gics_consent_status unchanged, continue
    research_eligible = (normalize(gics_result.status) == "ACCEPTED")
    patient_identifiers.update research_eligible, gics_consent_status  # ✅ both fields written — see §2.1

    if research_eligible:                                            # ✅ Phase 2.5, now in the same loop
        research_pseudonym = patient_consents.find_one(patient).pseudonym
        if research_pseudonym:
            patient_identifiers.update research_pseudonym             # ✅ written here — see §2.1
            mirror_patient_vitals(db, patient.patient_id, research_pseudonym)  # ✅ called here
        else:
            log warning — eligible but no patient_consents.pseudonym yet, skip mirroring this pass
```

**UNKNOWN-mapping fix, same pass, folded into the loop above:**
`gics.get_consent_status()` used to be called directly and never raised,
which meant a real gICS failure (unreachable, a non-"not found" SOAP fault,
an unparseable response) and a genuine "no consent record" answer were both
just `"UNKNOWN"` — indistinguishable to the loop's `except Exception`, which
could never catch a gICS-layer failure at all. A transient timeout for one
patient was silently written as `research_eligible: False`, counted as an
ordinary state change. `gics_service.get_consent_status_detailed()` now
returns `{"status", "ok", "error"}`, and the loop above uses it: `ok=False`
goes into `error_count`/`errors[]` with `research_eligible` left untouched;
only a genuine gICS-confirmed `UNKNOWN` (`ok=True`) maps to ineligible, same
as `REJECTED`. See §2.1 for the full account.

The critical property — the job checks **interval coverage at record time**,
not **current flag state** — is unchanged and still correct design, and has
a real implementation (`_reading_in_any_interval()`) to back it. The
`consent_history` data it reads against (✅ implemented, §2.2/§3) is already
accurate, and — as of this pass — is actually being read on every sync, not
just correctly-implemented-but-idle.

---

## 5. Edge cases and decisions

### 5.1 Revoke → record → reactivate — ✅ design implemented, coded, and load-bearing (2026-08-11, later pass)

If the sync job only checked "is `research_eligible` true right now," a
reading recorded during a revoked window would still sync once the patient
later reactivates — because by the time the job runs, the flag is true
again with no memory of when it wasn't. The interval-coverage check in §4
closes this: a reading recorded outside every `[granted_at, revoked_at)`
window never syncs, regardless of later state changes.
`research_mirror._reading_in_any_interval()` now implements exactly this
check. The `consent_history` data it depends on is real and accurate today
(§3) — revoking now genuinely closes an interval, reactivating genuinely
opens a new one — so this protection is live: `mirror_patient_vitals()` is
called from `sync_research_consent_status()` on every sync run (§4), so
this check runs and gates every mirror write, not just when invoked by
hand.

### 5.2 Revoke does not delete existing `research_vitals` rows — ✅ true by construction, now observable (2026-08-11, later pass)

Matches the existing strict-revoke design (`consent_routes.py` §8.4, unchanged
by this pass), which deliberately leaves the pseudonym untouched. Revoke is
prospective — it stops future syncing, not a retroactive deletion of
already-shared data. `mirror_patient_vitals()` only ever inserts
(`$setOnInsert`, never `$set` or `delete`), so this holds by construction —
there's no code path in `research_mirror.py` that would remove a row on
revoke. Now confirmable end to end, not just in theory: `research_vitals`
gets written to on every sync run for eligible patients (§2.4/§4), so this
claim can actually be checked against real data. Deletion of
previously-synced rows remains a distinct, heavier action (§5.3).

### 5.3 Right-to-erasure is a separate action — ⚠️ Admin half implemented, patient half deferred (2026-08-11, later pass)

If a patient wants previously-shared research data actually deleted (not
just future collection stopped), that should be its own explicit endpoint —
plausibly admin/Treuhandstelle-mediated given the weight of the action —
rather than something a consent-revoke toggle triggers as a side effect.
`POST /api/consent/revoke` today (✅ implemented, unchanged by this pass)
still does exactly the prospective-only revoke this section describes — it
has no destructive counterpart triggered automatically, by design. The
destructive counterpart itself is now half-built: the admin-mediated
approval step this paragraph called for is real
(`backend/routes/admin_routes.py`, §2.5), gated to admin specifically, not
doctor-or-admin, given the weight of the action this section is describing.
What's still missing is the *patient's* half — the request that starts the
process — see §2.5 and §7.2.

### 5.4 Sync lag — ✅ Real for both `research_eligible` and the vitals mirror (2026-08-11, later pass)

With the researcher-triggered model (§7.3), `research_eligible` and
`gics_consent_status` lag live gICS status by however long it's been since
that researcher last called `POST /api/research/sync` (today: manually,
since the portal button doesn't exist yet, §7.3) — there's no fixed worst
case the way a scheduled interval would give. In exchange, a researcher can
always get current state on demand right before it matters, instead of
waiting out a fixed window. **This is real, not hypothetical** —
`research_eligible` and `gics_consent_status` are written by
`sync_research_consent_status()` (§2.1, §4), so this lag is something a
researcher can actually experience today if they don't re-sync. The vitals
mirror is no longer moot either: since `mirror_patient_vitals()` runs in
the same call, on the same trigger, `research_vitals` lags live vitals data
by exactly the same amount as `research_eligible` lags gICS — one sync,
one lag window, not two.

---

## 6. Example queries

**Find whether a reading is currently coverable (used by the sync job):**
✅ The underlying check is correct and now genuinely in use — but not as
this literal Mongo query. `research_mirror._reading_in_any_interval()`
(2026-08-11, later pass) implements the same logic in Python over
`get_consent_intervals()`'s output rather than as a `findOne()` per reading
— see §3/§4. The query below is still valid and equivalent, just not what
actually executes; keeping it here as the clearest statement of the
coverage rule itself.

```javascript
db.consent_history.findOne({
  pseudonym: patient.research_pseudonym,
  granted_at: { $lte: reading.recorded_at },
  $or: [
    { revoked_at: null },
    { revoked_at: { $gt: reading.recorded_at } }
  ]
});
```

**Researcher-facing read:** 🚧 Still deferred, but for a different reason
than before. `research_vitals` **does now exist and gets populated** by
every sync run (§2.4) — the mirror-shape question this note used to flag as
undecided is resolved (§2.4: one `research_vitals` collection with a
`source_collection` field, not five parallel `research_vitals_<type>`
collections). What's actually still missing is a **route**: no
researcher-facing read endpoint is built yet — confirmed against
`research_routes.py`'s own placeholder comment block, which still only
lists `GET /api/research/data/patients` and `POST /api/research/data/export`
as future work. The query below is correct for the collection shape as
built; it just has nothing serving it yet.

```javascript
db.research_vitals.find({ research_pseudonym: { $in: eligiblePseudonyms } });
```

---

## 7. Resolved decisions

### 7.1 Doctor access gating — ✅ Implemented

The doctor read endpoint requires **both** gates, ANDed together — the
existing `check_doctor_patient_access()` check *and* the new
`doctor_sharing` flag. The flag does not replace the existing check; it
adds a second, patient-controlled condition on top of it. This is exactly
how `check_doctor_patient_access()` in `doctor_routes.py` now reads.

This matches how the toggle already behaves in practice: the doctor a
patient has chosen can read their data while `doctor_sharing` is on, and
loses access the moment the patient turns it off. `doctor_sharing` is a
strict AND with whatever access `check_doctor_patient_access()` already
grants — it can only remove access, never grant access that check would
otherwise deny. The `admin` branch is unchanged and bypasses this gate the
same way it already bypassed `authorized_doctors`.

```
doctor_can_read(doctor, patient) =
    check_doctor_patient_access(doctor, patient)
    AND patient_identifiers[patient].doctor_sharing == true
```

**Gap closed 2026-08-11.** `patient_routes.py`'s `fhir_patient_read()` /
`fhir_patient_search()` used to reimplement their own `authorized_doctors`
check inline with no `doctor_sharing` gate at all — a patient turning
`doctor_sharing` off stopped a doctor's vitals/consent reads but not their
FHIR Patient reads. Fixed, but not by routing through
`check_doctor_patient_access()` directly — each endpoint got its own
duplicate gate instead, chosen deliberately over routing through the shared
function:
- `fhir_patient_read()` — single-patient lookup, so one extra
  `get_doctor_sharing()` call after the existing `authorized_doctors` check
  was cheap and kept the endpoint's existing FHIR `OperationOutcome` 404
  shape intact (`check_doctor_patient_access()` returns a plain-JSON 404,
  which would have silently changed the response shape for a case that
  isn't actually about the doctor-sharing gate).
- `fhir_patient_search()` — a result-set endpoint, so the gate is a
  batch-fetched exclusion filter (only patients with an *explicit*
  `doctor_sharing: false` are dropped; missing docs or unset fields default
  to shared, matching `get_doctor_sharing()`'s own default) rather than an
  N+1 loop calling `get_doctor_sharing()` per candidate.

Both endpoints' doctor branch now genuinely implements
`doctor_can_read(doctor, patient)` above; only the admin branch still
bypasses it, matching `check_doctor_patient_access()`'s own admin branch.

**Default value, also a real decision:** patients who've never touched the
toggle default to `doctor_sharing = true` (see §2.1) — chosen to avoid this
shipping as a silent access cutoff for the existing patient base.

### 7.2 Erasure endpoint — ⚠️ Step 2 implemented, step 1 deferred (2026-08-11, later pass)

Two-step, not a single patient action:

1. **Patient-initiated request.** 🚧 Still not built. The patient can
   request erasure of previously-synced `research_vitals` data at any time
   (distinct from a plain consent revoke, per §5.3). This creates a
   pending erasure request — it does not delete anything by itself.
   `POST /api/patient/erasure-request` doesn't exist yet; explicitly held
   for later.
2. **Admin approval required.** ✅ Implemented. Because the data may
   already be in active use in research, an admin must review and approve
   the request before the corresponding `research_vitals` rows are
   deleted. Revoke-only (§5.2) needs no approval since it's prospective
   and non-destructive; erasure is destructive and retroactive, so it gets
   a human check before it executes. `GET /api/admin/erasure-requests` +
   `POST /api/admin/erasure-requests/<request_id>`
   (`backend/routes/admin_routes.py`) do exactly this — approve triggers a
   synchronous `research_vitals.delete_many({research_pseudonym})`, deny
   touches no data. Admin-only auth, not doctor-or-admin (§2.5).

Until approved, the request sits in a pending state and the data remains
in `research_vitals` untouched — true by construction (approve is the only
code path that deletes). The `erasure_requests` collection and its indexes
now exist (§2.5); the admin approval endpoint now exists; what's still
missing is purely step 1 — the patient-facing request endpoint. Until it's
built, the admin queue has nothing to show.

### 7.3 Sync trigger model — ✅ Implemented for both halves (2026-08-11, later pass)

**Superseded the original "hourly, on the hour" proposal.** The sync (§4)
is researcher-triggered, not scheduled — and that trigger is now real code,
not just a design decision: `POST /api/research/sync` runs
`sync_research_consent_status()` synchronously; `GET /api/research/sync/status`
reports the outcome. The researcher-portal button described below (which
would call these endpoints) is still **not yet built** — see the "Not yet
designed" note at the end of this section, which still applies.

Clicking it (once the button exists) runs the sweep in §4 — and, as of this
pass, that sweep genuinely covers both halves: `research_eligible` /
`gics_consent_status` refresh, and vitals mirroring into `research_vitals`
for every currently-eligible patient, in the same per-patient loop. An
earlier pass of this section said the sweep only covered the eligibility
half and that "the full sweep" description below was aspirational — that's
no longer true; `sync_research_consent_status()` now does exactly what's
described below.

Why this over a fixed interval:
- No scheduler infrastructure to build or operate (§4 already notes none
  exists in this codebase today) — the sync is a plain request-triggered
  function, not a cron/APScheduler job. This resolves the runner-shape
  question Phase 1 scoping punted, by making it moot.
- Freshness is guaranteed exactly when it matters — right before a
  researcher reads data — rather than bounded by a worst-case window that's
  either too loose (stale data mid-window) or too tight (unnecessary load
  from a short interval nobody needs between imports).
- No silent staleness: a researcher who never clicks sync simply never gets
  a refresh, which is visible and correctable in the UI (e.g. a "last synced
  at …" timestamp), versus a background job's lag being invisible until
  someone asks why revoked data was still returned.

Trade-off, worth stating plainly: this shifts responsibility for freshness
onto the researcher's own workflow discipline — if they skip the sync
button, they can pull stale eligibility state (and stale `research_vitals`,
now that mirroring shares the same trigger) with no automatic backstop.
If that turns out to be a problem in practice (see §5.4), the two most
likely mitigations are (a) forcing a sync as part of the import action
itself rather than a separate optional button, or (b) adding a lightweight
periodic sync back in as a safety net underneath the on-demand one — not
a replacement for it. Not building either preemptively; revisit only if the
on-demand-only model proves insufficient once researchers actually use it.

**Not yet designed:** the researcher-portal UI/UX for this button (where it
lives, what "last synced" feedback it shows, whether it blocks the import
action until sync completes or runs it implicitly) — flagged for later
implementation, not decided here. Still accurate as of this pass — nothing
in the codebase calls either endpoint from a UI yet.

---

## 8. Implementation status summary (updated 2026-08-11, admin-routes pass)

| Item | Status | Where |
|---|---|---|
| `patient_identifiers` collection | ✅ Implemented (⚠️ `patient_id` not `uuid`) — now cleaned up on account deletion too (§2.1) | `utils/consent_history.py`, index in `main.py`, cleanup in `auth_routes.py::delete_account()` |
| `patient_identifiers.doctor_sharing` | ✅ Implemented | `utils/consent_history.py` |
| `patient_identifiers.gics_consent_status` | ✅ Implemented | `research_routes.py::sync_research_consent_status()` |
| `patient_identifiers.research_eligible` | ✅ Implemented | `research_routes.py::sync_research_consent_status()` |
| `patient_identifiers.research_pseudonym` | ✅ Implemented (2026-08-11 — resolved from `patient_consents.pseudonym`) | `research_routes.py::sync_research_consent_status()` |
| `consent_history` collection | ✅ Implemented | `utils/consent_history.py`, index in `main.py` |
| `consent_history` writes on strict accept | ✅ Implemented | `consent_routes.py::accept_consent()` |
| `consent_history` writes on strict revoke | ✅ Implemented | `consent_routes.py::revoke_consent_strict()` |
| `consent_history` writes on admin reactivation | ✅ Implemented | `consent_routes.py::admin_reactivate_consent()` |
| `consent_history` writes on legacy grant/revoke | ❌ Not wired (deliberate scope decision, §2.2) | — |
| Doctor-sharing AND-gate | ✅ Implemented, incl. FHIR endpoints (closed 2026-08-11, §7.1) | `doctor_routes.py::check_doctor_patient_access()`, `patient_routes.py::fhir_patient_read()`/`fhir_patient_search()` |
| `GET`/`POST /api/patient/doctor-sharing` | ✅ Implemented | `patient_routes.py` |
| `patient_vitals` (single collection) | ❌ Spec corrected — real schema is 5 `vitals_*` collections | `utils/vitals_storage.py` (pre-existing) |
| `research_vitals` mirror | ✅ Implemented and wired | `utils/research_mirror.py::mirror_patient_vitals()` |
| gICS `UNKNOWN` failure vs. genuine-no-record distinction | ✅ Implemented (closes the open question in §2.1) | `gics_service.py::get_consent_status_detailed()`, used by `sync_research_consent_status()` |
| Sync job — eligibility half (`gics_consent_status` / `research_eligible` refresh) | ✅ Implemented, on-demand trigger built: `POST /api/research/sync`, `GET /api/research/sync/status` (§4, §7.3) | `research_routes.py::sync_research_consent_status()` |
| Sync job — vitals-mirroring half | ✅ Implemented, same request and same per-patient loop as the eligibility half above | `research_routes.py::sync_research_consent_status()` → `research_mirror.mirror_patient_vitals()` |
| `sync_issues` collection (`missing_pseudonym` + `gics_query_failure` tracking) | ✅ Implemented (2026-08-11, this pass — new, §2.6) | `utils/consent_history.py::flag_sync_issue()`/`resolve_sync_issue()`, indexes in `main.py` |
| `GET /api/admin/sync-issues` | ✅ Implemented (2026-08-11, this pass) | `backend/routes/admin_routes.py` |
| Researcher-portal "Sync consent status" button (UI) | 🚧 Not yet designed (§7.3) — backend endpoints above exist, no client calls them yet | — |
| `erasure_requests` collection + indexes | ✅ Implemented (2026-08-11, this pass, §2.5) | `main.py::_ensure_mongo_indexes` |
| `erasure_requests` — admin approval queue + approve/deny action | ✅ Implemented (2026-08-11, this pass, §2.5/§7.2) | `backend/routes/admin_routes.py` |
| `erasure_requests` — patient-facing request creation | 🚧 Deferred, explicitly held for later (§2.5/§7.2) | — |
| Admin routes auth (admin-only, not doctor-or-admin) | ✅ Implemented (2026-08-11, this pass, §2.5) | `backend/routes/admin_routes.py::_check_admin_auth()` |
| `auth_routes.py` `VALID_USER_TYPES` missing `"researcher"` | ✅ Fixed (2026-08-11, this pass) — was blocking all researcher login/registration; not a data-store-separation item per se, noted because it's what makes this file's research-sync feature reachable at all | `auth_routes.py` (now imports from `utils/auth.py`) |
| Dev admin account seed (`admin`/`1234`) | ⚠️ Added 2026-08-11, this pass — explicitly temporary/insecure, not a real provisioning flow; `/register` still allows public admin self-registration too | `main.py::_ensure_dev_admin_account()` |

Legend: ✅ implemented and verified against code · 🚧 deferred, spec unchanged
· ❌ spec corrected or deliberately not built as originally proposed
· ⚠️ implemented but with a caveat worth reading before relying on it.
