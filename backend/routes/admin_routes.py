"""
backend/routes/admin_routes.py
─────────────────────────────────────────────────────────────────────────────
Admin-only routes: persistent sync-issue visibility, and the data-erasure
approval queue.

Added 2026-08-11 (admin-routes-plan.md). Two things this file does NOT do,
by design, this pass:
  • It does not create erasure_requests documents. That's the patient-
    facing POST /api/patient/erasure-request endpoint — held for later
    (admin-routes-plan.md §3/§6). Until it exists, GET /api/admin/
    erasure-requests will simply return an empty list; the approve/deny
    action route works correctly against whatever documents do exist
    (e.g. inserted by hand for testing).
  • It does not write to sync_issues. That happens in
    research_routes.py::sync_research_consent_status(), via
    utils/consent_history.py's flag_sync_issue()/resolve_sync_issue().
    This file only reads that collection.

Routes
──────
GET   /api/admin/sync-issues                  admin — list standing sync problems
GET   /api/admin/erasure-requests             admin — list erasure requests
POST  /api/admin/erasure-requests/<req_id>    admin — approve or deny one

MongoDB collections touched
────────────────────────────
sync_issues:        ← read-only here; written by research_routes.py's sync job
erasure_requests:   ← read + status/reviewed_by/reviewed_at writes here
research_vitals:    ← read-only for affected_row_count; delete_many() on approve

Design decisions
────────────────
AUTH               : Admin-only for every route in this file — not
                    doctor-or-admin, unlike consent_routes.py's
                    admin_reactivate_consent(). That endpoint issues a new
                    pseudonym (reversible, non-destructive); erasure
                    approval permanently deletes research_vitals rows
                    already possibly in active research use. See
                    admin-routes-plan.md §4.1 for the full reasoning —
                    this was an explicit decision, not a default.

ERASURE IS DESTRUCTIVE, IRREVERSIBLE : approve deletes matching
                    research_vitals rows immediately, synchronously, via
                    delete_many(). No soft-delete/undo — the two-step
                    request→approve design (data-store-separation-
                    reference.md §5.3/§7.2) is itself the safeguard; the
                    human review at approval time IS the confirmation.
                    GET /api/admin/erasure-requests includes a computed
                    affected_row_count per request so an admin sees the
                    blast radius before approving, not after.

SYNC_ISSUES IS READ-ONLY HERE : this file never calls flag_sync_issue()/
                    resolve_sync_issue() — those live in
                    research_routes.py, next to the conditions they
                    detect. Keeping the write path in one place (the sync
                    job) avoids two files disagreeing about when an issue
                    is open vs. resolved.

IDEMPOTENCY / RACE GUARD : the approve/deny action re-checks
                    status == "pending" before acting and returns 409 if
                    it's already been actioned — guards against a
                    double-click or two admins approving the same request.

Author: Morafek CareMate Team
─────────────────────────────────────────────────────────────────────────────
"""

from flask import Blueprint, jsonify, current_app, request
from datetime import datetime, timezone
from typing import Any, Optional
import logging

from utils.auth import token_required
from utils.error_handler import api_error_handler

logger = logging.getLogger(__name__)
admin_routes = Blueprint('admin_routes', __name__)


# ─── Helpers ───────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    """Return current UTC time as ISO 8601 string."""
    return datetime.now(timezone.utc).isoformat()


def _is_admin(current_user: dict) -> bool:
    """Check if the current user is an admin. Admin-only — see module
    docstring's AUTH note for why this doesn't also accept 'doctor'."""
    return current_user.get('user_type') == 'admin'


def _check_admin_auth(current_user: dict) -> tuple[bool, Any, int]:
    """
    Check admin authorization.
    Returns (is_authorized, error_response, status_code).
    """
    if not _is_admin(current_user):
        return False, {'message': 'Admin access only'}, 403
    return True, None, None


def _truthy_param(value: Optional[str]) -> bool:
    return (value or '').strip().lower() in ('1', 'true', 'yes')


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/admin/sync-issues — persistent standing sync problems
# ─────────────────────────────────────────────────────────────────────────────

