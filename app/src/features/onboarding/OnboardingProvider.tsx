import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { logEvent } from '@/lib/log';
import { createSecureOnboardingStore, type OnboardingStore } from './onboardingStore';

/** `loading` until the flag is read; `needed` routes to onboarding; `complete` shows Today. */
export type OnboardingStatus = 'loading' | 'needed' | 'complete';

export interface OnboardingGate {
  status: OnboardingStatus;
  /** Sets the flag. Called only when the last step is done or skipped. A failed write is not fatal. */
  complete: () => Promise<void>;
  /** Dev only: clears the flag so onboarding runs again. */
  reset: () => Promise<void>;
}

const OnboardingContext = createContext<OnboardingGate | null>(null);

export function OnboardingProvider({ store, children }: { store?: OnboardingStore; children: ReactNode }) {
  const [backing] = useState<OnboardingStore>(() => store ?? createSecureOnboardingStore());
  const [status, setStatus] = useState<OnboardingStatus>('loading');

  useEffect(() => {
    let live = true;
    backing
      .isComplete()
      .then((done) => live && setStatus(done ? 'complete' : 'needed'))
      .catch(() => {
        // An unreadable flag means onboarding runs again, which is harmless.
        logEvent('onboarding.flag_read_failed', { code: 'storage_error' });
        if (live) setStatus('needed');
      });
    return () => {
      live = false;
    };
  }, [backing]);

  const complete = useCallback(async () => {
    try {
      await backing.setComplete();
    } catch {
      logEvent('onboarding.flag_write_failed', { code: 'storage_error' });
    }
    setStatus('complete');
  }, [backing]);

  const reset = useCallback(async () => {
    try {
      await backing.clear();
    } catch {
      logEvent('onboarding.flag_clear_failed', { code: 'storage_error' });
    }
    setStatus('needed');
  }, [backing]);

  const value = useMemo(() => ({ status, complete, reset }), [status, complete, reset]);
  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboardingGate(): OnboardingGate {
  const gate = useContext(OnboardingContext);
  if (!gate) throw new Error('useOnboardingGate must be used inside OnboardingProvider');
  return gate;
}
