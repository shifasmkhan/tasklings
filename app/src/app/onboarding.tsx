import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import { armCaptureLaunch } from '@/features/capture/captureLaunch';
import { OnboardingFlow } from '@/features/onboarding/OnboardingFlow';

export default function OnboardingRoute() {
  const router = useRouter();
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
      returnKey={returnKey}
      nav={{
        openCapture: () => {
          armCaptureLaunch({ autoStart: true, firstNoteHint: true });
          router.push('/capture');
        },
        goToday: () => router.replace('/'),
      }}
    />
  );
}
