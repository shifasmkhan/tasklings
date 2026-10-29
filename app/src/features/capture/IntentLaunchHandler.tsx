import { useRootNavigationState, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { loadNativeIntentsModule, type NativeIntentsModule } from '../../../modules/tasklings-intents/src';
import { useOnboardingGate } from '@/features/onboarding/OnboardingProvider';
import { dropIntentLaunch, markIntentLaunchHandled, pollIntentLaunch, useIntentLaunchState } from './intentLaunch';

/**
 * Opens the Capture sheet, recording, when the app was started by our own "Add a task" App Intent
 * (US-01). Mount it once in the root layout, before the Stack.
 *
 * It checks the native one-shot flag at startup (before anything renders, so a cold launch never
 * paints Today), when the app comes to the foreground, and when the intent fires in a live app.
 * URLs are never consulted.
 */
export function IntentLaunchHandler({ native: injected }: { native?: NativeIntentsModule | null }) {
  const router = useRouter();
  const navKey = useRootNavigationState()?.key;
  const gate = useOnboardingGate();
  const { pendingOpen } = useIntentLaunchState();

  // Read once, during the first render: the cover must be up before Today's first paint. Consuming
  // is idempotent (a second call returns false and the state is already set), so a double render is safe.
  const [native] = useState<NativeIntentsModule | null>(() => {
    const n = injected === undefined ? loadNativeIntentsModule() : injected;
    pollIntentLaunch(n);
    return n;
  });

  useEffect(() => {
    if (!native) return;
    const poll = () => void pollIntentLaunch(native);
    const sub = native.addListener('onIntentLaunch', poll);
    const app = AppState.addEventListener('change', (s) => {
      if (s === 'active') poll();
    });
    return () => {
      sub.remove();
      app.remove();
    };
  }, [native]);

  useEffect(() => {
    if (!pendingOpen || gate.status === 'loading' || !navKey) return;
    if (gate.status === 'needed') {
      // Not signed in / first run: onboarding comes first. Never record before it.
      dropIntentLaunch();
      return;
    }
    markIntentLaunchHandled();
    try {
      // Back to the root so no task screen sits behind the sheet, then open it.
      if (router.canDismiss()) router.dismissAll();
      router.push('/capture');
    } catch {
      dropIntentLaunch();
    }
  }, [pendingOpen, gate.status, navKey, router]);

  return null;
}
