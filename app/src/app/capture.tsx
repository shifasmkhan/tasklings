import { useLocalSearchParams, useRouter } from 'expo-router';

import { CaptureSheet } from '@/features/capture/CaptureSheet';

export default function CaptureRoute() {
  const router = useRouter();
  const { start } = useLocalSearchParams<{ start?: string }>();
  return <CaptureSheet onClose={() => router.back()} startLocked={start === 'lock'} />;
}
