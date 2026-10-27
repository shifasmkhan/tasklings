// Runs the note and injection sets through the real extraction pipeline
// (extractTasks: prompt -> model -> validator -> retry -> fallback) and builds
// a scorecard. Model access is injected, so the same code serves live runs
// (Anthropic SDK) and offline dry runs (canned outputs).

import type { ExtractionResult, ModelClient } from "../src/extraction/extract.ts";
import { extractTasks } from "../src/extraction/extract.ts";
import { PROMPT_VERSION } from "../src/extraction/prompt.ts";
import type { ExtractedTask } from "../src/extraction/schema.ts";
import { capturedAtFor } from "./datasets.ts";
import type { InjectionResult } from "./injection.ts";
import { checkInjection } from "./injection.ts";
import type { Breakdown, MeaningJudge, NoteScore } from "./scoring.ts";
import { aggregate, scoreNote } from "./scoring.ts";
import type { InjectionCase, NoteCase } from "./types.ts";

export interface CaseRecord {
  id: string;
  set: "notes" | "injection";
  status: ExtractionResult["status"];
  fallback_reason?: string;
  attempts: ExtractionResult["attempts"];
  produced: ExtractedTask[];
  expected: ExtractedTask[];
  score?: NoteScore;
  injection?: InjectionResult;
  error?: string;
}

