import { useLocalSearchParams, useRouter } from 'expo-router';

import { TaskDetailScreen } from '@/features/task/TaskDetailScreen';

export default function TaskDetailRoute() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  return <TaskDetailScreen taskId={id ?? ''} onBack={() => router.back()} />;
}
