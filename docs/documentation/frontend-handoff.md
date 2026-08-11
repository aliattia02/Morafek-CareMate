# Frontend Handoff — Researcher & Admin Surfaces

> Written 2026-08-11 for starting frontend work on the researcher-sync and
> admin (sync-issues, erasure-approval) features in a **new chat with no
> prior context**. Paste or upload this file first. Everything below is
> backend-verified against real code from this session — not guessed.

---

## 0. What exists on the backend, in one paragraph

Two blueprints have no frontend at all yet: `research_routes.py`
(researcher-triggered consent/vitals sync) and the brand-new
`admin_routes.py` (standing sync-problem visibility + erasure-request
approval). Both are fully implemented and reachable — including the auth
bug that made researcher login impossible, which is now fixed. This
document gives you the exact request/response contracts so you don't need
the backend files to start building screens.

---

## 1. Auth — what a new screen needs to know

- Login: `POST /login` — body `{"username", "password", "user_type"}`.
  `user_type` must be one of `patient`, `doctor`, `researcher`, `admin`
  (as of this pass — previously `researcher` was silently rejected by a
  stale validation list; fixed).
- Response includes a JWT `token`; every other endpoint below requires
  `Authorization: Bearer <token>`.
- Mobile clients should send `X-Client-Type: mobile` for a 90-day token
  instead of 24-hour (see `utils/auth.py::generate_token()`).
- **Dev admin account, temporary:** username `admin`, password `1234`,
  seeded automatically on backend startup
  (`main.py::_ensure_dev_admin_account()`). Explicitly insecure/dev-only —
  don't build any assumption into the UI that this is how real admins get
  provisioned; there's no invite/promotion flow yet.
- **No researcher account exists by default.** Register one via
  `POST /register` with `user_type: "researcher"` (now works), or note
  that a researcher-registration UI doesn't exist yet either — you may
  need to build one, or just seed a test account for development the same
  way the admin one is seeded.
- Existing `login.tsx`/`register.tsx` (`mobile/app/(auth)/`) may or may not
  already offer `researcher`/`admin` as `user_type` choices — **upload
  those two files to the new chat** to check before assuming.

---

## 2. Endpoint contracts

All responses are JSON. All routes below require the `Authorization`
header. None of this is guessed — every shape here is copied from the
actual route implementations.

### 2.1 Researcher sync

**`POST /api/research/sync`** — role: `researcher`
Triggers the consent-eligibility refresh + vitals mirror in one call.
No request body.

```json
// 200
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
  "errors": [ { "patient_id": "...", "gics_error": "..." } ],
  "duration_seconds": 3.42
}
// 502 — gICS completely unreachable, nothing was processed:
{ "error": "gICS service unreachable", "reason": "..." }
// 403 — not a researcher:
{ "message": "Researcher access only" }
```
UI implication: this is a synchronous, potentially multi-second call
(scales with patient count) — show a spinner/progress state, not a
fire-and-forget button. `error_count > 0` with `200` still means partial
success — surface `errors[]` but don't treat it as a failed sync.

**`GET /api/research/sync/status`** — role: `researcher`
No params. Use this to show "last synced X minutes ago" without
triggering a new sync.

```json
// 200 — no sync has ever run:
{
  "last_synced_at": null, "synced_by": null, "total_patients": null,
  "newly_eligible": null, "newly_ineligible": null, "error_count": null,
  "vitals_mirrored": null, "vitals_considered": null,
  "no_pseudonym_count": null, "stale_minutes": null
}
// 200 — a sync has run:
{
  "last_synced_at": "2026-08-11T12:00:00+00:00",
  "synced_by": "...", "total_patients": 42,
  "newly_eligible": 2, "newly_ineligible": 1, "error_count": 1,
  "vitals_mirrored": 120, "vitals_considered": 340,
  "no_pseudonym_count": 1, "stale_minutes": 14.3
}
```
UI implication: `stale_minutes` is exactly what you want for a "last
synced" badge/timestamp display.

**Not built yet — don't wire these up:** `GET /api/research/data/patients`
and `POST /api/research/data/export` are still just placeholder comments
in `research_routes.py`. If the researcher surface needs to actually list
or export `research_vitals` data, that's a separate backend task first.

### 2.2 Admin — sync issues

**`GET /api/admin/sync-issues`** — role: `admin`
Query params (both optional): `issue_type` (`"missing_pseudonym"` |
`"gics_query_failure"`), `include_resolved` (`"true"`/`"false"`, default
`false`).

```json
// 200
{
  "issues": [
    {
      "patient_id": "...",
      "issue_type": "missing_pseudonym",
      "detected_at": "2026-08-10T09:00:00+00:00",
      "last_seen_at": "2026-08-11T12:00:00+00:00",
      "resolved_at": null,
      "occurrence_count": 4,
      "context": { "research_eligible_since": "2026-08-10T09:00:00+00:00" }
    }
  ],
  "open_count": 1
}
```
UI implication: `occurrence_count` is the "how many syncs in a row has
this been broken" signal — worth surfacing prominently (e.g. a badge) for
`gics_query_failure` issues especially, since a count of 1 is a shrug and
a count of 8 is an admin action item. No mutation endpoint exists (no
manual dismiss/acknowledge) — issues only clear themselves when the sync
job stops seeing the condition. If you want a manual "acknowledge" action
in the UI, that's a new backend route, not built.

