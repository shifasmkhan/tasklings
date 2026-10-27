import type { IsoDate, Task, TaskKind } from '@/api/types';

export const GROUP_ORDER: readonly TaskKind[] = ['quick', 'errand', 'project'];

export const GROUP_LABELS: Record<TaskKind, { title: string; subtitle: string; startLabel: string }> = {
  quick: { title: 'Quick wins', subtitle: 'Calls, texts, payments', startLabel: 'Quick win' },
  errand: { title: 'Errands', subtitle: 'Out of the house', startLabel: 'Errand' },
  project: { title: 'Bigger things', subtitle: 'Broken into steps', startLabel: 'Bigger thing' },
};

/** Due today, or overdue: both count as "due today" for the Start here rule. */
export function isDueByToday(task: Task, today: IsoDate): boolean {
  return task.due_date !== null && task.due_date <= today;
}

/**
 * Fixed Start here ordering (US-04, no model call):
 * 1. due today (or overdue) first, 2. most carried over, 3. shortest effort.
 * Ties fall back to sort_order then id so the pick is deterministic.
 */
export function compareForStart(a: Task, b: Task, today: IsoDate): number {
  const dueA = isDueByToday(a, today) ? 1 : 0;
  const dueB = isDueByToday(b, today) ? 1 : 0;
  if (dueA !== dueB) return dueB - dueA;
  if (a.carry_count !== b.carry_count) return b.carry_count - a.carry_count;
  if (a.effort_min !== b.effort_min) return a.effort_min - b.effort_min;
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Picks the Start here task from open tasks. Tasks the user skipped this session are
 * passed over; once every task has been skipped, the rule starts again from the top.
 */
export function pickStartHere(
  open: readonly Task[],
  today: IsoDate,
  skippedIds: ReadonlySet<string> = new Set(),
): Task | null {
  const candidates = open.filter((t) => t.status === 'open');
  if (candidates.length === 0) return null;
  const ranked = [...candidates].sort((a, b) => compareForStart(a, b, today));
  return ranked.find((t) => !skippedIds.has(t.id)) ?? ranked[0] ?? null;
}

export interface TaskGroup {
  kind: TaskKind;
  title: string;
  subtitle: string;
  tasks: Task[];
}

/**
 * Groups open tasks into Quick wins, Errands and Bigger things, in that order,
 * each sorted by sort_order (matching the today_tasks ORDER BY kind, sort_order).
 * The Start here task is left out of its group so it shows once. Empty groups are dropped.
 */
export function groupTasks(open: readonly Task[], excludeId: string | null = null): TaskGroup[] {
  return GROUP_ORDER.map((kind) => ({
    kind,
    title: GROUP_LABELS[kind].title,
    subtitle: GROUP_LABELS[kind].subtitle,
    tasks: open
      .filter((t) => t.kind === kind && t.status === 'open' && t.id !== excludeId)
      .sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1)),
  })).filter((g) => g.tasks.length > 0);
}

export interface TodaySummary {
  left: number;
  done: number;
  totalMinutes: number;
  /** 0 to 1. */
  progress: number;
  counts: Record<TaskKind, number>;
}

export function summarize(open: readonly Task[], doneCount: number): TodaySummary {
  const counts: Record<TaskKind, number> = { quick: 0, errand: 0, project: 0 };
  let totalMinutes = 0;
  for (const t of open) {
    counts[t.kind] += 1;
    totalMinutes += t.effort_min;
  }
  const total = open.length + doneCount;
  return {
    left: open.length,
    done: doneCount,
    totalMinutes,
    progress: total === 0 ? 0 : doneCount / total,
    counts,
  };
}

/** "5 min", "1 hr", "1 hr 30 min". */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/** Quiet carried-over label: "Day 2" on the first carry. Null when not carried. */
export function carriedLabel(task: Task): string | null {
  return task.carry_count > 0 ? `Day ${task.carry_count + 1}` : null;
}

/** Quiet row label for a task the extractor couldn't split (needs_review). Never prompts. */
export const NEEDS_REVIEW_LABEL = 'Needs a look';
export const NEEDS_REVIEW_CARD_TEXT = 'We saved one note as a single task. Tap to fix.';

/** The task the passive review card points at: the first needs-review task in list order. */
export function firstNeedingReview(tasks: Task[]): Task | null {
  return tasks.find((t) => t.needs_review) ?? null;
}

export function taskMeta(task: Task, today: IsoDate): string {
  const parts = [formatMinutes(task.effort_min)];
  if (task.due_date !== null) {
    if (task.due_date === today) parts.push('Due today');
    else if (task.due_date < today) parts.push('Overdue');
  }
  return parts.join(' · ');
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