@admin_routes.route('/api/admin/sync-issues', methods=['GET'])
@token_required
@api_error_handler
def list_sync_issues(current_user):
    """
    GET /api/admin/sync-issues — list standing problems the research sync
    job has flagged, read from the sync_issues collection
    (utils/consent_history.py::flag_sync_issue()/resolve_sync_issue()).

    Two issue_type values exist today:
      • "missing_pseudonym"    — patient is research_eligible but has no
                                  patient_consents.pseudonym yet, so vitals
                                  mirroring is skipped for them every sync.
      • "gics_query_failure"   — the patient's gICS query keeps failing
                                  (unreachable / SOAP fault / unparseable
                                  response) across syncs. A single blip
                                  self-heals and never appears here for
                                  more than one sync; occurrence_count > 1
                                  is what makes a *repeated* failure visible.

    Query params
    ────────────
    issue_type       optional — filter to one type
    include_resolved optional — "true" to include resolved issues too
                      (default: false, i.e. only open issues)

    Response
    ────────
    {
      "issues": [
        {
          "patient_id": "...",
          "issue_type": "missing_pseudonym",
          "detected_at": ISO datetime,
          "last_seen_at": ISO datetime,
          "resolved_at": ISO datetime | null,
          "occurrence_count": int,
          "context": { ... }
        }, ...
      ],
      "open_count": int   — always the count of currently-open issues
                            (matching issue_type filter if given), even
                            when include_resolved pulls resolved ones into
                            "issues" too
    }

    Admin-only (see module docstring).
    """
    authorized, error_response, status = _check_admin_auth(current_user)
    if not authorized:
        return jsonify(error_response), status

    db = current_app.mongo.db

    issue_type = request.args.get('issue_type')
    include_resolved = _truthy_param(request.args.get('include_resolved'))

    base_filter = {}
    if issue_type:
        base_filter['issue_type'] = issue_type

    query = dict(base_filter)
    if not include_resolved:
        query['resolved_at'] = None

    cursor = db.sync_issues.find(query, {'_id': 0}).sort('last_seen_at', -1)
    issues = list(cursor)

    # Computed independently of the `issues` list above so open_count is
    # always accurate even when include_resolved=true mixes resolved issues
    # into the returned list.
    open_count = db.sync_issues.count_documents(
        {**base_filter, 'resolved_at': None}
    )

    return jsonify({'issues': issues, 'open_count': open_count}), 200


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/admin/erasure-requests — approval queue
# ─────────────────────────────────────────────────────────────────────────────

@admin_routes.route('/api/admin/erasure-requests', methods=['GET'])
@token_required
@api_error_handler
def list_erasure_requests(current_user):
    """
    GET /api/admin/erasure-requests — list patient erasure requests.

    Query params
    ────────────
    status   optional — "pending" (default), "approved", "denied", or
             "all"

    Response
    ────────
    {
      "requests": [
        {
          "request_id": "...",
          "patient_id": "...",
          "research_pseudonym": "...",
          "requested_at": ISO datetime,
          "status": "pending" | "approved" | "denied",
          "reviewed_by": string | null,
          "reviewed_at": ISO datetime | null,
          "reason": string | null,
          "affected_row_count": int   — current research_vitals rows for
                                        this pseudonym, computed live so an
                                        admin sees the blast radius before
                                        approving (0 once already approved
                                        and deleted)
        }, ...
      ]
    }

    Admin-only (see module docstring).
    """
    authorized, error_response, status = _check_admin_auth(current_user)
    if not authorized:
        return jsonify(error_response), status

    db = current_app.mongo.db
    status_filter = request.args.get('status', 'pending')

    query = {}
    if status_filter != 'all':
        query['status'] = status_filter

    cursor = db.erasure_requests.find(query).sort('requested_at', -1)

    requests_out = []
    for doc in cursor:
        pseudonym = doc.get('research_pseudonym')
        affected = (
            db.research_vitals.count_documents({'research_pseudonym': pseudonym})
            if pseudonym else 0
        )
        requests_out.append({
            'request_id': str(doc['_id']),
            'patient_id': doc.get('patient_id'),
            'research_pseudonym': pseudonym,
            'requested_at': doc.get('requested_at'),
            'status': doc.get('status'),
            'reviewed_by': doc.get('reviewed_by'),
            'reviewed_at': doc.get('reviewed_at'),
            'reason': doc.get('reason'),
            'affected_row_count': affected,
        })

    return jsonify({'requests': requests_out}), 200


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/admin/erasure-requests/<request_id> — approve or deny
# ─────────────────────────────────────────────────────────────────────────────