### 2.3 Admin — erasure requests

**`GET /api/admin/erasure-requests`** — role: `admin`
Query param: `status` (`"pending"` default, or `"approved"`, `"denied"`,
`"all"`).

```json
// 200
{
  "requests": [
    {
      "request_id": "664f...",
      "patient_id": "...",
      "research_pseudonym": "...",
      "requested_at": "2026-08-11T10:00:00+00:00",
      "status": "pending",
      "reviewed_by": null,
      "reviewed_at": null,
      "reason": null,
      "affected_row_count": 42
    }
  ]
}
```
**Will return `{"requests": []}` today, always** — the patient-facing
creation endpoint (`POST /api/patient/erasure-request`) doesn't exist yet.
Build the admin list/approve UI anyway if you want (it's real code, not a
stub), but there's currently no way to populate it end-to-end without
inserting a test document by hand.

**`POST /api/admin/erasure-requests/<request_id>`** — role: `admin`
One endpoint, action selected via body — not separate approve/deny routes.

```json
// request body
{ "action": "approve" }              // or "deny"
{ "action": "deny", "reason": "..." } // reason optional either way

// 200 — approve
{ "request_id": "...", "status": "approved", "deleted_count": 42, "reviewed_at": "..." }
// 200 — deny
{ "request_id": "...", "status": "denied", "reason": "...", "reviewed_at": "..." }
// 400 — bad/missing action, or malformed request_id
// 404 — no such request
// 409 — already approved/denied (double-click / stale UI guard)
```
UI implication: **approve is instant, permanent, irreversible deletion**
of `deleted_count` rows — no undo. The list endpoint's
`affected_row_count` is meant to be shown *before* the confirm action, not
just in the response after. Design this like any destructive-action
confirmation (typed confirmation, red button, show the count), not like a
routine status toggle. Handle 409 gracefully — it means another admin (or
a double-tap) already actioned it; refetch the list rather than showing a
generic error.

---

## 3. Existing frontend conventions (from the project tree — verify before building)

I have the directory structure but not file contents for these — **upload
them to the new chat if you want exact conventions followed** rather than
guessed:

- `mobile/services/api/client.ts` — presumably the shared Axios instance /
  base URL / auth-header injection. New API modules (e.g. `research.ts`,
  `admin.ts`) should follow whatever pattern this establishes.
- `mobile/services/api/endpoints.ts` — likely a central URL-constants file;
  check whether new endpoint paths belong there.
- `mobile/services/api/consent.ts` — closest existing analog (also
  patient/consent-domain, also hits `/api/consent/*`) — good template for
  a new `research.ts`/`admin.ts`.
- `mobile/store/auth.store.ts` — holds the logged-in user incl.
  `user_type`; screens should probably gate on `user.user_type ===
  'researcher'` / `'admin'` the same way existing screens gate on
  `'doctor'`/`'patient'`.
- `mobile/hooks/useApi.ts` — likely a shared data-fetching hook; check
  before writing new fetch logic from scratch.
- `mobile/app/(app)/(tabs)/doctor-dashboard.tsx` — closest existing analog
  for "a role-specific dashboard screen," since doctor is the only
  non-patient role with a dedicated screen today.

**No `research.ts` or `admin.ts` exists yet in `services/api/`, and no
researcher/admin screens exist yet under `mobile/app/(app)/`.** You're
building both the API layer and the screens from scratch — there's no
partial implementation to extend.

## 4. Suggested screen structure (a starting point, not a decision)

Given the existing pattern — `(tabs)/doctor-dashboard.tsx` as a
role-specific screen, `settings/` as a nested route group for
secondary/admin-ish screens — a reasonable structure to propose in the new
chat:

```
mobile/app/(app)/
  research/                    (new, mirrors ehr/ or settings/ nesting)
    _layout.tsx
    sync.tsx                   — the "Sync consent status" button + last-sync status
  admin/                       (new)
    _layout.tsx
    sync-issues.tsx            — list from §2.2
    erasure-requests.tsx       — list + approve/deny from §2.3
```

Whether these are tabs, a settings sub-menu, or something else is a UX
call for the new chat to make with you — this is just naming/nesting
consistent with what already exists, not a final decision.

## 5. Files to bring into the new chat

Backend reference (already produced this session, all verified against
real code):
- `data-store-separation-reference.md` — full architecture, all
  collections, all statuses. Section 2.5/2.6/7.2 cover exactly the two
  admin features.
- `admin-routes-plan.md` — the original design doc for `admin_routes.py`,
  useful for the "why" behind each endpoint if the new chat needs it.
- `admin_routes.py`, `research_routes.py` — the actual route
  implementations, if the new chat needs to see real code rather than just
  contracts (e.g. to keep response-shape changes in sync).

Frontend, to check conventions before building (not yet in this
conversation — pull from the repo):
- `mobile/services/api/client.ts`, `endpoints.ts`, `consent.ts`
- `mobile/store/auth.store.ts`
- `mobile/hooks/useApi.ts`
- `mobile/app/(auth)/login.tsx`, `register.tsx` (to check/add
  researcher+admin `user_type` support in the UI)
- `mobile/app/(app)/(tabs)/doctor-dashboard.tsx` (closest structural
  analog for a new role-specific screen)
