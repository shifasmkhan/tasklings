// US-03 scoring rubric. See ai/README.md ("Scoring rubric") for the prose version.
//
// A produced task is correct when it matches an expected task on all four checks:
//   meaning     - model-graded (grader.ts, fixed prompt) or lexical offline
//   kind        - exact
//   due_date    - exact (both null counts as a match)
//   effort band - same band: <=10, 11-30, 31-90, >90 minutes
// Produced tasks are paired with expected tasks by an optimal one-to-one
// assignment over meaning-equivalent pairs (see matchTasks).

import type { ExtractedTask } from "../src/extraction/schema.ts";

export const TARGET_ACCURACY = 0.9;

export const EFFORT_BANDS = [
  { id: "<=10", max: 10 },
  { id: "11-30", max: 30 },
  { id: "31-90", max: 90 },
  { id: ">90", max: Number.POSITIVE_INFINITY },
] as const;

export type EffortBand = (typeof EFFORT_BANDS)[number]["id"];

export function effortBand(minutes: number): EffortBand {
  for (const b of EFFORT_BANDS) if (minutes <= b.max) return b.id;
  return ">90";
}

/** meaning[i][j] is true when expected[i] and produced[j] describe the same action. */
export type MeaningMatrix = boolean[][];

export interface MeaningJudge {
  readonly name: string;
  judge(args: { transcript: string; expected: ExtractedTask[]; produced: ExtractedTask[] }): Promise<MeaningMatrix>;
}

export interface FieldChecks {
  kind: boolean;
  due_date: boolean;
  effort_band: boolean;
}

export interface MatchedPair {
  expected: number;
  produced: number;
  checks: FieldChecks;
  correct: boolean;
}

export function fieldChecks(e: ExtractedTask, p: ExtractedTask): FieldChecks {
  return {
    kind: e.kind === p.kind,
    due_date: e.due_date === p.due_date,
    effort_band: effortBand(e.effort_min) === effortBand(p.effort_min),
  };
}

/**
 * Optimal one-to-one matching. Only meaning-equivalent pairs may match. Among
 * all matchings it maximises (1) the number of matched pairs, then (2) the
 * number of passing field checks, then prefers lower indices, so results are
 * deterministic. Exact DP over subsets of produced tasks (both lists are <= 10
 * by contract; larger inputs are rejected).
 */
export function matchTasks(expected: ExtractedTask[], produced: ExtractedTask[], meaning: MeaningMatrix): MatchedPair[] {
  const n = expected.length;
  const m = produced.length;
  if (n > 12 || m > 12) throw new RangeError("matchTasks supports at most 12 tasks per side");
  const weight = (i: number, j: number): number => {
    if (!meaning[i]?.[j]) return -1;
    const c = fieldChecks(expected[i]!, produced[j]!);
    return 100 + Number(c.kind) + Number(c.due_date) + Number(c.effort_band);
  };
  // best[i][mask] = best total weight assigning expected[i..] given produced tasks in mask are used.
  const memo = new Map<number, { w: number; j: number }>();
  const solve = (i: number, mask: number): { w: number; j: number } => {
    if (i === n) return { w: 0, j: -1 };
    const key = i * 8192 + mask;
    const hit = memo.get(key);
    if (hit) return hit;
    let best = { w: solve(i + 1, mask).w, j: -1 }; // leave expected[i] unmatched
    for (let j = 0; j < m; j++) {
      if (mask & (1 << j)) continue;
      const w = weight(i, j);
      if (w < 0) continue;
      const total = w + solve(i + 1, mask | (1 << j)).w;
      if (total > best.w) best = { w: total, j };
    }
    memo.set(key, best);
    return best;
  };
  const pairs: MatchedPair[] = [];
  let mask = 0;
  for (let i = 0; i < n; i++) {
    const { j } = solve(i, mask);
    if (j >= 0) {
      const checks = fieldChecks(expected[i]!, produced[j]!);
      pairs.push({ expected: i, produced: j, checks, correct: checks.kind && checks.due_date && checks.effort_band });
      mask |= 1 << j;
    }
  }
  return pairs;
}

export interface NoteScore {
  id: string;
  expected_count: number;
  produced_count: number;
  matched: number;
  correct: number;
  missed: number;
  extra: number;
  /** Scoring units: expected + extra, or 1 for a correctly empty note. */
  units: number;
  correct_units: number;
  /** Matched pairs passing each exact check. */
  field_hits: { kind: number; due_date: number; effort_band: number };
  pairs: MatchedPair[];
  /** True when every expected task is correct and nothing extra was produced. */
  exact: boolean;
}

