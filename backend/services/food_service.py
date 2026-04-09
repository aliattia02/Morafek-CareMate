from models.food_data import FOOD_CATEGORIES


def get_food_details(food_name):
    """Get food details from any category including custom foods"""
    categories = FOOD_CATEGORIES

    for category, foods in categories.items():
        if food_name in foods:
            return {'category': category, 'details': foods[food_name]}
    return None


def search_food(query, category=None):
    """Search for food items in the database including custom foods"""
    results = []
    categories = FOOD_CATEGORIES

    # If no category is specified, search all predefined categories
    if not category or category == '':
        search_categories = categories
    elif category == 'custom':
        # If custom is explicitly selected, only search custom foods
        try:
            from config import mongo
            custom_foods = mongo.db.custom_foods.find({
                'name': {'$regex': query, '$options': 'i'}
            })

            for food in custom_foods:
                results.append({
                    'name': food['name'],
                    'category': 'custom',
                    'details': {
                        'serving_size': food.get('serving_size', {'amount': 1, 'unit': 'g'}),
                        'carbs': food['carbs'],
                        'protein': food['protein'],
                        'fat': food['fat'],
                        'description': food.get('description', ''),
                        'absorption_type': food.get('absorption_type', 'medium')
                    }
                })
            return results
        except Exception as e:
            print(f"Error searching custom foods: {str(e)}")
            return []
    else:
        # If a specific category is selected
        search_categories = {category: categories[category]}

    # Search in predefined food categories
    for cat_name, category_dict in search_categories.items():
        for food_name, details in category_dict.items():
            if query.lower() in food_name.lower():
                results.append({
                    'name': food_name,
                    'category': cat_name,
                    'details': details,
                    'absorption_type': details.get('absorption_type', 'unknown')
                })

    # Add custom foods search (only when not in custom category)
    if not category or category == '':
        try:
            from config import mongo
            # Search in custom foods collection
            custom_foods = mongo.db.custom_foods.find({
                'name': {'$regex': query, '$options': 'i'}
            })

            for food in custom_foods:
                results.append({
                    'name': food['name'],
                    'category': 'custom',
                    'details': {
                        'serving_size': food.get('serving_size', {'amount': 1, 'unit': 'g'}),
                        'carbs': food['carbs'],
                        'protein': food['protein'],
                        'fat': food['fat'],
                        'description': food.get('description', ''),
                        'absorption_type': food.get('absorption_type', 'medium')
                    }
                })
        except Exception as e:
            print(f"Error searching custom foods: {str(e)}")

    return results

def calculate_absorption_factor(absorption_type, meal_timing):
    """Calculate absorption factor based on food type and meal timing"""
    return (ABSORPTION_FACTORS.get(absorption_type, ABSORPTION_FACTORS['unknown']) *
            TIMING_FACTORS.get(meal_timing, TIMING_FACTORS['normal']))

def convert_to_standard_nutrients(portion_size, measurement_type, food_details, converter):
    """
    Convert nutrients based on portion size and measurement type with proper unit conversion
    """
    details = food_details['details']
    serving_size = details.get('serving_size', {'amount': 100, 'unit': 'g'})

    # Handle special portion types first
    special_portions = {
        'plate': 300,  # grams
        'palm': 85,  # grams
        'handful': 30,  # grams
        'fist': 150,  # grams
        'bowl': 400  # ml
    }

    # Convert special portions to standard units
    if measurement_type in special_portions:
        standard_amount = special_portions[measurement_type] * portion_size
        standard_unit = 'g' if measurement_type != 'bowl' else 'ml'
    else:
        # Convert both measurements to standard units (g or ml)
        standard_amount, standard_unit = converter.convert_to_standard(
            portion_size,
            measurement_type
        )

    serving_amount, serving_unit = converter.convert_to_standard(
        serving_size['amount'],
        serving_size['unit']
    )