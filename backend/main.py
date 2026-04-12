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
        from routes.upload_routes     import upload_routes
        from routes.monitoring_routes import monitoring_routes
        from routes.clinic_routes     import clinic_routes

        # ── German FHIR additions ─────────────────────────────────────────
        # metadata_bp → GET /metadata  (FHIR CapabilityStatement, no auth)
        # FHIR Patient endpoints (read + search + fhir-identifiers) are now
        # part of patient_routes — no separate fhir_patient_route module needed.
        from routes.metadata_route import metadata_bp

        blueprints = [
            (auth_routes,       ''),
            (doctor_routes,     ''),
            (patient_routes,    ''),   # includes /fhir/Patient/* and /api/patient/fhir-identifiers
            (ehr_routes,        ''),
            (upload_routes,     ''),
            (monitoring_routes, ''),
            (clinic_routes,     ''),
            (metadata_bp,       ''),   # /metadata — must be unauthenticated
        ]

        for blueprint, url_prefix in blueprints:
            app.register_blueprint(blueprint, url_prefix=url_prefix)
            logger.info(f"Registered blueprint: {blueprint.name}")

    except Exception as e:
        logger.error(f"Error registering blueprints: {str(e)}")
        raise

    # ── MongoDB startup indexes ───────────────────────────────────────────────
    _ensure_mongo_indexes(logger)

    return app


def _ensure_mongo_indexes(logger):
    """
    Create MongoDB indexes required by the German FHIR layer.
    All calls are idempotent — safe to run on every restart.
    """
    try:
        from pymongo import ASCENDING

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

        for coll_name in ("ehr_vitals", "ehr_visits", "ehr_conditions"):
            mongo.db[coll_name].create_index(
                [("patient_id", ASCENDING)],
                name=f"idx_{coll_name}_patient_id",
            )

        logger.info("MongoDB indexes ensured for German FHIR layer")

    except Exception as exc:
        logger.warning(f"Could not ensure MongoDB indexes: {exc}")


# Expose app at module level for Gunicorn
app = create_app()

if __name__ == '__main__':
    app.logger.info("Starting Flask application...")
    app.run(debug=False, host='0.0.0.0', port=5000)