# main.py
from flask import Flask, request, jsonify
import logging
from config import create_app_config, mongo


def create_app():
    app = Flask(__name__)

    app.logger.setLevel(logging.INFO)
    logging.getLogger('werkzeug').setLevel(logging.WARNING)
    logging.getLogger('pymongo').setLevel(logging.WARNING)

    app, _, logger = create_app_config(app)

    # ── Health check ──────────────────────────────────────────────────────────
    @app.route('/api/health', methods=['GET', 'HEAD'])
    def health_check():
        response = jsonify({"status": "ok"})
        response.headers['Cache-Control'] = 'no-store'
        return response, 200

    # ── Error handlers ────────────────────────────────────────────────────────
    @app.errorhandler(404)
    def not_found(error):
        return jsonify({"error": "Resource not found"}), 404

    @app.errorhandler(500)
    def internal_error(error):
        logger.error(f"Internal server error: {str(error)}")
        return jsonify({"error": "Internal server error"}), 500

    # ── API v1 proxy ──────────────────────────────────────────────────────────
    # Forwards /api/v1/* → /api/* for mobile client compatibility.
    #
    # IMPORTANT: /fhir/* paths are explicitly excluded from this proxy.
    # FHIR resource endpoints are their own top-level namespace (/fhir/Patient,
    # /metadata) and must NOT be rewritten — a FHIR client calling
    # /fhir/Patient/123 must hit that route directly, not be mangled into
    # /api/Patient/123 which does not exist.
    @app.route('/api/v1/<path:path>', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
    def api_v1_proxy(path):
        """Proxy /api/v1/* → /api/* — FHIR paths excluded."""
        from werkzeug.exceptions import NotFound

        legacy_path = f'/api/{path}'
        adapter = app.url_map.bind('')

        try:
            endpoint, values = adapter.match(legacy_path, method=request.method)
            view_func = app.view_functions[endpoint]
            return view_func(**values)
        except NotFound:
            return jsonify({"error": "Resource not found"}), 404
        except Exception as e:
            logger.error(f"Error in API v1 proxy: {str(e)}")
            return jsonify({"error": "Internal server error"}), 500

    # ── Register blueprints ───────────────────────────────────────────────────
    try:
        from routes.auth_routes       import auth_routes
        from routes.doctor_routes     import doctor_routes
        from routes.patient_routes    import patient_routes
        from routes.ehr_routes        import ehr_routes
        from routes.medication_routes import medication_routes
        from routes.upload_routes     import upload_routes
        from routes.monitoring_routes import monitoring_routes
        from routes.clinic_routes     import clinic_routes
        from routes.consent_routes    import consent_routes

        # ── Health Connect wearable integration ───────────────────────────
        # Receives FHIR Observations from Android Health Connect on-device SDK.
        # No OAuth — permissions are OS-level. Stores into ehr_vitals.
        from routes.health_connect_routes import health_connect_bp

        # ── German FHIR additions ─────────────────────────────────────────
        # metadata_bp → GET /metadata  (FHIR CapabilityStatement, no auth)
        # FHIR Patient endpoints (read + search + fhir-identifiers) are now
        # part of patient_routes — no separate fhir_patient_route module needed.
        from routes.metadata_route import metadata_bp

        # ── Phase 2: Research consent sync ──────────────────────────────────
        # Researcher-triggered on-demand sync job to refresh research_eligible
        # flag from live gICS consent status (data-store-separation-reference.md
        # §4 & §7.3). No background scheduler — sync is request-triggered.
        # Phase 2.5: the same sync pass now also mirrors vitals into
        # research_vitals for eligible patients (utils/research_mirror.py).
        from routes.research_routes import research_routes

        # ── Admin: sync-issue visibility + data-erasure approval ────────────
        # Added 2026-08-11 (admin-routes-plan.md). Admin-only routes for
        # GET /api/admin/sync-issues and the erasure-request approval queue.
        from routes.admin_routes import admin_routes

        blueprints = [
            (auth_routes,        ''),
            (doctor_routes,      ''),
            (patient_routes,     ''),   # includes /fhir/Patient/* and /api/patient/fhir-identifiers
            (ehr_routes,         ''),
            (medication_routes,  '/api/medications'),
            (upload_routes,      ''),
            (monitoring_routes,  ''),
            (clinic_routes,      ''),
            (consent_routes,     ''),
            (health_connect_bp,  ''),   # /api/healthconnect/* — wearable FHIR sync
            (metadata_bp,        ''),   # /metadata — must be unauthenticated
            (research_routes,    ''),   # /api/research/* — researcher sync + data access (Phase 2/2.5)
            (admin_routes,       ''),   # /api/admin/* — admin-only sync-issue + erasure routes
        ]

        for blueprint, url_prefix in blueprints:
            app.register_blueprint(blueprint, url_prefix=url_prefix)
            logger.info(f"Registered blueprint: {blueprint.name}")

    except Exception as e:
        logger.error(f"Error registering blueprints: {str(e)}")
        raise

    # ── MongoDB startup indexes ───────────────────────────────────────────────
    # Flask-PyMongo resolves mongo.db through the application context, so
    # index creation must run inside one. create_app() itself does not push
    # a context, so we do it explicitly here before returning the app.
    with app.app_context():
        _ensure_mongo_indexes(logger)
        _ensure_dev_admin_account(logger)
        _ensure_dev_researcher_account(logger)

    return app


def _ensure_mongo_indexes(logger):
    """
    Create MongoDB indexes required by the German FHIR layer and
    Health Connect integration.
    All calls are idempotent — safe to run on every restart.
    """
    try:
        from pymongo import ASCENDING, DESCENDING

        mongo.db.patient_fhir_identifiers.create_index(
            [("patient_id", ASCENDING)],
            unique=True,
            name="idx_patient_fhir_id_unique",
        )
        mongo.db.patient_fhir_identifiers.create_index(
            [("gkv_kvid", ASCENDING)],
            sparse=True,
            name="idx_gkv_kvid_sparse",
        )
        # Allows efficient lookup by gPAS pseudonym (de-pseudonymisation path)
        mongo.db.patient_fhir_identifiers.create_index(
            [("pseudonym", ASCENDING)],
            sparse=True,
            name="idx_pseudonym_sparse",
        )
        mongo.db.patient_consents.create_index(
            [("patient_id", ASCENDING)],
            unique=True,
            name="idx_patient_consents_unique",
        )

        # ── consent_history + patient_identifiers ──────────────────────────
        # See utils/consent_history.py and data-store-separation-reference.md.
        # consent_history is append-only and keyed by pseudonym, not
        # patient_id — a patient can have many rows under one pseudonym, so
        # no unique constraint here, just the compound index the sync job
        # and open/close/get_consent_intervals() rely on for lookups.
        mongo.db.consent_history.create_index(
            [("pseudonym", ASCENDING), ("granted_at", ASCENDING)],
            name="idx_consent_history_pseudonym_granted",
        )
        mongo.db.patient_identifiers.create_index(
            [("patient_id", ASCENDING)],
            unique=True,
            name="idx_patient_identifiers_unique",
        )

        for coll_name in ("ehr_vitals", "ehr_visits", "ehr_conditions"):
            mongo.db[coll_name].create_index(
                [("patient_id", ASCENDING)],
                name=f"idx_{coll_name}_patient_id",
            )

        # ── Health Connect: compound index for fast status queries ────────────
        # Supports GET /api/healthconnect/status aggregation and
        # DELETE /api/healthconnect/data without a full collection scan.
        # Also used in the FHIR export bundle query (no filter change needed
        # there — ehr_vitals already queries by patient_id only).
        mongo.db.ehr_vitals.create_index(
            [("patient_id", ASCENDING), ("source", ASCENDING), ("synced_at", DESCENDING)],
            name="idx_ehr_vitals_hc_patient_source_synced",
            background=True,
        )
        # Secondary index for upsert deduplication in POST /api/healthconnect/sync
        # The upsert is keyed on `id` (client-generated UUID). This index turns
        # the bulk_write $setOnInsert upsert lookup from O(n_docs) to O(log n).
        mongo.db.ehr_vitals.create_index(
            [("id", ASCENDING)],
            name="idx_ehr_vitals_fhir_id",
            sparse=True,
            background=True,
        )

        # ── Research sync indexes (Phase 2) ────────────────────────────────────
        # Fast lookup of research_eligible status in dataset export queries
        mongo.db.patient_identifiers.create_index(
            [("research_eligible", ASCENDING), ("patient_id", ASCENDING)],
            name="idx_patient_identifiers_research_eligible",
        )
        # Support queries like "who became eligible in the last N hours?"
        mongo.db.patient_identifiers.create_index(
            [("last_synced_at", DESCENDING)],
            name="idx_patient_identifiers_last_synced",
            sparse=True,
        )
        # Audit trail queries and ops dashboards
        mongo.db.research_sync_log.create_index(
            [("synced_at", DESCENDING)],
            name="idx_research_sync_log_synced_at",
        )

        # ── research_vitals indexes (Phase 2.5) ────────────────────────────────
        # Idempotency key for mirror_patient_vitals()'s upsert — must be unique
        # or concurrent/retried syncs could double-insert the same reading.
        mongo.db.research_vitals.create_index(
            [("research_pseudonym", ASCENDING),
             ("source_collection", ASCENDING),
             ("source_observation_id", ASCENDING)],
            unique=True,
            name="idx_research_vitals_dedup",
        )
        # Primary read pattern for researchers: all readings for a pseudonym,
        # ordered by time.
        mongo.db.research_vitals.create_index(
            [("research_pseudonym", ASCENDING), ("effectiveDateTime", DESCENDING)],
            name="idx_research_vitals_pseudonym_time",
        )

        # ── sync_issues indexes (added 2026-08-11, admin-routes-plan.md §1) ────
        # One open doc per (patient_id, issue_type) — unique index doubles as
        # the constraint flag_sync_issue()/resolve_sync_issue() rely on to
        # avoid duplicate open issues for the same pair.
        mongo.db.sync_issues.create_index(
            [("patient_id", ASCENDING), ("issue_type", ASCENDING)],
            unique=True,
            name="idx_sync_issues_patient_type",
        )
        # Supports GET /api/admin/sync-issues's default "open issues only"
        # filter ({"resolved_at": None}) without a full collection scan.
        mongo.db.sync_issues.create_index(
            [("resolved_at", ASCENDING)],
            name="idx_sync_issues_resolved",
            sparse=True,
        )

        # ── erasure_requests indexes (added 2026-08-11, admin-routes-plan.md §3) ─
        # Primary read pattern for the admin queue: filter by status, newest
        # first.
        mongo.db.erasure_requests.create_index(
            [("status", ASCENDING), ("requested_at", DESCENDING)],
            name="idx_erasure_requests_status_requested",
        )
        # Lets a patient (or an admin looking up one patient) find their own
        # request history without a collection scan.
        mongo.db.erasure_requests.create_index(
            [("patient_id", ASCENDING)],
            name="idx_erasure_requests_patient",
        )

        # Medication module indexes
        from routes.medication_routes import ensure_medication_indexes
        ensure_medication_indexes()

        logger.info("MongoDB indexes ensured for German FHIR layer + Health Connect + Research sync + Admin")

    except Exception as exc:
        logger.warning(f"Could not ensure MongoDB indexes: {exc}")


def _ensure_dev_admin_account(logger):
    """
    ⚠️ TEMPORARY / DEV-ONLY — added 2026-08-11 at explicit request, in place
    of building a real admin-invite/promotion flow for now. Seeds a
    hardcoded admin account (username "admin", password "1234") on every
    startup if one doesn't already exist, so backend/routes/admin_routes.py
    (erasure approval, sync-issue visibility) is reachable without a
    manual DB insert.

    NOT SAFE for any shared, staging, or production environment — these
    credentials are fixed and public in this source file. Before this app
    is exposed anywhere beyond localhost:
      • change the password below (or better, drive it from an env var and
        skip seeding entirely if unset), and
      • decide what to do about auth_routes.py's /register endpoint, which
        still allows anyone to self-register a SECOND admin account with
        user_type="admin" and a password of their choosing — this function
        only seeds one known account, it does not close that door.

    Idempotent via upsert + $setOnInsert — safe to call on every restart.
    Won't overwrite the password if it's since been changed through the
    app (e.g. via a future admin profile/password-change endpoint).
    """
    from werkzeug.security import generate_password_hash
    from datetime import datetime, timezone

    try:
        result = mongo.db.users.update_one(
            {"username": "admin", "user_type": "admin"},
            {"$setOnInsert": {
                "username":      "admin",
                "email":         "admin@local.dev",
                "password":      generate_password_hash("1234"),
                "first_name":    "Admin",
                "last_name":     "Account",
                "date_of_birth": "",
                "user_type":     "admin",
                "created_at":    datetime.now(timezone.utc),
            }},
            upsert=True,
        )
        if result.upserted_id is not None:
            logger.warning(
                "Seeded default admin account — username='admin', "
                "password='1234'. INSECURE, dev-only — see "
                "_ensure_dev_admin_account()'s docstring in main.py before "
                "deploying this anywhere shared."
            )
    except Exception as exc:
        logger.warning(f"Could not ensure dev admin account: {exc}")


def _ensure_dev_researcher_account(logger):
    """
    ⚠️ TEMPORARY / DEV-ONLY — same reasoning as _ensure_dev_admin_account()
    above. Seeds a hardcoded researcher account (username "test_r1",
    password "12345678") on every startup if one doesn't already exist, so
    backend/routes/research_routes.py (POST /api/research/sync) and the
    mobile "Demo Researcher Account" tap-to-fill box on the login screen
    are reachable without a manual DB insert or self-registration step.

    NOT SAFE for any shared, staging, or production environment — these
    credentials are fixed and public in this source file. Same caveats as
    the dev admin account: change/remove before deploying anywhere beyond
    localhost, and note that /register still allows anyone to self-register
    additional user_type="researcher" accounts of their own choosing.

    Idempotent via upsert + $setOnInsert — safe to call on every restart.
    Won't overwrite the password if it's since been changed through the app.
    """
    from werkzeug.security import generate_password_hash
    from datetime import datetime, timezone

    try:
        result = mongo.db.users.update_one(
            {"username": "test_r1", "user_type": "researcher"},
            {"$setOnInsert": {
                "username":      "test_r1",
                "email":         "test_r1@local.dev",
                "password":      generate_password_hash("12345678"),
                "first_name":    "Test",
                "last_name":     "Researcher",
                "date_of_birth": "",
                "user_type":     "researcher",
                "created_at":    datetime.now(timezone.utc),
            }},
            upsert=True,
        )
        if result.upserted_id is not None:
            logger.warning(
                "Seeded default researcher account — username='test_r1', "
                "password='12345678'. INSECURE, dev-only — see "
                "_ensure_dev_researcher_account()'s docstring in main.py "
                "before deploying this anywhere shared."
            )
    except Exception as exc:
        logger.warning(f"Could not ensure dev researcher account: {exc}")


# Expose app at module level for Gunicorn
app = create_app()

if __name__ == '__main__':
    app.logger.info("Starting Flask application...")
    app.run(debug=False, host='0.0.0.0', port=5000)