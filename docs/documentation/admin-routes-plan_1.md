# Admin Routes — Plan: Sync-Issue Visibility & Data Erasure

> **Status:** Planning only — nothing in this file is built yet. Written
> 2026-08-11 against the current `research_routes.py` (post UNKNOWN-mapping
> fix), `research_mirror.py`, `consent_history.py`, `main.py`, and `auth.py`.
> Extends `data-store-separation-reference.md` §2.4 (no-pseudonym gap),
> §2.5/§5.3/§7.2 (erasure_requests), and the placeholder endpoint list at
> the bottom of `research_routes.py`. Update that file once this ships —
> see §6 below.

---

## 0. Two problems, one admin surface

1. **Missing-pseudonym gap.** When `sync_research_consent_status()` finds a
   patient `research_eligible` but their `patient_consents.pseudonym` is
   still empty, it logs a warning and moves on. Nothing persists — the next
   sync re-discovers the same gap from scratch, and there is no way for an
   admin to see, across all patients, who's stuck in this state.
2. **Data erasure.** `erasure_requests` (data-store-separation-reference.md
   §2.5) is fully speced but unbuilt — no collection, no patient-facing
   request endpoint, no admin approval queue. `research_routes.py` already
   reserves the URL shapes for this as placeholder comments.

Both need an admin-facing list/action surface, so this plan proposes one
new blueprint, `backend/routes/admin_routes.py`, rather than two unrelated
patches.

---

## 1. New collection: `sync_issues`

Purpose: a **persistent, self-healing** record of standing problems the
sync job finds, as opposed to `research_sync_log`'s per-run snapshot
(§4 already logs `errors[]` per run, but that's ephemeral and specific to
one sync's transient gICS failures — this is for conditions that persist
*across* runs until something external changes them).

| Field | Type | Description |
|---|---|---|
| `patient_id` | `string` | Which patient |
| `issue_type` | `string` | e.g. `"missing_pseudonym"` — kept as a string, not an enum, so future issue types don't require a schema migration |
| `detected_at` | `ISO datetime` | First time this issue was seen |
| `last_seen_at` | `ISO datetime` | Most recent sync that still saw it |
| `resolved_at` | `ISO datetime \| null` | Set automatically when a later sync no longer finds the condition — `null` means still open |
| `context` | `object` | Free-form detail, e.g. `{"research_eligible_since": "..."}` |

**Upsert, not append** — one open doc per `(patient_id, issue_type)`, unlike
`consent_history`'s append-only design, because this tracks *current
standing state*, not a history of events. Written via two small helpers in
`utils/consent_history.py` (natural home — it already owns
`patient_identifiers` state helpers), following the existing
no-op-if-nothing-changed pattern used by `open_consent_interval()`:

```python
def flag_sync_issue(db, patient_id, issue_type, context=None):
    # upsert: set last_seen_at, set detected_at only $setOnInsert,
    # clear resolved_at if it was set (re-opened)

def resolve_sync_issue(db, patient_id, issue_type):
    # no-op if no open issue; else $set resolved_at = now
```

**Index (add to `main.py::_ensure_mongo_indexes`):**
```python
mongo.db.sync_issues.create_index(
    [("patient_id", ASCENDING), ("issue_type", ASCENDING)],
    unique=True,
    name="idx_sync_issues_patient_type",
)
mongo.db.sync_issues.create_index(
    [("resolved_at", ASCENDING)],
    name="idx_sync_issues_resolved",
    sparse=True,
)
```

---

## 2. Sync job change (`research_routes.py`)

In the existing `if new_eligible:` block, replace the bare `logger.warning`
on the no-pseudonym branch:

```python
if research_pseudonym:
    db.patient_identifiers.update_one(...)
    mirror_stats = mirror_patient_vitals(db, patient_id, research_pseudonym)
    stats["vitals_mirrored"] += mirror_stats["mirrored"]
    stats["vitals_considered"] += mirror_stats["considered"]
    resolve_sync_issue(db, patient_id, "missing_pseudonym")   # NEW — self-heals
else:
    logger.warning(...)                                       # existing
    flag_sync_issue(db, patient_id, "missing_pseudonym", {     # NEW
        "research_eligible_since": start_timestamp,
    })
    stats["no_pseudonym_count"] += 1                           # NEW
```

