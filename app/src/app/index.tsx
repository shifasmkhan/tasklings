import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import { TodayScreen } from '@/features/today/TodayScreen';

export default function TodayRoute() {
  const router = useRouter();
  // Reload when Today comes back into focus (from Task detail or the check-in), so edits and
  // actions made there show at once. The first focus is the initial load, which Today already does.
  const [refreshKey, setRefreshKey] = useState(0);
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      setRefreshKey((k) => k + 1);
    }, []),
  );
  return (
    <TodayScreen
      refreshKey={refreshKey}
      nav={{
        openCapture: (options) =>
          router.push(options?.startLocked ? { pathname: '/capture', params: { start: 'lock' } } : '/capture'),
        // Only the ID goes in the URL: task titles never leave the in-memory state.
        openTask: (task) => router.push({ pathname: '/task/[id]', params: { id: task.id } }),
        openCheckIn: () => router.push('/check-in'),
        openSettings: () => router.push('/settings'),
      }}
    />
  );
}
