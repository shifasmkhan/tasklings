import { useRouter } from 'expo-router';

import { SettingsScreen } from '@/features/settings/SettingsScreen';

export default function SettingsRoute() {
  const router = useRouter();
  return (
    <SettingsScreen
      // The account and its session are gone. There is no onboarding route yet, so the signed-out
      // state is Today on a fresh account.
      // TODO(US-19): send the person to first-run onboarding / Sign in with Apple instead.
      onAccountDeleted={() => router.dismissAll()}
    />
  );
}
