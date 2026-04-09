from flask import Blueprint, request, jsonify
from bson.objectid import ObjectId
from datetime import datetime, timedelta  # Make sure timedelta is imported
from config import mongo
from utils.auth import token_required
from utils.error_handler import api_error_handler
from constants import Constants
import logging

logger = logging.getLogger(__name__)
activity_bp = Blueprint('activity', __name__)


def validate_activity_level(level):
    """Validate activity level against Constants"""
    valid_levels = [level['value'] for level in Constants.ACTIVITY_LEVELS]
    if level not in valid_levels:
        return False, f"Invalid activity level. Must be one of {valid_levels}"
    return True, None


def get_activity_impact(level):
    """Get activity impact coefficient from Constants"""
    for activity in Constants.ACTIVITY_LEVELS:
        if activity['value'] == level:
            return activity['impact']
    return 0


def parse_duration(duration):
    try:
        if isinstance(duration, str):
            hours, minutes = map(int, duration.split(':'))
            return hours + minutes / 60
        elif isinstance(duration, (int, float)):
            return duration
        else:
            return 1.0  # Default to 1 hour
    except Exception as e:
        logger.warning(f"Error parsing duration {duration}: {e}")
        return 1.0  # Default to 1 hour


def format_duration(duration):
    try:
        hours = int(duration)
        minutes = int((duration - hours) * 60)
        return f"{hours:02d}:{minutes:02d}"
    except Exception as e:
        logger.warning(f"Error formatting duration {duration}: {e}")
        return "01:00"  # Default to 1 hour


