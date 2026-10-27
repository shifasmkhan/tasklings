import type { IsoDate, Task, TaskKind } from './types';
import { addDays } from '@/lib/dates';

// Synthetic fixtures only. No real people, places or personal data.

export const MOCK_USER_ID = '00000000-0000-4000-8000-000000000001';

interface Seed {
  id: string;
  kind: TaskKind;
  title: string;
  effort: number;
  carry: number;
  dueOffset: number | null;
  needsReview?: boolean;
}

const SEEDS: Seed[] = [
  { id: 'q1', kind: 'quick', title: 'Call the dentist to move the cleaning', effort: 5, carry: 0, dueOffset: null },
  { id: 'q2', kind: 'quick', title: 'Reply to the building manager about the fence', effort: 10, carry: 1, dueOffset: null },
  { id: 'q3', kind: 'quick', title: 'Pay the water bill', effort: 5, carry: 0, dueOffset: 0 },
  { id: 'e1', kind: 'errand', title: 'Return the package at the post office', effort: 20, carry: 0, dueOffset: 0 },
  { id: 'e2', kind: 'errand', title: 'Pick up dry cleaning', effort: 15, carry: 2, dueOffset: null },
  { id: 'b1', kind: 'project', title: 'Renew passport', effort: 60, carry: 0, dueOffset: null },
  // Synthetic extraction fallback: the whole (fake) transcript saved as one task, flagged for review.
  {
    id: 'r1',
    kind: 'quick',
    title: 'Buy stamps, book the vet, email Sam about the invoice',
    effort: 15,
    carry: 0,
    dueOffset: null,
    needsReview: true,
  },
];

function uuidFor(seedId: string): string {
  const hex = Array.from(seedId)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .padStart(12, '0')
    .slice(-12);
  return `00000000-0000-4000-8000-${hex}`;
}

export function makeTask(
  overrides: Partial<Task> & Pick<Task, 'id' | 'title' | 'kind'>,
  today: IsoDate,
): Task {
  const carry = overrides.carry_count ?? 0;
  const effort = overrides.effort_min ?? 10;
  return {
    user_id: MOCK_USER_ID,
    capture_id: null,
    notes: null,
    effort_min: effort,
    effort_min_initial: effort,
    due_date: null,
    status: 'open',
    first_planned_for: addDays(today, -carry),
    planned_for: today,
    carry_count: carry,
    completed_at: null,
    dropped_reason: null,
    script: null,
    needs_review: false,
    sort_order: 0,
    created_at: `${addDays(today, -carry)}T08:00:00.000Z`,
    updated_at: `${today}T08:00:00.000Z`,
    ...overrides,
  };
}

export function seedTasks(today: IsoDate): Task[] {
  return SEEDS.map((s, i) =>
    makeTask(
      {
        id: uuidFor(s.id),
        kind: s.kind,
        title: s.title,
        effort_min: s.effort,
        carry_count: s.carry,
        due_date: s.dueOffset === null ? null : addDays(today, s.dueOffset),
        needs_review: s.needsReview ?? false,
        sort_order: i,
      },
      today,
    ),
  );
}
