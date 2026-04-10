from routes.auth_routes import auth_routes
from routes.doctor_routes import doctor_routes

# Export all route blueprints
__all__ = [
    'auth_routes',
    'doctor_routes',
]