import { useRouter } from 'expo-router';

import { CheckInScreen } from '@/features/checkin/CheckInScreen';

export default function CheckInRoute() {
  const router = useRouter();
  return <CheckInScreen onClose={() => router.back()} />;
}
