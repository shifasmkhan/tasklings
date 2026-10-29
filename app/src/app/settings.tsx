import { useRouter } from 'expo-router';

import { SettingsScreen } from '@/features/settings/SettingsScreen';
import { useOnboardingGate } from '@/features/onboarding/OnboardingProvider';

export default function SettingsRoute() {
  const router = useRouter();
  const gate = useOnboardingGate();
  return (
    <SettingsScreen
      // The account and its session are gone: close Settings, then clear the first-run flag so the
      // gate on Today sends the person back through onboarding (US-19).
      onAccountDeleted={() => {
        router.dismissAll();
        void gate.reset();
      }}
    />
  );
}
