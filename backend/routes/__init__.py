from routes.auth_routes import auth_routes
from routes.doctor_routes import doctor_routes
from routes.health_connect_routes import health_connect_bp

# Export all route blueprints
__all__ = [
    'auth_routes',
    'doctor_routes',
    'health_connect_bp',
]