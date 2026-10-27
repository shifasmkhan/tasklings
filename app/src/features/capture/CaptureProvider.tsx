import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { useApi } from '@/api/ApiProvider';
import { CaptureStore, type PendingCapture } from './captureStore';

const CaptureContext = createContext<CaptureStore | null>(null);
const NO_PENDING: readonly PendingCapture[] = [];

/**
 * Owns the CaptureStore for the app. Retries queued captures whenever the app comes back to the
 * foreground (US-01 offline rule).
 */
export function CaptureProvider({ store, children }: { store?: CaptureStore; children: ReactNode }) {
  const api = useApi();
  const [value] = useState<CaptureStore>(() => store ?? new CaptureStore({ api, arrivals: null }));

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void value.retryQueued();
    });
    return () => sub.remove();
  }, [value]);

  return <CaptureContext.Provider value={value}>{children}</CaptureContext.Provider>;
}

export function useCaptureStore(): CaptureStore {
  const store = useContext(CaptureContext);
  if (!store) throw new Error('useCaptureStore must be used inside CaptureProvider');
  return store;
}

/** Null outside a CaptureProvider, so screens that only watch captures (Today) still render alone. */
export function useOptionalCaptureStore(): CaptureStore | null {
  return useContext(CaptureContext);
}

const emptySubscribe = () => () => undefined;

/** Captures that haven't turned into tasks yet. Empty outside a CaptureProvider. */
export function usePendingCaptures(): readonly PendingCapture[] {
  const store = useContext(CaptureContext);
  return useSyncExternalStore(
    store ? store.subscribe : emptySubscribe,
    store ? store.getPending : () => NO_PENDING,
    () => NO_PENDING,
  );
}