Add `"no_pseudonym_count": 0` to the `stats` dict initializer and to the
response/`sync_log` shapes documented in the function's docstring, next to
`error_count`. This is the specific gap flagged in
`data-store-separation-reference.md` §2.4 — now it's visible in the sync
response *and* persisted for later admin lookup, not just logged once and
forgotten.

---

## 3. `erasure_requests` collection (already speced, confirming shape)

No change from `data-store-separation-reference.md` §2.5 — reproduced here
so this plan is self-contained:

| Field | Type | Description |
|---|---|---|
| `patient_id` | `string` | Who requested erasure |
| `research_pseudonym` | `string` | Which pseudonym's `research_vitals` rows are targeted |
| `requested_at` | `ISO datetime` | When requested |
| `status` | `string` | `"pending"` \| `"approved"` \| `"denied"` |
| `reviewed_by` | `string \| null` | Admin/doctor identifier once actioned |
| `reviewed_at` | `ISO datetime \| null` | When actioned |
| `reason` | `string \| null` | Optional note from the reviewer, esp. on denial |

**Indexes:**
```python
mongo.db.erasure_requests.create_index(
    [("status", ASCENDING), ("requested_at", DESCENDING)],
    name="idx_erasure_requests_status_requested",
)
mongo.db.erasure_requests.create_index(
    [("patient_id", ASCENDING)],
    name="idx_erasure_requests_patient",
)
```

**Not part of this plan, but a hard dependency — flagging, not designing
here:** the patient-facing `POST /api/patient/erasure-request` that
*creates* these documents. It belongs in `patient_routes.py` (patient-owned
action, same file as the doctor-sharing toggle) rather than the new admin
blueprint. Minimal shape: look up the caller's `patient_id`, resolve their
`research_pseudonym` from `patient_consents.pseudonym`, refuse if there's
already a `pending` request for them (one at a time), insert with
`status: "pending"`. Say the word and I'll draft this alongside the admin
side — the admin approval routes below are only reachable once requests can
be created.

---

## 4. New blueprint: `backend/routes/admin_routes.py`

Mirrors `research_routes.py`'s structure — `token_required` +
`api_error_handler`, a `_check_admin_auth` helper, one module docstring
with the URL/collection/design-decision summary this codebase's other
route files already use.

### 4.1 Auth — open decision, flagging rather than assuming

`consent_routes.py::admin_reactivate_consent()` allows **doctor or admin**
for a reversible, non-destructive action (issues a new pseudonym). Erasure
approval is destructive and permanent — deleting `research_vitals` rows
already possibly in active research use. I'd default this to **admin
only**, not doctor+admin, given `data-store-separation-reference.md` §7.2's
own framing ("plausibly admin/Treuhandstelle-mediated given the weight of
the action"). Sync-issue visibility is lower-stakes (read-only + a
resolve/dismiss action) — doctor+admin would be reasonable there if
doctors are expected to help chase down missing pseudonyms. **Confirm
before I implement** — this is a one-line difference
(`_check_admin_auth` vs a shared `_check_admin_or_doctor_auth`) but changes
who can permanently delete research data.

```python
def _is_admin(current_user: dict) -> bool:
    return current_user.get('user_type') == 'admin'

def _check_admin_auth(current_user: dict) -> tuple[bool, Any, int]:
    if not _is_admin(current_user):
        return False, {'message': 'Admin access only'}, 403
    return True, None, None
```

### 4.2 Routes

**`GET /api/admin/sync-issues`** — admin (or admin+doctor, per §4.1)
List open (and optionally resolved) sync issues.

Query params: `issue_type` (optional filter), `include_resolved` (bool,
default `false`).

