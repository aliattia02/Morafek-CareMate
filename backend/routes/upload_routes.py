from flask import Blueprint, request, jsonify, current_app
from bson.objectid import ObjectId
from utils.auth import token_required
from utils.error_handler import api_error_handler
from config import mongo
import cloudinary.uploader
import logging

logger = logging.getLogger(__name__)

upload_routes = Blueprint('upload_routes', __name__)

# Maximum allowed upload size: 5 MB
MAX_FILE_BYTES = 5 * 1024 * 1024

# Permitted image MIME types
ALLOWED_MIME_TYPES = {'image/jpeg', 'image/png', 'image/webp', 'image/gif'}


@upload_routes.route('/api/user/avatar', methods=['POST'])
@token_required
@api_error_handler
def upload_avatar(current_user):
    """POST /api/user/avatar — upload a profile picture to Cloudinary.

    Expects a multipart/form-data request with a single file field named
    'avatar'.  The image is uploaded to Cloudinary under the
    'morafek/avatars' folder and the resulting secure URL is persisted in
    the user's MongoDB document as ``profile_picture_url``.

    Returns:
        200  { profile_picture_url: <https URL> }
        400  on missing / invalid / oversized file
        500  on Cloudinary or DB failure
    """
    if 'avatar' not in request.files:
        return jsonify({'error': 'No file provided. Send the image as the "avatar" field.'}), 400

    file = request.files['avatar']

    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    if file.mimetype not in ALLOWED_MIME_TYPES:
        return jsonify({'error': f'Unsupported file type: {file.mimetype}. '
                                  'Allowed types: JPEG, PNG, WebP, GIF'}), 400

    # Read file bytes and enforce size limit
    file_bytes = file.read()
    if len(file_bytes) > MAX_FILE_BYTES:
        return jsonify({'error': 'File too large. Maximum allowed size is 5 MB.'}), 400

    user_id = str(current_user['_id'])

    # Upload to Cloudinary
    upload_result = cloudinary.uploader.upload(
        file_bytes,
        folder='morafek/avatars',
        public_id=f'user_{user_id}',
        overwrite=True,
        resource_type='image',
        transformation=[
            {'width': 400, 'height': 400, 'crop': 'fill', 'gravity': 'face'},
        ],
    )

    profile_picture_url = upload_result.get('secure_url')
    if not profile_picture_url:
        logger.error('Cloudinary upload succeeded but returned no secure_url')
        return jsonify({'error': 'Upload failed: no URL returned'}), 500

    # Persist the URL in MongoDB
    mongo.db.users.update_one(
        {'_id': ObjectId(user_id)},
        {'$set': {'profile_picture_url': profile_picture_url}},
    )

    logger.info(f'Profile picture updated for user {user_id}')
    return jsonify({'profile_picture_url': profile_picture_url}), 200
