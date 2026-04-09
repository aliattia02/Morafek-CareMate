"""
cumulative_effects_routes.py - Backend Cumulative Effects API
============================================================================
Provides cumulative effects data for frontend comparison and validation.

Endpoints:
  /api/cumulative-effects     - Get cumulative baseline shift from today's meals/insulin
  /api/active-effects-full    - Get complete active effects (IOB, MOB, cumulative)

Author: DiaTwin Team
Version: 1.0 (Backend Comparison Support)
============================================================================
"""

from flask import Blueprint, request, jsonify
from datetime import datetime, timedelta
from bson.objectid import ObjectId
from utils.auth import token_required
from utils.error_handler import api_error_handler
from utils.pharmacodynamics import (
    calculate_total_cumulative_effects,
    get_daily_reset_time,
    calculate_meal_total_carbs_for_window,
    calculate_instantaneous_meal_effect,
    calculate_stable_baseline_from_reading,
)
from routes.medication_routes import calculate_stacked_insulin_effect
from utils.pharmacodynamics import calculate_meal_active_carbs
from constants import Constants
from config import mongo
from time_manager import TimeManager
import logging

logger = logging.getLogger(__name__)
cumulative_bp = Blueprint('cumulative_effects', __name__)


@cumulative_bp.route('/api/cumulative-effects', methods=['GET'])
@token_required
@api_error_handler
def get_cumulative_effects(current_user):
    """
    Calculate cumulative effects (baseline shift) from all meals/insulin today.

    Returns cumulative baseline that persists after absorption completes.
    Resets daily at patient's configured reset hour.

    Query Parameters:
        - patient_id: For doctors viewing patient data
        - target_time: Calculate at specific time (default: now)

    Returns:
        {
            'cumulative_meal_effect': 120.5,        # Total BG elevation from absorbed carbs
            'cumulative_insulin_effect': -85.0,     # Total BG reduction from absorbed insulin
            'cumulative_net_baseline': 35.5,        # Net shift from baseline
            'meal_contributions': [...],            # Individual meal contributions
            'insulin_contributions': [...],         # Individual insulin contributions
            'reset_hour': 7,
            'calculation_time': '2026-02-12T14:30:00',
            'next_reset': '2026-02-13T07:00:00'
        }
    """
    try:
        patient_id = request.args.get('patient_id')
        target_time_str = request.args.get('target_time')

        # Authorization
        if patient_id and current_user.get('user_type') != 'doctor':
            return jsonify({'error': 'Unauthorized access'}), 403

        user_id = patient_id if patient_id else str(current_user['_id'])

        # Parse target time
        if target_time_str:
            try:
                target_time = TimeManager.parse_timestamp(
                    target_time_str, TimeManager.PRECISION_SECOND
                )
                target_time = TimeManager.to_datetime(target_time, TimeManager.PRECISION_SECOND)
            except ValueError:
                return jsonify({'error': 'Invalid target_time format'}), 400
        else:
            target_time = TimeManager.get_current_datetime(TimeManager.PRECISION_SECOND)

        # Get patient constants (user-specific!)
        constants = Constants(user_id)
        patient_constants = constants.get_patient_constants()
        absorption_profiles = Constants.MEAL_ABSORPTION_PROFILES
        reset_hour = patient_constants.get('daily_reset_hour', 7)

        # 🆕 FIX: Get timezone offset from query params
        timezone_offset_minutes = request.args.get('timezone_offset_minutes', type=int)
        if timezone_offset_minutes is None:
            timezone_offset_minutes = patient_constants.get('timezone_offset_minutes', 0)

        logger.info(f"📊 Cumulative Effects - Patient: {user_id}, Reset Hour: {reset_hour}, Timezone: UTC{timezone_offset_minutes:+d}min")

        # Get reset time for filtering
        reset_time = get_daily_reset_time(target_time, reset_hour, timezone_offset_minutes)

        # Get all meals from today (after last reset)
        meals = list(mongo.db.meals_only.find({
            'user_id': user_id,
            'timestamp': {'$gte': reset_time, '$lte': target_time},
            'mealType': {'$nin': ['blood_sugar_only', 'insulin_only', 'activity_only']}
        }).sort('timestamp', -1))

        # Get all insulin doses from today
        insulin_doses = list(mongo.db.medication_logs.find({
            'patient_id': user_id,
            'is_insulin': True,
            'taken_at': {'$gte': reset_time, '$lte': target_time}
        }).sort('taken_at', -1))

        logger.info(f"Found {len(meals)} meals, {len(insulin_doses)} insulin doses since reset")

        # Calculate cumulative effects
        cumulative_data = calculate_total_cumulative_effects(
            meals=meals,
            insulin_doses=insulin_doses,
            current_time=target_time,
            patient_constants=patient_constants,  # ← Patient-specific!
            absorption_profiles=absorption_profiles,
            reset_hour=reset_hour,  # ← Patient-specific!
            timezone_offset_minutes=timezone_offset_minutes  # ← 🆕 Timezone fix!
        )

        logger.info(f"✅ Cumulative: Meals={cumulative_data['cumulative_meal_effect']}, "
                    f"Insulin={cumulative_data['cumulative_insulin_effect']}, "
                    f"Net={cumulative_data['cumulative_net_baseline']}")

        return jsonify(cumulative_data), 200

    except Exception as e:
        logger.error(f"Error calculating cumulative effects: {str(e)}", exc_info=True)
        return jsonify({'error': str(e)}), 500


