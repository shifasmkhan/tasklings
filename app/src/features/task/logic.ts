import type { IsoDate, Task, TaskKind } from '@/api/types';
import { addDays } from '@/lib/dates';
import { formatMinutes, GROUP_LABELS } from '@/features/today/logic';

export const TITLE_MAX = 60;
/** Pause after the last keystroke before the title saves by itself. */
export const AUTOSAVE_DELAY_MS = 800;

export const KIND_OPTIONS: readonly TaskKind[] = ['quick', 'errand', 'project'];

export function kindLabel(kind: TaskKind): string {
  return GROUP_LABELS[kind].startLabel;
}

const EFFORT_CHOICES = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240] as const;

/** The effort menu: the usual steps, plus the current value when it isn't one of them. */
export function effortOptions(current: number): number[] {
  return [...new Set<number>([...EFFORT_CHOICES, current])].sort((a, b) => a - b);
}

export interface DueOption {
  label: string;
  value: IsoDate | null;
}

/** The due-date menu. Relative choices only: there is no calendar dependency yet. */
export function dueOptions(today: IsoDate): DueOption[] {
  return [
    { label: 'Today', value: today },
    { label: 'Tomorrow', value: addDays(today, 1) },
    { label: 'In 3 days', value: addDays(today, 3) },
    { label: 'Next week', value: addDays(today, 7) },
    { label: 'No due date', value: null },
  ];
}

export function dueChipLabel(due: IsoDate | null, today: IsoDate): string {
  if (due === null) return 'No due date';
  if (due === today) return 'Due today';
  if (due === addDays(today, 1)) return 'Due tomorrow';
  const [y, m, d] = due.split('-').map(Number) as [number, number, number];
  const text = new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return due < today ? `Overdue · ${text}` : `Due ${text}`;
}

export function effortChipLabel(minutes: number): string {
  return formatMinutes(minutes);
}

/** Only these three kinds of "Found for you" are allowed: Apple Maps phone, address and hours. */
export type EnrichmentType = 'phone' | 'address' | 'hours';
export interface Enrichment {
  type: EnrichmentType;
  value: string;
}

export const ENRICHMENT_LABELS: Record<EnrichmentType, string> = {
  phone: 'Phone',
  address: 'Address',
  hours: 'Hours',
};

/** Drops anything that isn't a Maps phone, address or hours (urls and notes never show). */
export function allowedEnrichments(items: readonly { type: string; value: string }[]): Enrichment[] {
  return items.filter(
    (e): e is Enrichment => (e.type === 'phone' || e.type === 'address' || e.type === 'hours') && e.value.trim() !== '',
  );
}

/** A script card shows for call and message tasks (quick wins) and only when a script exists. */
export function showsScript(task: Task): boolean {
  return task.kind === 'quick' && task.script !== null && task.script.trim() !== '';
}
