import { AppState } from 'react-native';

import { ApiError } from './errors';
import { createSecureSessionStorage } from './secureSessionStorage';
import { createSupabaseApi, type SupabaseApiClient } from './supabase';

export interface LiveConfig {
  url: string;
  anonKey: string;
}

/**
 * EXPO_PUBLIC_* values are inlined into the JavaScript bundle when it is built, and only when the
 * variable is read by its full literal name. Both of these are public by design (the project URL
 * and the anon key; row-level security does the protecting). Never put the service-role key here.
 * Returns null unless BOTH are set to non-empty values: the app then keeps using the mock.
 */
export function readLiveConfig(): LiveConfig | null {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim();
  return url && anonKey ? { url, anonKey } : null;
}

/** The real backend: session in the Keychain, token refresh tied to the app being in the foreground. */
export function createLiveApi(config: LiveConfig): SupabaseApiClient {
  if (!config.url || !config.anonKey) throw new ApiError('invalid_config', 'Supabase URL and anon key are required');
  const api = createSupabaseApi({ ...config, storage: createSecureSessionStorage() });
  // supabase-js documents this for React Native: refresh only while the app is active.
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void api.client.auth.startAutoRefresh();
    else void api.client.auth.stopAutoRefresh();
  });
  return api;
}
