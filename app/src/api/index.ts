import { createLiveApi, readLiveConfig } from './live';
import { createMockApi } from './mock';
import type { ApiClient } from './types';

export * from './types';
export type { CaptureArrival, CaptureArrivals } from './arrivals';
export { hasArrivals } from './arrivals';
export { ApiError, isApiError, toApiError } from './errors';
export { createMockApi } from './mock';
export { createSupabaseApi } from './supabase';
export { createLiveApi, readLiveConfig } from './live';

/**
 * The app uses the in-memory mock unless both EXPO_PUBLIC_SUPABASE_URL and
 * EXPO_PUBLIC_SUPABASE_ANON_KEY are set, and then it talks to that project. Sign-in is still a
 * stub (US-10), so the live client has no session and its calls fail with `unauthenticated`.
 * Screens depend only on ApiClient.
 */
export function createDefaultApi(): ApiClient {
  const live = readLiveConfig();
  return live ? createLiveApi(live) : createMockApi();
}
