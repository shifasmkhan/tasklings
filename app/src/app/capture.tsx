import { useRouter } from 'expo-router';

import { CaptureSheet } from '@/features/capture/CaptureSheet';

export default function CaptureRoute() {
  const router = useRouter();
  return <CaptureSheet onClose={() => router.back()} />;
}
