import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import { SettingsScreen } from '@/features/settings/SettingsScreen';
import { useOnboardingGate } from '@/features/onboarding/OnboardingProvider';

export default function SettingsRoute() {
  const router = useRouter();
  const gate = useOnboardingGate();
  // Bumped each time Settings regains focus after another screen (the dev sign-in) closed, so it
  // re-reads who is signed in. The first focus is the screen appearing, not a return.
  const [focusKey, setFocusKey] = useState(0);
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      setFocusKey((k) => k + 1);
    }, []),
  );
  return (
    <SettingsScreen
      focusKey={focusKey}
      onOpenDevSignIn={() => router.push('/dev-signin')}
      // The account and its session are gone: close Settings, then clear the first-run flag so the
      // gate on Today sends the person back through onboarding (US-19).
      onAccountDeleted={() => {
        router.dismissAll();
        void gate.reset();
      }}
    />
  );
}
