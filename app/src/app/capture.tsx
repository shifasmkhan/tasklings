import { useRouter } from 'expo-router';

import { Placeholder } from '@/components/Placeholder';

export default function CaptureRoute() {
  const router = useRouter();
  return (
    <Placeholder
      title="Capture"
      story="US-01 · US-02 · placeholder"
      body="Hold to talk, or tap to lock recording. Voice and text capture arrive with US-01 and US-02."
      onClose={() => router.back()}
    />
  );
}
