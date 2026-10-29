import * as SecureStore from 'expo-secure-store';

import type { SecureStoreLike } from '@/api/secureSessionStorage';

// First-run flag (US-19). It lives in expo-secure-store like the session; AsyncStorage is banned.
// The flag is not secret, but one store keeps one rule. It says only "this install finished
// onboarding": no user data.

export const ONBOARDING_FLAG_KEY = 'onboarding_complete';

export interface OnboardingStore {
  isComplete(): Promise<boolean>;
  setComplete(): Promise<void>;
  clear(): Promise<void>;
}

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export function createSecureOnboardingStore(store: SecureStoreLike = SecureStore): OnboardingStore {
  return {
    async isComplete() {
      return (await store.getItemAsync(ONBOARDING_FLAG_KEY, OPTIONS)) === '1';
    },
    async setComplete() {
      await store.setItemAsync(ONBOARDING_FLAG_KEY, '1', OPTIONS);
    },
    async clear() {
      await store.deleteItemAsync(ONBOARDING_FLAG_KEY, OPTIONS);
    },
  };
}
