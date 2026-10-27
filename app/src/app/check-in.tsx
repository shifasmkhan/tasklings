import { useRouter } from 'expo-router';

import { Placeholder } from '@/components/Placeholder';

export default function CheckInRoute() {
  const router = useRouter();
  return (
    <Placeholder
      title="Evening check-in"
      story="US-07 · placeholder"
      body="Up to 7 cards with Done, Tomorrow and Drop, then a summary. Arrives with US-07."
      onClose={() => router.back()}
    />
  );
}
