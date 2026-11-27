import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import { armCaptureLaunch } from '@/features/capture/captureLaunch';
import { consumeSignInLaunch } from '@/features/onboarding/signInLaunch';
import { OnboardingFlow } from '@/features/onboarding/OnboardingFlow';

export default function OnboardingRoute() {
  const router = useRouter();
  // Opened from Today's signed-out card: show only the Sign in step, then go back to Today.
  const [signInOnly] = useState(consumeSignInLaunch);
  // Bumped when this screen regains focus after the Capture sheet closes; the flow then checks
  // whether a note was saved. The first focus is the screen appearing, not a return.
  const [returnKey, setReturnKey] = useState(0);
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      setReturnKey((k) => k + 1);
    }, []),
  );
  return (
    <OnboardingFlow
      signInOnly={signInOnly}
      returnKey={returnKey}
      nav={{
        openCapture: () => {
          armCaptureLaunch({ autoStart: true, firstNoteHint: true });
          router.push('/capture');
        },
        // Re-sign-in from Today: go back to it (it reloads on focus). First run: replace onboarding.
        goToday: () => (signInOnly && router.canGoBack() ? router.back() : router.replace('/')),
      }}
    />
  );
}
