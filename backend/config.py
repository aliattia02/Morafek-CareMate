from flask import Flask, jsonify, request
from flask_pymongo import PyMongo
from flask_cors import CORS
from pymongo.mongo_client import MongoClient
from pymongo.server_api import ServerApi
import cloudinary
import logging
from datetime import timezone, timedelta
from dotenv import load_dotenv
import os
import re

# Load environment variables from .env file
load_dotenv()

# Initialize Flask app
app = Flask(__name__)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Specifically set PyMongo logging to WARNING level
logging.getLogger('pymongo').setLevel(logging.WARNING)
logging.getLogger('mongodb').setLevel(logging.WARNING)
logging.getLogger('meal_insulin').setLevel(logging.DEBUG)

# Initialize MongoDB
mongo = PyMongo()

# MongoDB Atlas connection string - loaded from environment only
MONGO_URI = os.environ.get('MONGO_URI')
if not MONGO_URI:
    raise ValueError("MONGO_URI not set in environment variables. Check your .env file or Render environment settings.")


def test_mongo_connection():
    """Test MongoDB Atlas connection on startup"""
    try:
        client = MongoClient(MONGO_URI, server_api=ServerApi('1'))
        client.admin.command('ping')
        logger.info("✅ Successfully connected to MongoDB Atlas!")
        client.close()
        return True
    except Exception as e:
        logger.error(f"❌ MongoDB Atlas connection failed: {e}")
        return False


# All allowed origins in one place — edit here only
ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:5000",
    "http://localhost:8081",
    "http://localhost:8082",
    "http://localhost:8083",
    "http://localhost:19000",
    "http://localhost:19006",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5000",
    "http://127.0.0.1:8081",
    "http://127.0.0.1:8082",
    "http://127.0.0.1:8083",
    "http://127.0.0.1:19000",
    "http://127.0.0.1:19006",
    "http://192.168.0.104:3000",
    "http://192.168.0.104:5000",
    "http://192.168.0.104:8081",
    "https://morafek-api.onrender.com",
    "https://morafek-caremate.onrender.com",
    "https://morafek.vercel.app",
    "https://morafek-care-mate.vercel.app",
]

# Regex patterns to allow ALL Vercel preview deployments for this project
ALLOWED_ORIGIN_PATTERNS = [
    re.compile(r"^https://morafek-care-mate.*\.vercel\.app$"),
    re.compile(r"^https://morafek.*\.vercel\.app$"),
]


def is_origin_allowed(origin: str) -> bool:
    if not origin:
        return False
    if origin in ALLOWED_ORIGINS:
        return True
    return any(p.match(origin) for p in ALLOWED_ORIGIN_PATTERNS)


def create_app_config(app):
    """
    Configure the Flask application with CORS, MongoDB, and other settings.
    """

    # Test connection on startup
    test_mongo_connection()

    # Secret key - loaded from environment only
    secret_key = os.environ.get('SECRET_KEY')
    if not secret_key:
        raise ValueError("SECRET_KEY not set in environment variables. Check your .env file or Render environment settings.")

    # Cloudinary configuration — credentials come from environment variables.
    # Required: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
    cloudinary_cloud_name = os.environ.get('CLOUDINARY_CLOUD_NAME')
    cloudinary_api_key = os.environ.get('CLOUDINARY_API_KEY')
    cloudinary_api_secret = os.environ.get('CLOUDINARY_API_SECRET')
    if not all([cloudinary_cloud_name, cloudinary_api_key, cloudinary_api_secret]):
        raise ValueError(
            "Cloudinary credentials not fully set. Ensure CLOUDINARY_CLOUD_NAME, "
            "CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET are set in environment variables."
        )
    cloudinary.config(
        cloud_name=cloudinary_cloud_name,
        api_key=cloudinary_api_key,
        api_secret=cloudinary_api_secret,
        secure=True,
    )

    # Configuration - MUST be set BEFORE CORS initialization
    app.config.update(
        MONGO_URI=MONGO_URI,
        SECRET_KEY=secret_key,
        APP_TIMEZONE=timezone.utc,
        TOKEN_EXPIRY=timedelta(hours=24),          # Web / short-lived
        MOBILE_TOKEN_EXPIRY=timedelta(days=90),    # Mobile — stays logged in for 90 days
    )

    # CORS configuration
    CORS(app,
         resources={r"/*": {
             "origins": ALLOWED_ORIGINS,
             "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
             "allow_headers": [
                 "Content-Type",
                 "Authorization",
                 "Accept",
                 "Origin",
                 "X-Requested-With",
                 "X-Client-Type",
             ],
             "expose_headers": ["Content-Type", "Authorization"],
             "supports_credentials": True,
             "max_age": 3600
         }},
         supports_credentials=True
    )

    # Explicit OPTIONS handler for all routes
    @app.after_request
    def after_request(response):
        origin = request.headers.get('Origin')
        if origin and is_origin_allowed(origin):
            response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Access-Control-Allow-Credentials'] = 'true'
            response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS, PATCH'
            response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, Accept, Origin, X-Requested-With, X-Client-Type'
            response.headers['Access-Control-Expose-Headers'] = 'Content-Type, Authorization'
        return response

    @app.before_request
    def handle_preflight():
        if request.method == "OPTIONS":
            origin = request.headers.get('Origin', 'http://localhost:3000')
            response = jsonify({"status": "ok"})
            if is_origin_allowed(origin):
                response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Access-Control-Allow-Credentials'] = 'true'
            response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS, PATCH'
            response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, Accept, Origin, X-Requested-With, X-Client-Type'
            response.headers['Access-Control-Max-Age'] = '3600'
            return response, 200

    # Initialize MongoDB with app
    mongo.init_app(app)
    app.mongo = mongo
    app.logger = logger

    return app, mongo, logger


# Export these for backward compatibility
def get_mongo():
    return mongo


def get_logger():
    return logger


def get_medications_collection():
    return mongo.db.medications


def get_med_schedules_collection():
    return mongo.db.med_schedules


def get_med_intakes_collection():
    return mongo.db.med_intakes
