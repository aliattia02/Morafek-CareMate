# main.py
from flask import Flask, request, jsonify
import logging
from config import create_app_config, mongo


def create_app():
    # Create Flask app
    app = Flask(__name__)

    # Set logging levels
    app.logger.setLevel(logging.INFO)
    logging.getLogger('werkzeug').setLevel(logging.WARNING)
    logging.getLogger('pymongo').setLevel(logging.WARNING)

    # Initialize app with config
    app, _, logger = create_app_config(app)

    # ── Health check endpoint ─────────────────────────────────────────────
    # Used by:
    #   1. Mobile app wakeUpServer() poller before login
    #   2. External cron-job.org keep-alive ping
    #
    # IMPORTANT: Must return explicit jsonify() response, NOT a plain dict.
    # Returning a dict directly can trigger Flask's debug toolbar or error
    # middleware that bloats the response — causing cron-job.org to report
    # "Failed (output too large)" on cold-start responses.
    @app.route('/api/health', methods=['GET', 'HEAD'])
    def health_check():
        # HEAD support: cron services sometimes use HEAD to minimise bandwidth
        response = jsonify({"status": "ok"})
        response.headers['Cache-Control'] = 'no-store'
        return response, 200
    # ─────────────────────────────────────────────────────────────────────

    # Error handling
    @app.errorhandler(404)
    def not_found(error):
        return jsonify({"error": "Resource not found"}), 404

    @app.errorhandler(500)
    def internal_error(error):
        logger.error(f"Internal server error: {str(error)}")
        return jsonify({"error": "Internal server error"}), 500

    # API versioning support
    @app.route('/api/v1/<path:path>', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
    def api_v1_proxy(path):
        """Proxy /api/v1/* requests to /api/* for mobile app compatibility"""
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

    try:
        # Import blueprints
        from routes.auth_routes import auth_routes
        from routes.doctor_routes import doctor_routes
        from routes.patient_routes import patient_routes
        from routes.ehr_routes import ehr_routes

        blueprints = [
            (auth_routes, ''),
            (doctor_routes, ''),
            (patient_routes, ''),
            (ehr_routes, ''),
        ]

        for blueprint, url_prefix in blueprints:
            app.register_blueprint(blueprint, url_prefix=url_prefix)
            logger.info(f"Registered blueprint: {blueprint.name}")

    except Exception as e:
        logger.error(f"Error registering blueprints: {str(e)}")
        raise

    return app


# Expose app at module level for Gunicorn (required for Render deployment)
app = create_app()

if __name__ == '__main__':
    app.logger.info("Starting Flask application...")
    app.run(debug=False, host='0.0.0.0', port=5000)