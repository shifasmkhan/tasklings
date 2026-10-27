import { useRouter } from 'expo-router';

import { TodayScreen } from '@/features/today/TodayScreen';

export default function TodayRoute() {
  const router = useRouter();
  return (
    <TodayScreen
      nav={{
        openCapture: () => router.push('/capture'),
        // Only the ID goes in the URL: task titles never leave the in-memory state.
        openTask: (task) => router.push({ pathname: '/task/[id]', params: { id: task.id } }),
        openCheckIn: () => router.push('/check-in'),
      }}
    />
  );
}