@activity_bp.route('/api/record-activities', methods=['POST'])
@token_required
def record_activities(current_user):
    data = request.json
    expected_activities = data.get('expectedActivities', [])
    completed_activities = data.get('completedActivities', [])

    user_id = str(current_user['_id'])
    timestamp = datetime.utcnow()

    # Initialize Constants for this user
    user_constants = Constants(user_id)
    activities_collection = mongo.db.activities

    def process_activity(activity, activity_type):
        try:
            # Validate activity level
            is_valid, error_message = validate_activity_level(activity['level'])
            if not is_valid:
                raise ValueError(error_message)

            activity_record = {
                'user_id': user_id,
                'timestamp': timestamp,
                'type': activity_type,
                'level': activity['level'],
                'impact': get_activity_impact(activity['level']),
            }

            # Ensure startTime and endTime are included
            if 'startTime' in activity:
                activity_record['startTime'] = activity['startTime']
            if 'endTime' in activity:
                activity_record['endTime'] = activity['endTime']

            # Handle duration formats
            if 'duration' in activity:
                activity_record['duration'] = activity['duration']
            elif 'startTime' in activity and 'endTime' in activity:
                # Calculate and add duration if possible
                try:
                    activity_record['duration'] = format_duration(
                        parse_duration(activity.get('duration', '01:00'))
                    )
                except Exception as e:
                    logger.warning(f"Failed to format duration: {e}")
                    activity_record['duration'] = '01:00'
            else:
                # Default duration if no format provided
                activity_record['duration'] = '01:00'

            # Handle time fields based on activity type
            if activity_type == 'expected':
                expected_time = activity.get('expectedTime', activity.get('startTime'))
                if expected_time:
                    activity_record['expectedTime'] = expected_time
            else:
                completed_time = activity.get('completedTime', activity.get('startTime'))
                if completed_time:
                    activity_record['completedTime'] = completed_time

            # Add notes field if present
            if 'notes' in activity:
                activity_record['notes'] = activity['notes']

            return activity_record
        except Exception as e:
            logger.error(f"Error processing activity: {str(e)}")
            raise

    try:
        # Process expected activities
        expected_ids = []
        for activity in expected_activities:
            record = process_activity(activity, 'expected')
            result = activities_collection.insert_one(record)
            expected_ids.append(str(result.inserted_id))

        # Process completed activities
        completed_ids = []
        for activity in completed_activities:
            record = process_activity(activity, 'completed')
            result = activities_collection.insert_one(record)
            completed_ids.append(str(result.inserted_id))

        # Combine all activity IDs
        all_activity_ids = expected_ids + completed_ids

        return jsonify({
            "message": "Activities recorded successfully",
            "expected_activity_ids": expected_ids,
            "completed_activity_ids": completed_ids,
            "activity_ids": all_activity_ids  # Add this to return all IDs
        }), 201
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        logger.error(f"Error recording activities: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@activity_bp.route('/api/activity-history', methods=['GET'])
@token_required
def get_activity_history(current_user):
    try:
        user_id = str(current_user['_id'])
        logger.info(f"Fetching activity history for user {user_id}")

        # Parse query parameters for filtering
        start_date_str = request.args.get('start_date')
        end_date_str = request.args.get('end_date')
        start_time_str = request.args.get('start_time')  # Add support for precise timestamps
        end_time_str = request.args.get('end_time')
        filter_by = request.args.get('filter_by', 'timestamp')  # Default to timestamp
        include_meal_details = request.args.get('include_meal_details') == 'true'  # Option to include meal details

        logger.debug(f"Filter parameters: start_date={start_date_str}, end_date={end_date_str}, " +
                     f"start_time={start_time_str}, end_time={end_time_str}, filter_by={filter_by}")

        # Build the query
        query = {"user_id": user_id}

        # Parse timestamps first (higher precision)
        start_datetime = None
        end_datetime = None

        # Try precise timestamps first
        if start_time_str:
            try:
                # Handle Z timezone indicator in ISO format
                if start_time_str.endswith('Z'):
                    start_time_str = start_time_str[:-1] + '+00:00'
                start_datetime = datetime.fromisoformat(start_time_str)
                logger.debug(f"Using exact start time: {start_datetime}")
            except Exception as e:
                logger.error(f"Error parsing start_time '{start_time_str}': {e}")
                return jsonify({"error": f"Invalid start_time format: {start_time_str}"}), 400

        if end_time_str:
            try:
                if end_time_str.endswith('Z'):
                    end_time_str = end_time_str[:-1] + '+00:00'
                end_datetime = datetime.fromisoformat(end_time_str)
                logger.debug(f"Using exact end time: {end_datetime}")
            except Exception as e:
                logger.error(f"Error parsing end_time '{end_time_str}': {e}")
                return jsonify({"error": f"Invalid end_time format: {end_time_str}"}), 400

        # Fall back to date strings if no precise timestamps
        if not start_datetime and start_date_str:
            try:
                start_datetime = datetime.strptime(start_date_str, '%Y-%m-%d')
                logger.debug(f"Using start date: {start_datetime}")
            except Exception as e:
                logger.error(f"Error parsing start_date '{start_date_str}': {e}")
                return jsonify({"error": f"Invalid start_date format: {start_date_str}"}), 400

        if not end_datetime and end_date_str:
            try:
                # Add one day to include the entire end date
                end_datetime = datetime.strptime(end_date_str, '%Y-%m-%d') + timedelta(days=1)
                logger.debug(f"Using end date: {end_datetime}")
            except Exception as e:
                logger.error(f"Error parsing end_date '{end_date_str}': {e}")
                return jsonify({"error": f"Invalid end_date format: {end_date_str}"}), 400

        # If we have date/time filters, add them to the query
        if start_datetime or end_datetime:
            # Determine which fields to filter on based on filter_by parameter
            filter_fields = []

            if filter_by == 'startTime':
                filter_fields = ['startTime', 'expectedTime']
            elif filter_by == 'endTime':
                filter_fields = ['endTime']
            else:  # Default to timestamp
                filter_fields = ['timestamp']

            # Create time range filter conditions
            time_conditions = []

            # For each field we want to filter on
            for field in filter_fields:
                field_condition = {}
                if start_datetime:
                    field_condition["$gte"] = start_datetime
                if end_datetime:
                    field_condition["$lt"] = end_datetime

                if field_condition:
                    time_conditions.append({field: field_condition})

            # Add spanning condition (activities that start before and end after the range)
            if start_datetime and end_datetime and 'startTime' in filter_fields:
                time_conditions.append({
                    "startTime": {"$lte": start_datetime},
                    "endTime": {"$gte": end_datetime}
                })

            # Add the time conditions to the query with $or
            if time_conditions:
                query["$or"] = time_conditions

        logger.debug(f"Final activity query: {query}")

        # Execute the query
        user_activities = list(mongo.db.activities.find(query).sort("timestamp", -1))
        logger.debug(f"Found {len(user_activities)} activities")

        # Initialize Constants for activity level labels
        activity_level_map = {level['value']: level['label'] for level in Constants.ACTIVITY_LEVELS}

        def format_time(time_value):
            try:
                if isinstance(time_value, str):
                    return time_value
                elif isinstance(time_value, datetime):
                    return time_value.isoformat()
                else:
                    return None
            except Exception as e:
                logger.warning(f"Error formatting time value: {time_value}, {e}")
                return None

        formatted_activities = []
        for activity in user_activities:
            try:
                formatted_activity = {
                    "id": str(activity['_id']),
                    "type": activity.get('type', 'unknown'),
                    "level": activity.get('level', 0),
                    "levelLabel": activity_level_map.get(activity.get('level', 0), "Unknown"),
                    "impact": activity.get('impact', get_activity_impact(activity.get('level', 0))),
                    "duration": activity.get('duration', '01:00'),
                    "timestamp": format_time(activity.get('timestamp', datetime.utcnow())),
                }

                # Add optional fields if present
                if 'startTime' in activity:
                    formatted_activity["startTime"] = format_time(activity['startTime'])
                if 'endTime' in activity:
                    formatted_activity["endTime"] = format_time(activity['endTime'])
                if 'expectedTime' in activity:
                    formatted_activity["expectedTime"] = format_time(activity['expectedTime'])
                if 'completedTime' in activity:
                    formatted_activity["completedTime"] = format_time(activity['completedTime'])
                if 'notes' in activity:
                    formatted_activity["notes"] = activity['notes']

                # Always add meal_id if present - BIDIRECTIONAL REFERENCE
                if 'meal_id' in activity:
                    formatted_activity["meal_id"] = activity['meal_id']

                    # Optionally fetch related meal details
                    if include_meal_details and activity['meal_id']:
                        try:
                            meal = mongo.db.meals.find_one({'_id': ObjectId(activity['meal_id'])})
                            if meal:
                                formatted_activity["meal_details"] = {
                                    "mealType": meal.get('mealType', 'unknown'),
                                    "timestamp": format_time(meal.get('timestamp')),
                                    "nutrition": meal.get('nutrition'),
                                    "bloodSugar": meal.get('bloodSugar'),
                                    "intendedInsulin": meal.get('intendedInsulin'),
                                }
                        except Exception as e:
                            logger.error(f"Error fetching meal details for activity {activity['_id']}: {e}")

                formatted_activities.append(formatted_activity)
            except Exception as e:
                logger.error(f"Error formatting activity {activity.get('_id', 'unknown')}: {e}")
                # Continue processing other activities even if one fails

        return jsonify(formatted_activities), 200
    except Exception as e:
        logger.error(f"Error fetching activity history: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@activity_bp.route('/api/patient/<patient_id>/activity-history', methods=['GET'])
@token_required
def get_patient_activity_history(current_user, patient_id):
    if current_user['user_type'] != 'doctor':
        return jsonify({"error": "Unauthorized access"}), 403

    try:
        logger.info(f"Doctor {str(current_user['_id'])} fetching activity history for patient {patient_id}")

        # Parse query parameters for date filtering
        start_date_str = request.args.get('start_date')
        end_date_str = request.args.get('end_date')

        # Build the query
        query = {"user_id": patient_id}

        # Add date range if provided - using $or to include activities that overlap the range
        if start_date_str or end_date_str:
            start_date = None
            end_date = None

            if start_date_str:
                try:
                    start_date = datetime.strptime(start_date_str, '%Y-%m-%d')
                except Exception as e:
                    logger.error(f"Error parsing start date '{start_date_str}': {e}")
                    return jsonify({"error": f"Invalid start date format: {start_date_str}"}), 400

            if end_date_str:
                try:
                    end_date = datetime.strptime(end_date_str, '%Y-%m-%d')
                    # Add one day to include the entire end date
                    end_date = end_date + timedelta(days=1)
                except Exception as e:
                    logger.error(f"Error parsing end date '{end_date_str}': {e}")
                    return jsonify({"error": f"Invalid end date format: {end_date_str}"}), 400

            # Create time range filter conditions using $or to capture all relevant activities
            # An activity is relevant if:
            # 1. Its timestamp is within range (traditional filter)
            # 2. OR its startTime/expectedTime is within range
            # 3. OR its endTime is within range
            # 4. OR it spans the entire range (starts before and ends after)
            time_conditions = []

            # Condition 1: Traditional timestamp filter
            timestamp_condition = {}
            if start_date:
                timestamp_condition["$gte"] = start_date
            if end_date:
                timestamp_condition["$lt"] = end_date
            if timestamp_condition:
                time_conditions.append({"timestamp": timestamp_condition})

            # Condition 2: Start time within range
            start_time_conditions = []
            for time_field in ["startTime", "expectedTime", "completedTime"]:
                if start_date and end_date:
                    start_time_conditions.append({
                        time_field: {"$gte": start_date, "$lt": end_date}
                    })
                elif start_date:
                    start_time_conditions.append({
                        time_field: {"$gte": start_date}
                    })
                elif end_date:
                    start_time_conditions.append({
                        time_field: {"$lt": end_date}
                    })

            # Condition 3: End time within range
            end_time_conditions = []
            if "endTime" in mongo.db.activities.find_one({}, {"_id": 0, "endTime": 1}):
                if start_date and end_date:
                    end_time_conditions.append({
                        "endTime": {"$gte": start_date, "$lt": end_date}
                    })
                elif start_date:
                    end_time_conditions.append({
                        "endTime": {"$gte": start_date}
                    })
                elif end_date:
                    end_time_conditions.append({
                        "endTime": {"$lt": end_date}
                    })

            # Condition 4: Activity spans the entire range
            span_conditions = []
            if start_date and end_date and "startTime" in mongo.db.activities.find_one({}, {"_id": 0,
                                                                                            "startTime": 1}) and "endTime" in mongo.db.activities.find_one(
                    {}, {"_id": 0, "endTime": 1}):
                span_conditions.append({
                    "startTime": {"$lte": start_date},
                    "endTime": {"$gte": end_date}
                })

            # Combine all conditions with $or
            all_time_conditions = time_conditions + start_time_conditions + end_time_conditions + span_conditions
            if all_time_conditions:
                query["$or"] = all_time_conditions

        # Execute the query
        patient_activities = list(mongo.db.activities.find(query).sort("timestamp", -1))
        logger.debug(f"Found {len(patient_activities)} activities for patient {patient_id}")

        activity_level_map = {level['value']: level['label'] for level in Constants.ACTIVITY_LEVELS}

        def format_time(time_value):
            try:
                if isinstance(time_value, str):
                    return time_value
                elif isinstance(time_value, datetime):
                    return time_value.isoformat()
                else:
                    return None
            except Exception as e:
                logger.warning(f"Error formatting time value: {time_value}, {e}")
                return None

        formatted_activities = []
        for activity in patient_activities:
            try:
                formatted_activity = {
                    "id": str(activity['_id']),
                    "type": activity.get('type', 'unknown'),
                    "level": activity.get('level', 0),
                    "levelLabel": activity_level_map.get(activity.get('level', 0), "Unknown"),
                    "impact": activity.get('impact', get_activity_impact(activity.get('level', 0))),
                    "duration": activity.get('duration', '01:00'),
                    "timestamp": format_time(activity.get('timestamp', datetime.utcnow())),
                }

                # Add optional fields if present
                if 'startTime' in activity:
                    formatted_activity["startTime"] = format_time(activity['startTime'])
                if 'endTime' in activity:
                    formatted_activity["endTime"] = format_time(activity['endTime'])
                if 'expectedTime' in activity:
                    formatted_activity["expectedTime"] = format_time(activity['expectedTime'])
                if 'completedTime' in activity:
                    formatted_activity["completedTime"] = format_time(activity['completedTime'])
                if 'meal_id' in activity:
                    formatted_activity["meal_id"] = activity['meal_id']
                if 'notes' in activity:
                    formatted_activity["notes"] = activity.get('notes', '')

                formatted_activities.append(formatted_activity)
            except Exception as e:
                logger.error(f"Error formatting patient activity {activity.get('_id', 'unknown')}: {e}")

        return jsonify(formatted_activities), 200
    except Exception as e:
        logger.error(f"Error fetching patient activity history: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@activity_bp.route('/api/activity', methods=['GET'])
@token_required
def get_activity(current_user):
    """
    Get activity data with optional filtering by date range.
    This endpoint is specifically for the ActivityVisualization component.
    """
    try:
        # Parse query parameters
        start_date_str = request.args.get('start_date')
        end_date_str = request.args.get('end_date')
        include_details = request.args.get('include_details') == 'true'
        limit = int(request.args.get('limit', 1000))  # Add limit parameter with default

        user_id = str(current_user['_id'])
        logger.info(f"Fetching activity data for user {user_id} from {start_date_str} to {end_date_str}")

        # Build the query with minimal required fields
        query = {"user_id": user_id}
        projection = {
            "_id": 1,
            "type": 1,
            "level": 1,
            "impact": 1,
            "duration": 1,
            "timestamp": 1,
            "startTime": 1,
            "endTime": 1
        }

        # Add optional fields if details are requested
        if include_details:
            projection.update({
                "expectedTime": 1,
                "completedTime": 1,
                "notes": 1,
                "meal_id": 1
            })

        # Add date range filters if provided
        if start_date_str or end_date_str:
            start_date = None
            end_date = None

            if start_date_str:
                try:
                    start_date = datetime.strptime(start_date_str, '%Y-%m-%d')
                except Exception as e:
                    logger.error(f"Error parsing start date '{start_date_str}': {e}")
                    return jsonify({"error": f"Invalid start date format: {start_date_str}"}), 400

            if end_date_str:
                try:
                    end_date = datetime.strptime(end_date_str, '%Y-%m-%d')
                    # Add one day to include the entire end date
                    end_date = end_date + timedelta(days=1)
                except Exception as e:
                    logger.error(f"Error parsing end date '{end_date_str}': {e}")
                    return jsonify({"error": f"Invalid end date format: {end_date_str}"}), 400

            # Create simplified time range filter using $or with fewer conditions
            time_conditions = []

            # Timestamp filter (simplified)
            if start_date and end_date:
                time_conditions.append({"timestamp": {"$gte": start_date, "$lt": end_date}})
            elif start_date:
                time_conditions.append({"timestamp": {"$gte": start_date}})
            elif end_date:
                time_conditions.append({"timestamp": {"$lt": end_date}})

            # Add startTime filter
            if start_date and end_date:
                time_conditions.append({"startTime": {"$gte": start_date, "$lt": end_date}})
            elif start_date:
                time_conditions.append({"startTime": {"$gte": start_date}})
            elif end_date:
                time_conditions.append({"startTime": {"$lt": end_date}})

            # Add the time conditions to query with $or
            if time_conditions:
                query["$or"] = time_conditions

        # Get the activities with limit for better performance
        user_activities = list(mongo.db.activities.find(query, projection).sort("timestamp", -1).limit(limit))
        logger.debug(f"Found {len(user_activities)} activities")

        # Format activities for response
        formatted_activities = []
        for activity in user_activities:
            try:
                # Format basic activity data
                formatted_activity = {
                    "_id": str(activity['_id']),
                    "type": activity.get('type', 'unknown'),
                    "level": activity.get('level', 0),
                    "impact": activity.get('impact', 1.0),
                    "duration": activity.get('duration', '01:00')
                }

                # Add time fields if they exist
                for time_field in ["timestamp", "startTime", "endTime", "expectedTime", "completedTime"]:
                    if time_field in activity and activity[time_field]:
                        if isinstance(activity[time_field], datetime):
                            formatted_activity[time_field] = activity[time_field].isoformat()
                        else:
                            formatted_activity[time_field] = activity[time_field]

                # Add notes and meal_id only if include_details is True
                if include_details:
                    if 'notes' in activity:
                        formatted_activity["notes"] = activity['notes']
                    if 'meal_id' in activity:
                        formatted_activity["meal_id"] = activity['meal_id']

                formatted_activities.append(formatted_activity)
            except Exception as e:
                logger.error(f"Error formatting activity {activity.get('_id', 'unknown')}: {e}")

        return jsonify(formatted_activities), 200

    except Exception as e:
        logger.error(f"Error in get_activity: {str(e)}")
        return jsonify({"error": str(e)}), 500




@activity_bp.route('/api/activities', methods=['GET'])
@token_required
def get_activities(current_user):
    """
    Get recent activities for the current user with pagination and sorting
    """
    try:
        # Parse query parameters
        limit = int(request.args.get('limit', 10))
        skip = int(request.args.get('skip', 0))
        sort_field = request.args.get('sort', '-timestamp')

        # Handle sort direction
        sort_direction = -1  # Default to descending (newest first)
        if sort_field.startswith('-'):
            sort_field = sort_field[1:]
        else:
            sort_direction = 1  # Ascending

        # Get total count for pagination
        total_activities = mongo.db.activities.count_documents({"user_id": str(current_user['_id'])})

        # Fetch activities with pagination and sorting
        activities = list(mongo.db.activities.find(
            {"user_id": str(current_user['_id'])}
        ).sort(sort_field, sort_direction).skip(skip).limit(limit))

        # Transform ObjectId to string and format datetime for JSON serialization
        formatted_activities = []
        for activity in activities:
            # Convert ObjectId to string
            activity['_id'] = str(activity['_id'])

            # Convert datetime fields to ISO strings for serialization
            for key in ['timestamp', 'startTime', 'endTime', 'expectedTime', 'completedTime']:
                if key in activity and isinstance(activity[key], datetime):
                    activity[key] = activity[key].isoformat()

            # Normalize type field for consistency
            if 'type' not in activity:
                activity['type'] = 'expected' if activity.get('expectedTime') else 'completed'

            # Add level label
            if 'level' in activity:
                for level_info in Constants.ACTIVITY_LEVELS:
                    if level_info['value'] == activity['level']:
                        activity['levelLabel'] = level_info['label']
                        break

            # Add to result list
            formatted_activities.append(activity)

        return jsonify(formatted_activities), 200

    except Exception as e:
        logger.error(f"Error getting activities: {str(e)}")
        return jsonify({"error": str(e)}), 500


@activity_bp.route('/api/activity/<activity_id>', methods=['GET'])
@token_required
@api_error_handler
def get_activity_by_id(current_user, activity_id):
    try:
        # Find the specific activity
        activity = mongo.db.activities.find_one({'_id': ObjectId(activity_id)})

        if not activity:
            return jsonify({"error": "Activity not found"}), 404

        # Verify ownership
        if activity.get('user_id') != str(current_user['_id']) and current_user.get('user_type') != 'doctor':
            return jsonify({"error": "Unauthorized access"}), 403

        # Format the activity
        formatted_activity = {
            "id": str(activity['_id']),
            "type": activity.get('type', 'unknown'),
            "level": activity.get('level', 0),
            "impact": activity.get('impact', 1.0),
            "duration": activity.get('duration', '01:00'),
            "timestamp": format_time(activity.get('timestamp', datetime.utcnow())),
        }

        # Add optional fields if present
        for field in ["startTime", "endTime", "expectedTime", "completedTime", "notes"]:
            if field in activity:
                formatted_activity[field] = format_time(activity[field]) if isinstance(activity[field], datetime) else \
                activity[field]

        return jsonify(formatted_activity), 200

    except Exception as e:
        logger.error(f"Error fetching activity by ID: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500