```json
{
  "issues": [
    {
      "patient_id": "...",
      "issue_type": "missing_pseudonym",
      "detected_at": "...",
      "last_seen_at": "...",
      "resolved_at": null,
      "context": {"research_eligible_since": "..."}
    }
  ],
  "open_count": 3
}
```

**`GET /api/admin/erasure-requests`** — admin — *URL already reserved in
`research_routes.py`'s placeholder comments.*
Query param: `status` (default `"pending"`; accepts `all`).

```json
{
  "requests": [
    {
      "request_id": "...",
      "patient_id": "...",
      "research_pseudonym": "...",
      "requested_at": "...",
      "status": "pending",
      "reviewed_by": null,
      "reviewed_at": null
    }
  ]
}
```

Include a computed `affected_row_count` per request (a `db.research_vitals.
count_documents({"research_pseudonym": ...})` alongside the list query) —
an admin approving permanent deletion should see the blast radius before
acting, not just a pseudonym string. Cheap to add, meaningfully safer.

**`POST /api/admin/erasure-requests/<request_id>`** — admin — *URL and verb
already reserved in `research_routes.py`'s placeholder comments as a single
combined endpoint, not split approve/deny routes.*

Body: `{"action": "approve" | "deny", "reason": "optional string"}`

- `approve` →
  1. Re-fetch the request, confirm `status == "pending"` (guards against
     double-approval / stale UI state — return 409 if not).
  2. `db.research_vitals.delete_many({"research_pseudonym": pseudonym})` —
     record `deleted_count`.
  3. `$set status: "approved", reviewed_by, reviewed_at`.
  4. Response includes `deleted_count` so the admin gets confirmation of
     what was actually removed, not just a status flip.
- `deny` → `$set status: "denied", reviewed_by, reviewed_at, reason`. No
  data touched — matches §5.3's "revoke is prospective, erasure is the only
  destructive path, and only after approval" design.

```json
// approve response
{"request_id": "...", "status": "approved", "deleted_count": 42, "reviewed_at": "..."}
// deny response
{"request_id": "...", "status": "denied", "reason": "...", "reviewed_at": "..."}
```

Not building a separate confirmation/undo step beyond the `pending →
approve` gate itself — the whole point of the two-step design in §7.2 is
that the human review *is* the confirmation. A dry-run preview is covered
by the `affected_row_count` on the list endpoint instead of a second
"preview" call.

---

## 5. Sequencing

1. `sync_issues` collection + indexes + `flag_sync_issue()`/
   `resolve_sync_issue()` helpers in `consent_history.py` (§1).
2. Wire those into the sync loop + add `no_pseudonym_count` (§2). Smallest,
   most self-contained piece — no new routes, no auth decisions.
3. `erasure_requests` collection + indexes (§3) — schema already agreed,
   just needs creating.
4. Patient-facing `POST /api/patient/erasure-request` (§3, flagged as a
   dependency) — needed before the admin queue has anything to show.
5. `admin_routes.py` blueprint with both route groups (§4), once the §4.1
   auth-level question is answered.
6. Register the blueprint in `main.py` (`url_prefix=''`, alongside the
   existing list) and add it to the "Register blueprints" try block.
7. Update `data-store-separation-reference.md` — new §2.6 for
   `sync_issues`, flip §2.5/§5.3/§7.2 to ✅, remove the now-implemented
   lines from `research_routes.py`'s placeholder comment block.

---

## 6. Open questions before I implement

1. **Auth level** (§4.1) — admin-only, or admin+doctor, for each route
   group? They don't have to match each other.
2. **`sync_issues` scope** — this plan only wires up `"missing_pseudonym"`.
   Worth also flagging real gICS query failures (`gics_result["ok"] ==
   False`, from the earlier UNKNOWN-mapping fix) here if they repeat across
   multiple syncs for the same patient? Currently those only live in the
   per-run `errors[]`/`research_sync_log`, which is fine for a one-off blip
   but wouldn't surface a *persistently* unreachable gICS record for one
   patient the way `sync_issues` would.
3. Want the patient-facing erasure-request endpoint drafted now alongside
   the admin side, or held for a separate pass?