@cumulative_bp.route('/api/active-effects-full', methods=['GET'])
@token_required
@api_error_handler
def get_active_effects_full(current_user):
    """
    Get complete active effects including IOB, MOB, and cumulative baseline.

    This endpoint combines:
    - IOB (Insulin On Board) with activity breakdown
    - MOB (Meal On Board) with absorption breakdown
    - Cumulative effects (baseline shift from today's meals/insulin)
    - 🆕 Instantaneous meal effect (current BG elevation from active meals)
    - 🆕 BG Estimates (stable baseline, current BG, projected BG)

    Query Parameters:
        - patient_id: For doctors viewing patient data
        - target_time: Calculate at specific time (default: now)

    Returns:
        {
            'iob': {...},                           # From calculate_stacked_insulin_effect
            'mob': {...},                           # From calculate_meal_active_carbs
            'cumulative': {...},                    # From calculate_total_cumulative_effects
            'instantaneous_meal_effect': 46.1,      # 🆕 Current BG elevation from active meals
            'bg_estimates': {                       # 🆕 BG estimation from most recent reading
                'stable_baseline': 98.5,            # Metabolic baseline (no effects)
                'current_estimated_bg': 125.3,      # Baseline + current net effect
                'projected_final_bg': 161.2,        # After all IOB acts
                'current_net_effect': 26.8,         # Net effect right now
                'reading_value': 150.0,             # Last reading
                'reading_timestamp': '...',         # When reading was taken
                'minutes_since_reading': 15.2       # Time since reading
            },
            'calculation_time': '...',
            'patient_id': '...'
        }

    Key Difference:
        - instantaneous_meal_effect: Only active meals (within duration) → resets to 0 after absorption
        - cumulative_meal_effect: All absorbed carbs since daily reset → persists until reset
    """
    try:
        patient_id = request.args.get('patient_id')
        target_time_str = request.args.get('target_time')

        # Authorization
        if patient_id and current_user.get('user_type') != 'doctor':
            return jsonify({'error': 'Unauthorized access'}), 403

        user_id = patient_id if patient_id else str(current_user['_id'])

        # Parse target time
        if target_time_str:
            try:
                target_time = TimeManager.parse_timestamp(
                    target_time_str, TimeManager.PRECISION_SECOND
                )
                target_time = TimeManager.to_datetime(target_time, TimeManager.PRECISION_SECOND)
            except ValueError:
                return jsonify({'error': 'Invalid target_time format'}), 400
        else:
            target_time = TimeManager.get_current_datetime(TimeManager.PRECISION_SECOND)

        logger.info(f"📊 Full Active Effects - Patient: {user_id}, Time: {target_time.isoformat()}")

        # Get patient constants
        constants = Constants(user_id)
        patient_constants = constants.get_patient_constants()
        absorption_profiles = Constants.MEAL_ABSORPTION_PROFILES
        reset_hour = patient_constants.get('daily_reset_hour', 7)

        # 🆕 FIX: Get timezone offset from query params, fall back to patient constant
        timezone_offset_minutes = request.args.get('timezone_offset_minutes', type=int)
        if timezone_offset_minutes is None:
            timezone_offset_minutes = patient_constants.get('timezone_offset_minutes', 0)
            logger.warning(
                f"⚠️ No timezone_offset_minutes in query params, using patient constant: {timezone_offset_minutes}")
        else:
            logger.info(f"✅ Using timezone_offset_minutes from query params: {timezone_offset_minutes}")

        # Calculate IOB
        iob_data = calculate_stacked_insulin_effect(user_id, target_time)

        # ============================================================================
        # ✅ FIXED: Calculate MOB with daily reset boundary
        # ============================================================================
        # PROBLEM: Previous code used simple 12-hour lookback, which included meals
        # from before the daily reset (e.g., meal at 3 AM when reset is 7 AM).
        #
        # SOLUTION: Use max(reset_time, cutoff_time) to ensure we only count meals
        # from the current daily period (after today's reset).
        #
        # EXAMPLE:
        # - Current time: 2:28 PM
        # - Reset time: 7:00 AM (5:00 UTC)
        # - 12-hour cutoff: 2:28 AM (0:28 UTC)
        # - Effective cutoff: 7:00 AM (later of the two)
        # - Meal at 3:00 AM: EXCLUDED (before reset)
        # ============================================================================

        reset_time = get_daily_reset_time(target_time, reset_hour, timezone_offset_minutes)
        cutoff_time = target_time - timedelta(hours=12)

        # ✅ FIX: Use the LATER of reset_time or cutoff_time
        # This prevents meals from before today's reset from being counted in MOB
        effective_cutoff = max(reset_time, cutoff_time)

        logger.info(f"📊 MOB Calculation - Reset: {reset_time.isoformat()}, "
                   f"12h Cutoff: {cutoff_time.isoformat()}, "
                   f"Effective: {effective_cutoff.isoformat()}")

        meals = list(mongo.db.meals_only.find({
            'user_id': user_id,
            'timestamp': {'$gte': effective_cutoff, '$lte': target_time},  # ✅ FIXED
            'mealType': {'$nin': ['blood_sugar_only', 'insulin_only', 'activity_only']}
        }).sort('timestamp', -1))

        total_active_carbs = 0
        total_absorbed_carbs = 0
        meal_contributions = []

        for meal in meals:
            # Use the window helper so fully-digested meals still contribute
            # their absorbed_carbs (calculate_meal_active_carbs returns 0 for them)
            carb_data = calculate_meal_total_carbs_for_window(
                meal, target_time, patient_constants, absorption_profiles
            )

            if carb_data['total_carbs'] > 0:
                total_active_carbs += carb_data['active_carbs']
                total_absorbed_carbs += carb_data['absorbed_carbs']
                meal_contributions.append({
                    'meal_id': str(meal.get('_id')),
                    'meal_time': meal['timestamp'].isoformat() if isinstance(meal['timestamp'], datetime) else meal[
                        'timestamp'],
                    'total_carbs': carb_data['total_carbs'],
                    'active_carbs': carb_data['active_carbs'],
                    'absorbed_carbs': carb_data['absorbed_carbs']
                })

        logger.info(f"📊 MOB Results - Meals found: {len(meals)}, "
                   f"Active meals: {len(meal_contributions)}, "
                   f"Total active carbs: {total_active_carbs:.1f}g, "
                   f"Total absorbed carbs: {total_absorbed_carbs:.1f}g")

        mob_data = {
            'totalActiveCarbs': round(total_active_carbs, 1),
            'total_active_carbs': round(total_active_carbs, 1),
            'totalAbsorbedCarbs': round(total_absorbed_carbs, 1),
            'total_absorbed_carbs': round(total_absorbed_carbs, 1),
            'active_meals_count': len(meal_contributions),
            'meal_contributions': meal_contributions
        }

        # 🆕 Calculate INSTANTANEOUS MEAL EFFECT (current BG elevation from absorbed carbs)
        # This is different from cumulative - only counts active meals (within duration)
        instantaneous_meal_effect = calculate_instantaneous_meal_effect(
            meals, target_time, patient_constants, absorption_profiles
        )

        logger.info(f"📊 Instantaneous Meal Effect: {instantaneous_meal_effect:.1f} mg/dL "
                    f"(vs Cumulative which will be calculated next)")

        # Calculate Cumulative Effects
        reset_time = get_daily_reset_time(target_time, reset_hour, timezone_offset_minutes)

        meals_cumulative = list(mongo.db.meals_only.find({
            'user_id': user_id,
            'timestamp': {'$gte': reset_time, '$lte': target_time},
            'mealType': {'$nin': ['blood_sugar_only', 'insulin_only', 'activity_only']}
        }))

        insulin_doses_cumulative = list(mongo.db.medication_logs.find({
            'patient_id': user_id,
            'is_insulin': True,
            'taken_at': {'$gte': reset_time, '$lte': target_time}
        }))

        cumulative_data = calculate_total_cumulative_effects(
            meals=meals_cumulative,
            insulin_doses=insulin_doses_cumulative,
            current_time=target_time,
            patient_constants=patient_constants,
            absorption_profiles=absorption_profiles,
            reset_hour=reset_hour,
            timezone_offset_minutes=timezone_offset_minutes
        )


        # 🆕 Calculate BG Estimates (Stable Baseline, Current BG, Projected BG)
        # ============================================================================
        # FORMULA EXPLANATION:
        # 1. Stable Baseline = Reading - Cumulative Effects at Reading Time
        # 2. Current Estimated BG = Stable Baseline + Cumulative Net Baseline (now)
        # 3. Projected Final BG = Current Estimated BG + Pending Net Effect
        #    Where Pending Net Effect = (Pending MOB Rise) - (Pending IOB Reduction)
        # ============================================================================
        bg_estimates = None
        try:
            # ============================================================================
            # ✅ ROBUST READING FETCH: handles mixed bloodSugarTimestamp storage formats.
            #
            # Root cause of the "wrong reading" bug — two layers:
            #
            # Layer 1: bloodSugarTimestamp is stored as a STRING in some documents and as
            #   a native datetime in others.  The original primary query compared the string
            #   field against a Python datetime using $gte/$lte, which MongoDB silently
            #   rejects (different BSON types), so it returned nothing and fell through to
            #   the fallback.
            #
            # Layer 2: The fallback sorted by `timestamp`, which is the meal/record
            #   CREATION time — not the actual blood sugar MEASUREMENT time.  This caused
            #   the most-recently-created record (140 mg/dL, created at 13:06) to be
            #   selected over the most-recently-measured reading (100 mg/dL, measured at
            #   13:11 but whose parent meal was created at 12:08).
            #
            # Fix: fetch all candidates in the daily period using an $or that covers both
            #   storage formats, then sort them in Python by the parsed bloodSugarTimestamp
            #   so we always get the reading with the latest MEASUREMENT time.
            # ============================================================================

            reset_time_str = reset_time.strftime('%Y-%m-%dT%H:%M:%S')
            target_time_str = target_time.strftime('%Y-%m-%dT%H:%M:%S')

            # Fetch all readings in the current daily period — handle both field formats
            candidate_readings = list(mongo.db.blood_sugar.find(
                {
                    'user_id': user_id,
                    '$or': [
                        # bloodSugarTimestamp stored as native datetime
                        {
                            'bloodSugarTimestamp': {
                                '$gte': reset_time,
                                '$lte': target_time
                            }
                        },
                        # bloodSugarTimestamp stored as ISO string
                        # (ISO strings sort lexicographically, so $gte/$lte works correctly)
                        {
                            'bloodSugarTimestamp': {
                                '$gte': reset_time_str,
                                '$lte': target_time_str
                            }
                        },
                        # Fallback: use the record's native timestamp field
                        {
                            'timestamp': {
                                '$gte': reset_time,
                                '$lte': target_time
                            }
                        },
                    ]
                }
            ))

            def _parse_reading_timestamp(reading):
                """Return a comparable UTC datetime for a blood_sugar document."""
                ts = (
                    reading.get('bloodSugarTimestamp') or
                    reading.get('reading_time') or
                    reading.get('timestamp')
                )
                if isinstance(ts, datetime):
                    return ts.replace(tzinfo=None)  # strip tz for uniform comparison
                if isinstance(ts, str):
                    try:
                        return datetime.fromisoformat(
                            ts.replace('Z', '+00:00')
                        ).replace(tzinfo=None)
                    except ValueError:
                        pass
                return datetime.min  # put unparseable entries last

            # Sort candidates by actual measurement time descending → pick the most recent
            candidate_readings.sort(key=_parse_reading_timestamp, reverse=True)
            recent_reading = candidate_readings[0] if candidate_readings else None

            if recent_reading:
                logger.info(
                    f"📊 {len(candidate_readings)} reading(s) found in current period. "
                    f"Selected most recent measurement: "
                    f"{recent_reading.get('bloodSugar', 'N/A')} mg/dL "
                    f"at {recent_reading.get('bloodSugarTimestamp') or recent_reading.get('timestamp')}"
                )

            else:
                logger.warning(
                    f"⚠️ No blood sugar reading found in current daily period "
                    f"(after {reset_time.isoformat()}). Falling back to patient target_glucose."
                )

                # ─────────────────────────────────────────────────────────────
                # NO READING IN CURRENT DAILY PERIOD → mirror frontend fallback
                #
                # Frontend logic (BloodSugarDataContext.js ~L1434):
                #   if (!readingIsInCurrentPeriod):
                #     effectiveBaseline = targetGlucose   ← patient-specific
                #     baselineSource    = 'target_fallback'
                #     confidence        = 'very_low'
                #
                # We replicate that here so the backend bg_estimates object is
                # populated (instead of null) and the comparison widget shows
                # matching values rather than N/A on the backend side.
                # ─────────────────────────────────────────────────────────────
                target_glucose = patient_constants.get('target_glucose', 100)

                carb_to_bg_ratio = patient_constants.get('carb_to_bg_ratio', 4.0)
                pending_mob_rise = total_active_carbs * carb_to_bg_ratio
                pending_iob_reduction = iob_data.get('pending_bg_reduction', 0.0)
                pending_net_effect = pending_mob_rise - pending_iob_reduction

                stable_baseline = target_glucose
                current_estimated_bg = stable_baseline + cumulative_data['cumulative_net_baseline']
                projected_final_bg = current_estimated_bg + pending_net_effect

                bg_estimates = {
                    'stable_baseline': round(stable_baseline, 1),
                    'current_estimated_bg': round(current_estimated_bg, 1),
                    'projected_final_bg': round(projected_final_bg, 1),
                    'cumulative_net_baseline': round(cumulative_data['cumulative_net_baseline'], 1),
                    'pending_net_effect': round(pending_net_effect, 1),
                    'pending_mob_rise': round(pending_mob_rise, 1),
                    'pending_iob_reduction': round(pending_iob_reduction, 1),
                    # No reading fields — make clear this is a fallback
                    'reading_value': None,
                    'reading_timestamp': None,
                    'minutes_since_reading': None,
                    'baseline_source': 'target_fallback',
                    'confidence': 'very_low',
                    'target_glucose_used': round(target_glucose, 1),
                    'note': (
                        f"No reading in current daily period (after {reset_hour}:00). "
                        f"Using patient target glucose ({target_glucose} mg/dL) as baseline fallback."
                    )
                }

                logger.info(
                    f"📊 BG Estimates (target fallback): Baseline={stable_baseline:.1f} mg/dL "
                    f"(patient target), Current={current_estimated_bg:.1f}, "
                    f"Projected={projected_final_bg:.1f} mg/dL"
                )

            if recent_reading:
                # Extract blood sugar value (try multiple field names for robustness)
                reading_value = (
                    recent_reading.get('blood_sugar') or
                    recent_reading.get('bloodSugar') or
                    recent_reading.get('value')
                )

                # ✅ Always use bloodSugarTimestamp as the measurement time anchor.
                # Fall back to reading_time then record timestamp only if not present.
                reading_time = (
                    recent_reading.get('bloodSugarTimestamp') or
                    recent_reading.get('reading_time') or
                    recent_reading.get('timestamp')
                )

                # Normalise to naive UTC datetime for pharmacodynamics calculations
                if isinstance(reading_time, str):
                    reading_time = datetime.fromisoformat(
                        reading_time.replace('Z', '+00:00')
                    ).replace(tzinfo=None)
                elif isinstance(reading_time, datetime) and reading_time.tzinfo is not None:
                    reading_time = reading_time.replace(tzinfo=None)

                if reading_value and reading_time:
                    logger.info(f"🩸 Found blood sugar reading: {reading_value} mg/dL at {reading_time}")

                    # 🔧 CORRECTED: Calculate stable baseline using CUMULATIVE effects (not instantaneous)
                    baseline_data = calculate_stable_baseline_from_reading(
                        reading_value=reading_value,
                        reading_timestamp=reading_time,
                        meals=meals_cumulative,
                        insulin_doses=insulin_doses_cumulative,
                        patient_constants=patient_constants,
                        absorption_profiles=absorption_profiles,
                        reset_hour=reset_hour,
                        timezone_offset_minutes=timezone_offset_minutes
                    )

                    stable_baseline = baseline_data['stable_baseline']

                    # 🔧 CORRECTED FORMULA: Current Estimated BG = Stable Baseline + Cumulative Net Baseline
                    # This represents: baseline + all absorbed effects from today's meals/insulin
                    current_estimated_bg = stable_baseline + cumulative_data['cumulative_net_baseline']

                    # Calculate pending net effect (future changes from active MOB/IOB)
                    carb_to_bg_ratio = patient_constants.get('carb_to_bg_ratio', 4.0)
                    pending_mob_rise = total_active_carbs * carb_to_bg_ratio
                    pending_iob_reduction = iob_data.get('pending_bg_reduction', 0.0)
                    pending_net_effect = pending_mob_rise - pending_iob_reduction

                    # 🔧 CORRECTED FORMULA: Projected Final BG = Current + Pending
                    projected_final_bg = current_estimated_bg + pending_net_effect

                    # Calculate minutes since reading
                    minutes_since_reading = (target_time - reading_time).total_seconds() / 60

                    bg_estimates = {
                        'stable_baseline': round(stable_baseline, 1),
                        'current_estimated_bg': round(current_estimated_bg, 1),
                        'projected_final_bg': round(projected_final_bg, 1),
                        'cumulative_net_baseline': round(cumulative_data['cumulative_net_baseline'], 1),
                        'pending_net_effect': round(pending_net_effect, 1),
                        'pending_mob_rise': round(pending_mob_rise, 1),
                        'pending_iob_reduction': round(pending_iob_reduction, 1),
                        'reading_value': round(reading_value, 1),
                        'reading_timestamp': reading_time.isoformat() if isinstance(reading_time, datetime) else reading_time,
                        'minutes_since_reading': round(minutes_since_reading, 1),
                        # ✅ NEW FIELDS: Cumulative effects at reading time (not instantaneous)
                        'cumulative_meal_effect_at_reading': baseline_data['cumulative_meal_effect'],
                        'cumulative_insulin_effect_at_reading': baseline_data['cumulative_insulin_effect'],
                        'cumulative_net_effect_at_reading': baseline_data['cumulative_net_effect'],
                        'meals_at_reading_count': baseline_data['meals_count'],
                        'insulin_at_reading_count': baseline_data['insulin_count']
                    }

                    logger.info(f"📊 BG Estimates: Baseline={stable_baseline:.1f}, "
                               f"Current={current_estimated_bg:.1f} (baseline + cumulative {cumulative_data['cumulative_net_baseline']:.1f}), "
                               f"Projected={projected_final_bg:.1f} (current + pending {pending_net_effect:.1f}) mg/dL")
                    logger.info(f"  ✅ Baseline from reading: {reading_value:.1f} - ({baseline_data['cumulative_meal_effect']:.1f} - {baseline_data['cumulative_insulin_effect']:.1f}) = {stable_baseline:.1f}")
                else:
                    logger.warning(f"⚠️ Blood sugar reading found but missing required fields. "
                                 f"Value: {reading_value}, Time: {reading_time}")
            else:
                logger.warning("⚠️ No recent blood sugar reading found for BG estimation")
                logger.info("💡 To see BG estimates, please record a blood sugar reading in your app")

        except Exception as e:
            logger.error(f"❌ Error calculating BG estimates: {str(e)}", exc_info=True)
            bg_estimates = None
        # Combine all data
        result = {
            'iob': iob_data,
            'mob': mob_data,
            'cumulative': cumulative_data,
            'bg_estimates': bg_estimates,  # 🆕 NEW: Stable baseline and BG estimates
            'totalIOB': iob_data['totalIOB'],
            'totalActiveCarbs': mob_data['totalActiveCarbs'],
            'cumulative_meal_effect': cumulative_data['cumulative_meal_effect'],
            'cumulative_insulin_effect': cumulative_data['cumulative_insulin_effect'],
            'cumulative_net_baseline': cumulative_data['cumulative_net_baseline'],
            'instantaneous_meal_effect': instantaneous_meal_effect,  # 🆕 NEW: Current BG elevation from active meals
            'calculation_time': target_time.isoformat(),
            'patient_id': user_id,
            'reset_hour': reset_hour,
            'next_reset': cumulative_data['next_reset']
        }

        logger.info(f"✅ Full Effects: IOB={iob_data['totalIOB']:.2f}u, "
                    f"MOB={mob_data['totalActiveCarbs']:.1f}g, "
                    f"Instantaneous Meal={instantaneous_meal_effect:.1f} mg/dL, "
                    f"Cumulative Net={cumulative_data['cumulative_net_baseline']:.1f} mg/dL")

        return jsonify(result), 200

    except Exception as e:
        logger.error(f"Error calculating full active effects: {str(e)}", exc_info=True)
        return jsonify({'error': str(e)}), 500

