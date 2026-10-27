import { useLocalSearchParams, useRouter } from 'expo-router';

import { Placeholder } from '@/components/Placeholder';

export default function TaskDetailRoute() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <Placeholder
      title="Task detail"
      story="US-05 · placeholder"
      body={`Inline editing of title, kind, effort and due date arrives with US-05. Task ${id ?? ''}`.trim()}
      onClose={() => router.back()}
      closeLabel="Back to Today"
    />
  );
}
