import type { DroppedReason, IsoDate, Task } from '@/api/types';
import { formatClockTime } from '@/lib/dates';
import { isDueByToday } from '@/features/today/logic';

/** Most cards one check-in shows (US-07). */
export const MAX_CARDS = 7;
/** A task carried this many times gets a "Still need this?" card (US-12). Matches Stale in the PRD. */
export const STALE_CARRY_COUNT = 5;
/** Pixels of horizontal drag that count as a swipe. */
export const SWIPE_THRESHOLD = 110;

export function isStale(task: Task): boolean {
  return task.carry_count >= STALE_CARRY_COUNT;
}

/** 0 = still-need-this, 1 = due today (or overdue), 2 = the rest. */
function rank(task: Task, today: IsoDate): number {
  if (isStale(task)) return 0;
  return isDueByToday(task, today) ? 1 : 2;
}

export interface CheckInStack {
  cards: Task[];
  /** Open tasks past the cap. They roll over on their own tonight. */
  rolledOver: number;
}

/**
 * One card per open task, capped at 7. Order: still-need-this first, then due today, then the
 * most carried. Ties fall back to sort_order then id so the order is stable.
 */
export function buildStack(open: readonly Task[], today: IsoDate): CheckInStack {
  const ranked = open
    .filter((t) => t.status === 'open')
    .sort(
      (a, b) =>
        rank(a, today) - rank(b, today) ||
        b.carry_count - a.carry_count ||
        a.sort_order - b.sort_order ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  return { cards: ranked.slice(0, MAX_CARDS), rolledOver: Math.max(0, ranked.length - MAX_CARDS) };
}

export interface DropChoice {
  label: string;
  /** Null for Skip: the task is dropped with no reason. */
  reason: DroppedReason | null;
}

export const DROP_CHOICES: readonly DropChoice[] = [
  { label: 'Not needed', reason: 'not_needed' },
  { label: 'Done elsewhere', reason: 'done_elsewhere' },
  { label: 'Obsolete', reason: 'obsolete' },
  { label: 'Skip', reason: null },
];

export interface CheckInCounts {
  done: number;
  tomorrow: number;
  dropped: number;
}

export function briefLine(briefTime: string | null): string | null {
  return briefTime === null ? null : `Your brief will be ready at ${formatClockTime(briefTime)}.`;
}

/** `briefTime` is the profile's brief_time as "HH:MM"; when it couldn't be read the line is left out. */
export function summaryLines(counts: CheckInCounts, rolledOver: number, briefTime: string | null): string[] {
  const lines = [`${counts.done} done, ${counts.tomorrow} moved to tomorrow, ${counts.dropped} dropped.`];
  if (rolledOver > 0) lines.push(`${rolledOver} more rolled over on their own.`);
  const brief = briefLine(briefTime);
  if (brief) lines.push(brief);
  return lines;
}


export function swipeAction(dx: number): 'done' | 'tomorrow' | null {
  if (dx >= SWIPE_THRESHOLD) return 'done';
  if (dx <= -SWIPE_THRESHOLD) return 'tomorrow';
  return null;
}


/** Shown under the card stack when tasks went past the cap. */
export function moreMovedText(rolledOver: number): string {
  return `and ${rolledOver} more moved to tomorrow`;
}
