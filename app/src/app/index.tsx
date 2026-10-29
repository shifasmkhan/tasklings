import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import { View } from 'react-native';

import { useOnboardingGate } from '@/features/onboarding/OnboardingProvider';
import { usePalette } from '@/theme/colors';
import { TodayScreen } from '@/features/today/TodayScreen';

/** First-run gate: no onboarding_complete flag means onboarding (US-19). Today isn't mounted until it's done. */
export default function TodayRoute() {
  const gate = useOnboardingGate();
  const p = usePalette();
  if (gate.status === 'loading') return <View style={{ flex: 1, backgroundColor: p.background }} />;
  if (gate.status === 'needed') return <Redirect href="/onboarding" />;
  return <TodayContent />;
}

function TodayContent() {
  const gate = useOnboardingGate();
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
        onTitleLongPress: __DEV__ ? () => void gate.reset() : undefined,
      }}
    />
  );
}
