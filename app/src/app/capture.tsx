import { useLocalSearchParams, useRouter } from 'expo-router';

import { CaptureSheet, COPY } from '@/features/capture/CaptureSheet';

export default function CaptureRoute() {
  const router = useRouter();
  const { start, hint } = useLocalSearchParams<{ start?: string; hint?: string }>();
  return <CaptureSheet onClose={() => router.back()} startLocked={start === 'lock'} hint={hint === 'first' ? COPY.firstNoteHint : undefined} />;
}