# Register blueprint in main.py:
#
# ============================================================================
# BASELINE CALCULATION FIX - CRITICAL FOR T1D CUMULATIVE MODEL
# ============================================================================
#
# **PROBLEM IDENTIFIED:**
# The backend was returning incorrect baseline values (e.g., 120 mg/dL instead of -15 mg/dL)
# because it was finding blood sugar readings from BEFORE the daily reset time.
#
# **ROOT CAUSE:**
# The old query used:
#   {'bloodSugarTimestamp': {'$lte': target_time}}  # Gets ANY reading before now
#
# This would find readings from yesterday (before 7 AM reset), resulting in:
#   - Cumulative effects at reading time = 0 (reading from before today's period)
#   - Baseline = reading_value - 0 = reading_value (WRONG!)
#
# **EXAMPLE:**
# Frontend: Reading 220 mg/dL at 06:03 AM → Baseline = 220 - 234.7 = -15 mg/dL ✅
# Backend:  Reading 120 mg/dL at 01:45 AM → Baseline = 120 - 0 = 120 mg/dL ❌
#
# **THE FIX:**
# Changed query to:
#   {'bloodSugarTimestamp': {'$gte': reset_time, '$lte': target_time}}
#
# This ensures we ONLY use readings from the current daily period (after reset time),
# so cumulative effects are calculated correctly from all of today's meals/insulin.
#
# **T1D CUMULATIVE MODEL PRINCIPLE:**
# For Type 1 Diabetes, the baseline represents metabolic state WITHOUT active effects.
# It's calculated by: Reading - (All Today's Meal Effects - All Today's Insulin Effects)
#
# This "bank balance" resets daily at the configured hour (default 7 AM) to handle
# basal insulin patterns and natural circadian glucose variations.
#
# **VALIDATION:**
# After this fix, backend baseline should match frontend baseline within ±0.5 mg/dL
# for the same reading timestamp and cumulative effects.
# ============================================================================
#