@admin_routes.route('/api/admin/erasure-requests/<request_id>', methods=['POST'])
@token_required
@api_error_handler
def action_erasure_request(current_user, request_id):
    """
    POST /api/admin/erasure-requests/<request_id> — approve or deny a
    pending erasure request. One combined endpoint, not separate
    approve/deny routes — the action is selected via the request body.

    Body
    ────
    {
      "action": "approve" | "deny",   — required
      "reason": "string"              — optional, stored either way but
                                         especially useful on denial
    }

    approve: permanently deletes every research_vitals row matching this
             request's research_pseudonym (delete_many, synchronous, no
             undo — see module docstring's ERASURE IS DESTRUCTIVE note),
             then marks the request approved.
    deny:    marks the request denied. Touches no vitals data — matches
             data-store-separation-reference.md §5.3's "revoke is
             prospective; erasure is the only destructive path, and only
             after approval" design.

    Response (approve)
    ───────────────────
    { "request_id": "...", "status": "approved", "deleted_count": int, "reviewed_at": ISO datetime }

    Response (deny)
    ────────────────
    { "request_id": "...", "status": "denied", "reason": "...", "reviewed_at": ISO datetime }

    Failure modes
    ─────────────
    • 403 if not an admin
    • 400 if action is missing/invalid, or request_id isn't a valid ObjectId
    • 404 if no erasure request exists with that id
    • 409 if the request has already been approved or denied — guards
      against a double-click or two admins actioning the same request
    """
    authorized, error_response, status = _check_admin_auth(current_user)
    if not authorized:
        return jsonify(error_response), status

    db = current_app.mongo.db
    body = request.get_json(silent=True) or {}
    action = body.get('action')
    reason = body.get('reason')

    if action not in ('approve', 'deny'):
        return jsonify({'error': 'action must be "approve" or "deny"'}), 400

    from bson.objectid import ObjectId
    from bson.errors import InvalidId
    try:
        oid = ObjectId(request_id)
    except InvalidId:
        return jsonify({'error': 'invalid request_id'}), 400

    doc = db.erasure_requests.find_one({'_id': oid})
    if not doc:
        return jsonify({'error': 'erasure request not found'}), 404

    current_status = doc.get('status')
    if current_status != 'pending':
        return jsonify({
            'error': f'request is already "{current_status}", not pending',
        }), 409

    admin_id = str(current_user['_id'])
    now = _now_iso()

    if action == 'deny':
        db.erasure_requests.update_one(
            {'_id': oid},
            {'$set': {
                'status': 'denied',
                'reviewed_by': admin_id,
                'reviewed_at': now,
                'reason': reason,
            }},
        )
        logger.info(
            f"erasure request {request_id} denied by admin {admin_id}"
        )
        return jsonify({
            'request_id': request_id,
            'status': 'denied',
            'reason': reason,
            'reviewed_at': now,
        }), 200

    # ── approve ──────────────────────────────────────────────────────────
    pseudonym = doc.get('research_pseudonym')
    deleted_count = 0
    if pseudonym:
        delete_result = db.research_vitals.delete_many(
            {'research_pseudonym': pseudonym}
        )
        deleted_count = delete_result.deleted_count
    else:
        # Shouldn't happen given how requests get created (held for later —
        # see module docstring), but fail safe rather than crash on a
        # malformed/hand-inserted document.
        logger.warning(
            f"erasure request {request_id} has no research_pseudonym — "
            f"approving with nothing to delete"
        )

    db.erasure_requests.update_one(
        {'_id': oid},
        {'$set': {
            'status': 'approved',
            'reviewed_by': admin_id,
            'reviewed_at': now,
            'reason': reason,
        }},
    )
    logger.info(
        f"erasure request {request_id} approved by admin {admin_id} — "
        f"deleted {deleted_count} research_vitals row(s) for pseudonym "
        f"{pseudonym!r}"
    )
    return jsonify({
        'request_id': request_id,
        'status': 'approved',
        'deleted_count': deleted_count,
        'reviewed_at': now,
    }), 200
