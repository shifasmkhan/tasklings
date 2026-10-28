import { createMockApi } from './mock';
import type { ApiClient } from './types';

export * from './types';
export type { CaptureArrival, CaptureArrivals } from './arrivals';
export { hasArrivals } from './arrivals';
export { ApiError, isApiError, toApiError } from './errors';
export { createMockApi } from './mock';
export { createSupabaseApi } from './supabase';

/**
 * The app uses the in-memory mock until the backend lands and sign-in is built (US-10).
 * Swapping in createSupabaseApi is a one-line change here; screens depend only on ApiClient.
 */
export function createDefaultApi(): ApiClient {
  return createMockApi();
}