/**
 * Scores one note. `produced` must be the extracted tasks only: pass [] when
 * the pipeline fell back (the fixed review task is not an extraction) and set
 * `fellBack`. A correct empty result ({"tasks":[]} for a note with no tasks)
 * is one correct unit; every invented task is an extra. A fallback is never a
 * correct empty result: on a note with no tasks it saves a review task nobody
 * asked for, so it scores as one extra.
 */
export function scoreNote(
  id: string,
  expected: ExtractedTask[],
  produced: ExtractedTask[],
  meaning: MeaningMatrix,
  opts: { fellBack?: boolean } = {},
): NoteScore {
  const pairs = matchTasks(expected, produced, meaning);
  const correct = pairs.filter((p) => p.correct).length;
  const fallbackExtra = opts.fellBack && expected.length === 0 ? 1 : 0;
  const extra = produced.length - pairs.length + fallbackExtra;
  const missed = expected.length - pairs.length;
  const emptyAndRight = expected.length === 0 && produced.length === 0 && !opts.fellBack;
  const units = emptyAndRight ? 1 : expected.length + extra;
  const correct_units = emptyAndRight ? 1 : correct;
  return {
    id,
    expected_count: expected.length,
    produced_count: produced.length + fallbackExtra,
    matched: pairs.length,
    correct,
    missed,
    extra,
    units,
    correct_units,
    field_hits: {
      kind: pairs.filter((p) => p.checks.kind).length,
      due_date: pairs.filter((p) => p.checks.due_date).length,
      effort_band: pairs.filter((p) => p.checks.effort_band).length,
    },
    pairs,
    exact: correct_units === units,
  };
}

export interface Breakdown {
  /** correct units / total units: the US-03 headline number (target 0.9). */
  accuracy: number;
  meets_target: boolean;
  target: number;
  notes: number;
  notes_exact: number;
  expected_tasks: number;
  produced_tasks: number;
  correct_tasks: number;
  missed_tasks: number;
  extra_tasks: number;
  /** Share of expected tasks with a meaning match. */
  meaning_recall: number;
  /** Share of produced tasks with a meaning match. */
  meaning_precision: number;
  /** Among meaning-matched pairs, share passing each exact check. */
  kind: number;
  due_date: number;
  effort_band: number;
}

const ratio = (a: number, b: number): number => (b === 0 ? 1 : a / b);

export function aggregate(scores: NoteScore[], target = TARGET_ACCURACY): Breakdown {
  const sum = (f: (s: NoteScore) => number) => scores.reduce((acc, s) => acc + f(s), 0);
  const units = sum((s) => s.units);
  const matched = sum((s) => s.matched);
  const accuracy = ratio(sum((s) => s.correct_units), units);
  return {
    accuracy,
    meets_target: accuracy >= target,
    target,
    notes: scores.length,
    notes_exact: scores.filter((s) => s.exact).length,
    expected_tasks: sum((s) => s.expected_count),
    produced_tasks: sum((s) => s.produced_count),
    correct_tasks: sum((s) => s.correct),
    missed_tasks: sum((s) => s.missed),
    extra_tasks: sum((s) => s.extra),
    meaning_recall: ratio(matched, sum((s) => s.expected_count)),
    meaning_precision: ratio(matched, sum((s) => s.produced_count)),
    kind: ratio(sum((s) => s.field_hits.kind), matched),
    due_date: ratio(sum((s) => s.field_hits.due_date), matched),
    effort_band: ratio(sum((s) => s.field_hits.effort_band), matched),
  };
}

// ---------------------------------------------------------------------------
// Offline meaning judge (dry runs and unit tests only). It is deliberately
// simple and is NOT a substitute for the model-graded check in live runs.

const STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "of", "and", "or", "on", "in", "at", "my", "with", "about", "up", "from", "by", "her",
  "his", "their", "our", "your", "some", "this", "that", "it",
]);

export function normalizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
}

export function lexicalSimilarity(a: string, b: string): number {
  const x = new Set(normalizeTitle(a));
  const y = new Set(normalizeTitle(b));
  if (x.size === 0 && y.size === 0) return 1;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

export class LexicalJudge implements MeaningJudge {
  readonly name = "lexical-jaccard";
  readonly threshold: number;
  constructor(threshold = 0.5) {
    this.threshold = threshold;
  }
  judge(args: { expected: ExtractedTask[]; produced: ExtractedTask[] }): Promise<MeaningMatrix> {
    return Promise.resolve(
      args.expected.map((e) => args.produced.map((p) => lexicalSimilarity(e.title, p.title) >= this.threshold)),
    );
  }
}
