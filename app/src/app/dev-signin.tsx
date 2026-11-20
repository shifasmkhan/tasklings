import { useRouter } from 'expo-router';

import { DevSignInScreen } from '@/features/auth/DevSignInScreen';

export default function DevSignInRoute() {
  const router = useRouter();
  return <DevSignInScreen onSignedIn={() => router.back()} />;
}
