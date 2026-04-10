/**
 * Types Barrel Export
 * Location: mobile/types/index.ts
 *
 * Description: Central export point for all type definitions
 */

// User types
export type {
  User,
  Patient,
  Doctor,
  UserType
} from './user.types';

// API types
export type {
  ApiResponse,
  PaginationInfo,
  PaginatedResponse,
  LoginResponse,
  RegisterResponse,
  MealResponse,
  MealsListResponse,
  BloodSugarResponse,
  BloodSugarCreateResponse,
  InsulinLogResponse,
  InsulinDataResponse,
  ActiveInsulinResponse,
  ActivityResponse,
  FoodSearchResult,
  FoodCategoriesResponse,
  ApiError
} from './api';

// Navigation types
export type {
  AuthStackParamList,
  TabsParamList,
  LogStackParamList,
  MealStackParamList,
  SettingsStackParamList,
  RootStackParamList,
  ScreenProps
} from './navigation';