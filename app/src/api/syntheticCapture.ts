import type { IsoDate, TaskKind } from './types';

// Synthetic extraction for the mock backend. It stands in for the Claude call so tests and demos
// get realistic results without a network. Rules are keyword based, on purpose: easy to predict.
//
//   transcript contains "nothing to add", "never mind" or "thinking out loud"  -> zero tasks
//   transcript contains "garbled", "fallback" or "mumbling"                    -> one needs_review task
//   anything else -> one task per clause (split on . , ; "and" "then" "also"), at most 10
//
// Titles are user content: callers keep them in memory only and never log them.

export interface SyntheticTask {
  title: string;
  kind: TaskKind;
  effort_min: number;
  due_date: IsoDate | null;
}

export type SyntheticOutcome =
  | { type: 'tasks'; tasks: SyntheticTask[] }
  | { type: 'empty' }
  | { type: 'fallback'; task: SyntheticTask };

const EMPTY_KEYWORDS = ['nothing to add', 'never mind', 'nevermind', 'thinking out loud'];
const FALLBACK_KEYWORDS = ['garbled', 'fallback', 'mumbling'];
const MAX_TASKS = 10;
const MAX_TITLE = 60;

const KIND_WORDS: Record<TaskKind, RegExp> = {
  quick: /\b(call|text|email|reply|pay|book|message|send|schedule|cancel)\b/,
  errand: /\b(buy|pick up|pickup|return|drop off|post office|grocer|store|pharmacy|stamps)\b/,
  project: /\b(plan|renew|organi[sz]e|clean out|write|build|sort the|set up|research)\b/,
};
const EFFORT: Record<TaskKind, number> = { quick: 5, errand: 20, project: 60 };
const LEADING_FILLER = /^(?:(?:um+|uh+|so|okay|ok|also|and|then|i need to|i have to|i should|i want to|remember to|don'?t forget to|need to|to)\s+)+/i;

function kindFor(clause: string): TaskKind {
  const lower = clause.toLowerCase();
  // Project words win: "plan the trip" shouldn't read as a quick call.
  if (KIND_WORDS.project.test(lower)) return 'project';
  if (KIND_WORDS.quick.test(lower)) return 'quick';
  if (KIND_WORDS.errand.test(lower)) return 'errand';
  return 'quick';
}

/** Titles never contain links, emails, phone numbers or hidden characters (PRD). */
export function sanitizeTitle(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/g, '')
    .replace(/\S+@\S+/g, '')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/\+?\d[\d\s().-]{5,}\d/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= MAX_TITLE) return cleaned;
  const cut = cleaned.slice(0, MAX_TITLE - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function dueFor(clause: string, today: IsoDate, tomorrow: IsoDate): IsoDate | null {
  const lower = clause.toLowerCase();
  if (/\btoday\b/.test(lower)) return today;
  if (/\btomorrow\b/.test(lower)) return tomorrow;
  return null;
}

export function synthesizeCapture(transcript: string, today: IsoDate, tomorrow: IsoDate): SyntheticOutcome {
  const lower = transcript.toLowerCase();
  if (EMPTY_KEYWORDS.some((k) => lower.includes(k))) return { type: 'empty' };

  if (FALLBACK_KEYWORDS.some((k) => lower.includes(k))) {
    const title = sanitizeTitle(transcript) || 'Review this note';
    return { type: 'fallback', task: { title, kind: 'quick', effort_min: 15, due_date: null } };
  }

  const tasks: SyntheticTask[] = [];
  for (const raw of transcript.split(/[.;,!?]+|\band\b|\bthen\b|\balso\b/i)) {
    const clause = raw.replace(LEADING_FILLER, '').trim();
    if (clause.split(/\s+/).filter(Boolean).length < 2) continue;
    const title = sanitizeTitle(clause.charAt(0).toUpperCase() + clause.slice(1));
    if (!title) continue;
    const kind = kindFor(clause);
    tasks.push({ title, kind, effort_min: EFFORT[kind], due_date: dueFor(clause, today, tomorrow) });
    if (tasks.length === MAX_TASKS) break;
  }
  return tasks.length === 0 ? { type: 'empty' } : { type: 'tasks', tasks };
}
