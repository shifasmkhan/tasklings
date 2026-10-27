// US-03 eval harness CLI.
//
//   node evals/cli.ts [--dry-run] [--set notes|injection|all] [--model ID]
//                     [--grader-model ID] [--ids n01,i03] [--concurrency N]
//
// Live runs call the Claude API (key from ANTHROPIC_API_KEY only). Dry runs
// need no key: the "model" replays each case's expected output through the
// real pipeline (validator, retry/fallback logic) and the scorer, with an
// offline lexical meaning judge. Writes ai/runs/<run-id>/ (git-ignored).
// Console output carries IDs and counts only.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ModelClient } from "../src/extraction/extract.ts";
import { anthropicClient, anthropicFromEnv, DEFAULT_GRADER_MODEL, DEFAULT_MODEL } from "./anthropic.ts";
import { lintSets, loadInjectionSet, loadNoteSet } from "./datasets.ts";
import { ModelJudge } from "./grader.ts";
import type { CaseRecord, RunOptions } from "./runner.ts";
import { buildScorecard, renderMarkdown, runSet } from "./runner.ts";
import { LexicalJudge } from "./scoring.ts";
import type { NoteCase } from "./types.ts";

function usage(): never {
  console.error(
    "usage: node evals/cli.ts [--dry-run] [--set notes|injection|all] [--model ID] [--grader-model ID] [--ids a,b] [--concurrency N]",
  );
  process.exit(2);
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      options: {
        "dry-run": { type: "boolean", default: false },
        set: { type: "string", default: "all" },
        model: { type: "string" },
        "grader-model": { type: "string" },
        ids: { type: "string" },
        concurrency: { type: "string", default: "4" },
        help: { type: "boolean", default: false },
      },
      strict: true,
    }).values;
  } catch {
    usage();
  }
  if (args.help) usage();
  const set = args.set;
  if (set !== "notes" && set !== "injection" && set !== "all") usage();
  const concurrency = Number(args.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) usage();
  const dryRun = args["dry-run"] === true;

  const noteSet = loadNoteSet();
  const injectionSet = loadInjectionSet();
  const problems = lintSets(noteSet, injectionSet);
  if (problems.length > 0) {
    console.error(`dataset lint failed:\n  ${problems.join("\n  ")}`);
    return 1;
  }

  const only = args.ids ? new Set(args.ids.split(",").map((s) => s.trim())) : null;
  const pick = <T extends { id: string }>(xs: T[]) => (only ? xs.filter((x) => only.has(x.id)) : xs);
  const notes = set === "injection" ? [] : pick(noteSet.notes);
  const injections = set === "notes" ? [] : pick(injectionSet.notes);

  let opts: RunOptions;
  let model: string;
  let grader: string;
  if (dryRun) {
    model = "dry-run:expected-output";
    const judge = new LexicalJudge();
    grader = judge.name;
    const canned = (c: NoteCase): ModelClient => ({
      complete: () => Promise.resolve(JSON.stringify({ tasks: c.expected })),
    });
    opts = { clientFor: canned, judge, concurrency, keepRaw: true };
  } else {
    model = args.model ?? process.env.EVAL_MODEL ?? DEFAULT_MODEL;
    const graderModel = args["grader-model"] ?? process.env.EVAL_GRADER_MODEL ?? DEFAULT_GRADER_MODEL;
    let sdk;
    try {
      sdk = anthropicFromEnv();
    } catch {
      console.error("ANTHROPIC_API_KEY is not set. Export it, or use --dry-run for the offline check.");
      return 2;
    }
    const client = anthropicClient(sdk, model);
    const judge = new ModelJudge(anthropicClient(sdk, graderModel), graderModel);
    grader = judge.name;
    opts = { clientFor: () => client, judge, concurrency, keepRaw: true };
  }

  const startedAt = new Date();
  console.log(`${dryRun ? "dry run" : "live run"}: ${notes.length} notes, ${injections.length} injection notes, model ${model}`);
  const noteRecords: CaseRecord[] = await runSet(notes, "notes", opts);
  const injRecords: CaseRecord[] = await runSet(injections, "injection", opts);

  const tagsById = new Map([...noteSet.notes, ...injectionSet.notes].map((c) => [c.id, c.tags]));
  const scorecard = buildScorecard({
    mode: dryRun ? "dry-run" : "live",
    model,
    grader,
    startedAt,
    datasets: { notes: noteSet.version, injections: injectionSet.version },
    notes: noteRecords,
    injection: injRecords,
    tagsById,
  });

  const outDir = fileURLToPath(new URL(`../runs/${scorecard.run.id}/`, import.meta.url));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}scorecard.json`, `${JSON.stringify(scorecard, null, 2)}\n`);
  writeFileSync(`${outDir}scorecard.md`, `${renderMarkdown(scorecard)}\n`);
  // Per-case detail including produced titles and raw model text: synthetic data, git-ignored.
  writeFileSync(`${outDir}cases.jsonl`, `${[...noteRecords, ...injRecords].map((r) => JSON.stringify(r)).join("\n")}\n`);

  if (scorecard.accuracy) {
    const a = scorecard.accuracy;
    console.log(`accuracy ${(a.accuracy * 100).toFixed(1)}% (target ${(a.target * 100).toFixed(0)}%): ${a.meets_target ? "met" : "NOT met"}`);
    console.log(`  kind ${(a.kind * 100).toFixed(1)}%, due_date ${(a.due_date * 100).toFixed(1)}%, effort band ${(a.effort_band * 100).toFixed(1)}%, meaning recall ${(a.meaning_recall * 100).toFixed(1)}%`);
  }
  console.log(`schema: ${scorecard.schema.schema_violations} violations in ${scorecard.schema.attempts} attempts; fallbacks ${JSON.stringify(scorecard.schema.fallbacks_by_reason)}`);
  if (scorecard.injection) {
    const i = scorecard.injection;
    console.log(`injection: ${i.passed}/${i.total} pass${i.failures.length ? `; failing: ${i.failures.map((f) => f.id).join(", ")}` : ""}`);
  }
  const total = noteRecords.length + injRecords.length;
  if (!dryRun && total > 0 && scorecard.schema.model_errors >= total) {
    console.error("every model call failed: check ANTHROPIC_API_KEY, network access and --model");
  }
  console.log(`scorecard: ${outDir}scorecard.md`);
  console.log(scorecard.pass ? "PASS" : "FAIL");
  return scorecard.pass ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`harness error: ${err instanceof Error ? err.name : "unknown"}`);
    process.exit(2);
  },
);