export interface RunOptions {
  clientFor: (c: NoteCase) => ModelClient;
  judge: MeaningJudge;
  concurrency: number;
  keepRaw: boolean;
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Tasks to score: the fallback review task is not an extraction, so it scores as nothing produced. */
function extracted(result: ExtractionResult): ExtractedTask[] {
  return result.status === "ok" ? result.tasks : [];
}

async function runCase(c: NoteCase | InjectionCase, set: "notes" | "injection", opts: RunOptions): Promise<CaseRecord> {
  const result = await extractTasks(
    { transcript: c.transcript, capturedAt: capturedAtFor(c.today, c.time_zone), timeZone: c.time_zone },
    opts.clientFor(c),
    { keepRaw: opts.keepRaw },
  );
  const produced = extracted(result);
  const record: CaseRecord = {
    id: c.id,
    set,
    status: result.status,
    attempts: result.attempts,
    produced: result.tasks,
    expected: c.expected,
  };
  if (result.status === "fallback") record.fallback_reason = result.reason;
  try {
    const meaning = await opts.judge.judge({ transcript: c.transcript, expected: c.expected, produced });
    record.score = scoreNote(c.id, c.expected, produced, meaning);
    if (set === "injection") record.injection = checkInjection(c as InjectionCase, result, meaning);
  } catch {
    record.error = "grader_error";
    // Count a grader failure as fully wrong so it can't inflate accuracy.
    record.score = scoreNote(c.id, c.expected, produced, c.expected.map(() => produced.map(() => false)));
    if (set === "injection") {
      const inj = checkInjection(c as InjectionCase, result, c.expected.map(() => produced.map(() => false)));
      record.injection = { ...inj, pass: false };
    }
  }
  return record;
}

export async function runSet(cases: Array<NoteCase | InjectionCase>, set: "notes" | "injection", opts: RunOptions): Promise<CaseRecord[]> {
  return pool(cases, opts.concurrency, (c) => runCase(c, set, opts));
}

export interface Scorecard {
  run: {
    id: string;
    mode: "live" | "dry-run";
    started_at: string;
    finished_at: string;
    model: string;
    grader: string;
    prompt_version: string;
    datasets: Record<string, string>;
  };
  accuracy: Breakdown | null;
  by_tag: Record<string, { notes: number; accuracy: number }>;
  schema: {
    attempts: number;
    /** Attempts rejected for any reason, including a deliberate {"tasks":[]} and model errors. */
    invalid_attempts: number;
    /** Attempts rejected for breaking the format: excludes a lone no_tasks and model errors. */
    schema_violations: number;
    first_attempt_invalid: number;
    violations_by_code: Record<string, number>;
    fallbacks_by_reason: Record<string, number>;
    model_errors: number;
  };
  injection: {
    total: number;
    passed: number;
    all_pass: boolean;
    fallbacks: number;
    first_attempt_invalid: number;
    failures: Array<Pick<InjectionResult, "id" | "category" | "forbidden_hits" | "unfaithful_tasks" | "final_schema_valid">>;
    results: InjectionResult[];
  } | null;
  grader_errors: string[];
  notes: Array<Pick<NoteScore, "id" | "expected_count" | "produced_count" | "correct" | "missed" | "extra" | "exact"> & { status: string }>;
  pass: boolean;
}

function inc(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function buildScorecard(args: {
  mode: "live" | "dry-run";
  model: string;
  grader: string;
  startedAt: Date;
  datasets: Record<string, string>;
  notes: CaseRecord[];
  injection: CaseRecord[];
  tagsById: Map<string, string[]>;
}): Scorecard {
  const all = [...args.notes, ...args.injection];
  const violations: Record<string, number> = {};
  const fallbacks: Record<string, number> = {};
  let attempts = 0;
  let invalid = 0;
  let firstInvalid = 0;
  let modelErrors = 0;
  let violations_total = 0;
  for (const r of all) {
    attempts += r.attempts.length;
    if (r.attempts[0] && !r.attempts[0].valid) firstInvalid++;
    for (const a of r.attempts) {
      if (!a.valid) invalid++;
      if (!a.valid && !(a.codes.length === 1 && (a.codes[0] === "no_tasks" || a.codes[0] === "model_error"))) violations_total++;
      for (const code of a.codes) {
        if (code === "model_error") modelErrors++;
        else inc(violations, code);
      }
    }
    if (r.fallback_reason) inc(fallbacks, r.fallback_reason);
  }

  const noteScores = args.notes.map((r) => r.score!).filter(Boolean);
  const accuracy = args.notes.length > 0 ? aggregate(noteScores) : null;

  const byTag: Record<string, { notes: number; accuracy: number }> = {};
  const tagScores = new Map<string, NoteScore[]>();
  for (const s of noteScores) {
    for (const t of args.tagsById.get(s.id) ?? []) tagScores.set(t, [...(tagScores.get(t) ?? []), s]);
  }
  for (const [tag, ss] of [...tagScores.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    byTag[tag] = { notes: ss.length, accuracy: aggregate(ss).accuracy };
  }

  const inj = args.injection.map((r) => r.injection!).filter(Boolean);
  const injection =
    args.injection.length > 0
      ? {
          total: inj.length,
          passed: inj.filter((r) => r.pass).length,
          all_pass: inj.every((r) => r.pass),
          fallbacks: inj.filter((r) => r.fallback).length,
          first_attempt_invalid: inj.filter((r) => !r.first_attempt_valid).length,
          failures: inj
            .filter((r) => !r.pass)
            .map(({ id, category, forbidden_hits, unfaithful_tasks, final_schema_valid }) => ({
              id,
              category,
              forbidden_hits,
              unfaithful_tasks,
              final_schema_valid,
            })),
          results: inj,
        }
      : null;

  const pass = (accuracy === null || accuracy.meets_target) && (injection === null || injection.all_pass);
  return {
    run: {
      id: `${args.startedAt.toISOString().replace(/[:.]/g, "-")}-${args.mode}`,
      mode: args.mode,
      started_at: args.startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      model: args.model,
      grader: args.grader,
      prompt_version: PROMPT_VERSION,
      datasets: args.datasets,
    },
    accuracy,
    by_tag: byTag,
    schema: {
      attempts,
      invalid_attempts: invalid,
      schema_violations: violations_total,
      first_attempt_invalid: firstInvalid,
      violations_by_code: violations,
      fallbacks_by_reason: fallbacks,
      model_errors: modelErrors,
    },
    injection,
    grader_errors: all.filter((r) => r.error).map((r) => r.id),
    notes: args.notes.map((r) => ({
      id: r.id,
      status: r.status,
      expected_count: r.score?.expected_count ?? r.expected.length,
      produced_count: r.score?.produced_count ?? 0,
      correct: r.score?.correct ?? 0,
      missed: r.score?.missed ?? 0,
      extra: r.score?.extra ?? 0,
      exact: r.score?.exact ?? false,
    })),
    pass,
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** Human-readable scorecard. IDs and counts only: no transcripts or titles. */
export function renderMarkdown(s: Scorecard): string {
  const lines: string[] = [];
  lines.push(`# US-03 extraction scorecard (${s.run.mode})`, "");
  lines.push(`- Run: \`${s.run.id}\``);
  lines.push(`- Model: \`${s.run.model}\` | Grader: \`${s.run.grader}\` | Prompt: \`${s.run.prompt_version}\``);
  lines.push(`- Datasets: ${Object.entries(s.run.datasets).map(([k, v]) => `${k}=\`${v}\``).join(", ")}`);
  lines.push(`- Overall: **${s.pass ? "PASS" : "FAIL"}**`, "");
  if (s.accuracy) {
    const a = s.accuracy;
    lines.push("## Accuracy (50-note set)", "");
    lines.push(`**${pct(a.accuracy)}** task accuracy (target ${pct(a.target)}: ${a.meets_target ? "met" : "not met"})`, "");
    lines.push("| Metric | Value |", "|---|---|");
    lines.push(`| Notes fully correct | ${a.notes_exact} / ${a.notes} |`);
    lines.push(`| Expected / produced tasks | ${a.expected_tasks} / ${a.produced_tasks} |`);
    lines.push(`| Correct / missed / extra | ${a.correct_tasks} / ${a.missed_tasks} / ${a.extra_tasks} |`);
    lines.push(`| Meaning recall | ${pct(a.meaning_recall)} |`);
    lines.push(`| Meaning precision | ${pct(a.meaning_precision)} |`);
    lines.push(`| Kind (of matched) | ${pct(a.kind)} |`);
    lines.push(`| Due date (of matched) | ${pct(a.due_date)} |`);
    lines.push(`| Effort band (of matched) | ${pct(a.effort_band)} |`, "");
    lines.push("### By tag", "", "| Tag | Notes | Accuracy |", "|---|---|---|");
    for (const [tag, v] of Object.entries(s.by_tag)) lines.push(`| ${tag} | ${v.notes} | ${pct(v.accuracy)} |`);
    lines.push("");
    const wrong = s.notes.filter((n) => !n.exact);
    if (wrong.length > 0) {
      lines.push("### Notes not fully correct", "", "| Note | Status | Expected | Produced | Correct | Missed | Extra |", "|---|---|---|---|---|---|---|");
      for (const n of wrong) lines.push(`| ${n.id} | ${n.status} | ${n.expected_count} | ${n.produced_count} | ${n.correct} | ${n.missed} | ${n.extra} |`);
      lines.push("");
    }
  }
  lines.push("## Schema", "");
  lines.push(`- Attempts: ${s.schema.attempts}; schema violations: ${s.schema.schema_violations}; rejected for any reason (incl. empty answers): ${s.schema.invalid_attempts}; first attempt rejected: ${s.schema.first_attempt_invalid}; model errors: ${s.schema.model_errors}`);
  lines.push(`- Violations by code: ${JSON.stringify(s.schema.violations_by_code)}`);
  lines.push(`- Fallbacks by reason: ${JSON.stringify(s.schema.fallbacks_by_reason)}`, "");
  if (s.injection) {
    const i = s.injection;
    lines.push("## Prompt injection", "");
    lines.push(`**${i.passed} / ${i.total}** passed (${i.all_pass ? "all pass" : "FAILURES"}); fallbacks: ${i.fallbacks}; first attempt invalid: ${i.first_attempt_invalid}`, "");
    lines.push("| Note | Category | Pass | Fallback | Rejected attempts | Forbidden hits | Unfaithful tasks |", "|---|---|---|---|---|---|---|");
    for (const r of i.results) {
      lines.push(`| ${r.id} | ${r.category} | ${r.pass ? "yes" : "**no**"} | ${r.fallback ? "yes" : "no"} | ${r.rejected_attempts} | ${r.forbidden_hits.join(", ") || "-"} | ${r.unfaithful_tasks} |`);
    }
    lines.push("");
  }
  if (s.grader_errors.length > 0) lines.push(`Grader errors (scored as wrong): ${s.grader_errors.join(", ")}`, "");
  return lines.join("\n");
}
