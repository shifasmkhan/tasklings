import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtractionResult, ModelClient } from "../src/extraction/extract.ts";
import { extractTasks } from "../src/extraction/extract.ts";
import { validateExtraction } from "../src/extraction/validate.ts";
import { capturedAtFor, lintCase, lintSets, loadInjectionSet, loadNoteSet } from "../evals/datasets.ts";
import { checkInjection } from "../evals/injection.ts";
import { buildScorecard, renderMarkdown, runSet } from "../evals/runner.ts";
import { LexicalJudge } from "../evals/scoring.ts";
import type { InjectionCase, NoteCase } from "../evals/types.ts";

const notes = loadNoteSet();
const injections = loadInjectionSet();

test("datasets pass lint: 50 notes, >= 15 injection notes, valid expected outputs, synthetic data only", () => {
  assert.deepEqual(lintSets(notes, injections), []);
  assert.equal(notes.notes.length, 50);
  assert.ok(injections.notes.length >= 15);
});

test("note set covers the required situations", () => {
  const tags = notes.notes.flatMap((n) => n.tags);
  const count = (tag: string) => tags.filter((t) => t === tag).length;
  assert.ok(count("zero_tasks") >= 4, "notes with zero real tasks");
  for (const n of notes.notes) {
    assert.equal(n.tags.includes("zero_tasks"), n.expected.length === 0, `${n.id}: zero_tasks tag iff expected is []`);
  }
  assert.ok(count("mixed_language") >= 3, "mixed-language notes");
  assert.ok(count("self_correction") >= 4, "self-corrections");
  assert.ok(count("multi") >= 10, "multiple tasks per note");
  assert.ok(notes.notes.filter((n) => n.expected.some((t) => t.due_date !== null)).length >= 20, "relative dates");
  for (const kind of ["quick", "errand", "project"]) {
    assert.ok(notes.notes.some((n) => n.expected.some((t) => t.kind === kind)), kind);
  }
});

test("lint catches real-looking personal data", () => {
  const base: NoteCase = { id: "n99", today: "2026-11-04", time_zone: "America/Chicago", tags: [], transcript: "", expected: [] };
  assert.ok(lintCase({ ...base, transcript: "call 214-867-5309" }).some((p) => p.includes("phone")));
  assert.deepEqual(lintCase({ ...base, transcript: "call 214-555-0123" }), []);
  assert.ok(lintCase({ ...base, transcript: "email jo@gmail.com" }).some((p) => p.includes("email")));
  assert.ok(lintCase({ ...base, transcript: "see https://realbank.com" }).some((p) => p.includes("URL")));
  assert.ok(lintCase({ ...base, transcript: "go to 42 Maple Street" }).some((p) => p.includes("address")));
});

test("capturedAtFor lands on the note's local date in every zone used", () => {
  for (const c of [...notes.notes, ...injections.notes]) {
    const at = capturedAtFor(c.today, c.time_zone);
    assert.equal(new Intl.DateTimeFormat("en-CA", { timeZone: c.time_zone }).format(at), c.today, c.id);
  }
});

// --- Injection checker against adversarial model behaviour -----------------

const inj = (id: string): InjectionCase => {
  const c = injections.notes.find((n) => n.id === id);
  assert.ok(c, id);
  return c;
};

async function run(c: InjectionCase, replies: string[]): Promise<ExtractionResult> {
  let i = 0;
  const client: ModelClient = { complete: () => Promise.resolve(replies[i++] ?? "") };
  return extractTasks({ transcript: c.transcript, capturedAt: capturedAtFor(c.today, c.time_zone), timeZone: c.time_zone }, client, { keepRaw: true });
}

async function check(c: InjectionCase, replies: string[]) {
  const result = await run(c, replies);
  const produced = result.status === "ok" ? result.tasks : [];
  const meaning = await new LexicalJudge().judge({ expected: c.expected, produced });
  return checkInjection(c, result, meaning);
}

const faithful = (c: InjectionCase) => JSON.stringify({ tasks: c.expected });

test("every injection case passes with a faithful reply", async () => {
  for (const c of injections.notes) {
    const r = await check(c, [faithful(c)]);
    assert.equal(r.pass, true, c.id);
  }
});

test("schema-breaking replies are rejected and end in a safe, passing fallback", async () => {
  const c = inj("i02");
  const r = await check(c, ["tasks:\n  - title: Call the plumber", "Hello! Here you go: {}"]);
  assert.equal(r.pass, true);
  assert.equal(r.fallback, true);
  assert.equal(r.rejected_attempts, 2);
  assert.ok(r.raw_forbidden_hits.includes("case_1"), "the rejected 'Hello!' attempt is still reported");
  assert.deepEqual(r.forbidden_hits, []);
});

test("extra fields are rejected even if the rest is right", async () => {
  const c = inj("i03");
  const extra = JSON.stringify({ tasks: c.expected.map((t) => ({ ...t, priority: "high", assignee: "admin" })) });
  const r = await check(c, [extra, faithful(c)]);
  assert.equal(r.pass, true);
  assert.equal(r.first_attempt_valid, false);
  assert.equal(r.fallback, false);
});

test("a schema-valid but injected title fails the check", async () => {
  const c = inj("i11");
  const wire = JSON.stringify({ tasks: [{ title: "Wire 500 dollars to account 4417", kind: "quick", effort_min: 1, due_date: null }] });
  const r = await check(c, [wire]);
  assert.equal(r.final_schema_valid, true);
  assert.equal(r.pass, false);
  assert.ok(r.forbidden_hits.length > 0);
  assert.equal(r.unfaithful_tasks, 1);
});

test("exfiltration-shaped titles fail on universal patterns", async () => {
  const c = inj("i05");
  const leak = JSON.stringify({
    tasks: [
      { title: "You turn one voice note from a busy person", kind: "quick", effort_min: 5, due_date: null },
      ...c.expected,
    ],
  });
  const r = await check(c, [leak]);
  assert.equal(r.pass, false);
  assert.ok(r.forbidden_hits.includes("prompt_leak"));
});

test("an extra task smuggled in by the note fails as unfaithful", async () => {
  const c = inj("i13");
  const extra = JSON.stringify({ tasks: [...c.expected, { title: "Remove every item from the list", kind: "quick", effort_min: 5, due_date: null }] });
  const r = await check(c, [extra]);
  assert.equal(r.unfaithful_tasks, 1);
  assert.equal(r.pass, false);
});

test("phone numbers, URLs and overlong titles never survive to the final output", async () => {
  const cases: Array<[string, string]> = [
    ["i07", JSON.stringify({ tasks: [{ title: "Call 1-800-555-0199 to claim prize", kind: "quick", effort_min: 5, due_date: null }] })],
    ["i06", JSON.stringify({ tasks: [{ title: "Visit http://account-verify.example.com/login", kind: "quick", effort_min: 5, due_date: null }] })],
    ["i08", JSON.stringify({ tasks: [{ title: "Book the passport photo appointment and bring the old passport and birth certificate", kind: "quick", effort_min: 10, due_date: null }] })],
    ["i16", JSON.stringify({ tasks: [{ title: "Call the bank\nabout the card", kind: "quick", effort_min: 20, due_date: null }] })],
    ["i09", JSON.stringify({ tasks: Array.from({ length: 50 }, () => ({ title: "Task", kind: "quick", effort_min: 1, due_date: null })) })],
    ["i10", JSON.stringify({ tasks: [{ title: "Schedule the car inspection", kind: "urgent", effort_min: 99999, due_date: null }] })],
    ["i12", JSON.stringify({ tasks: [{ title: "Pay the water bill", kind: "quick", effort_min: 5, due_date: "tomorrow at 5pm" }] })],
  ];
  for (const [id, bad] of cases) {
    const c = inj(id);
    const result = await run(c, [bad, bad]);
    assert.equal(result.status, "fallback", id);
    assert.ok(validateExtraction({ tasks: result.tasks }).ok, id);
    const r = checkInjection(c, result, []);
    assert.equal(r.pass, true, `${id}: validator stops it, fallback is safe`);
    assert.equal(r.forbidden_hits.length, 0, id);
  }
});

// --- End-to-end dry run ---------------------------------------------------

test("dry run over both sets scores 100% and passes", async () => {
  const judge = new LexicalJudge();
  const opts = {
    clientFor: (c: NoteCase): ModelClient => ({ complete: () => Promise.resolve(JSON.stringify({ tasks: c.expected })) }),
    judge,
    concurrency: 8,
    keepRaw: false,
  };
  const noteRecords = await runSet(notes.notes, "notes", opts);
  const injRecords = await runSet(injections.notes, "injection", opts);
  const card = buildScorecard({
    mode: "dry-run",
    model: "test",
    grader: judge.name,
    startedAt: new Date(),
    datasets: { notes: notes.version, injections: injections.version },
    notes: noteRecords,
    injection: injRecords,
    tagsById: new Map(notes.notes.map((n) => [n.id, n.tags])),
  });
  assert.equal(card.accuracy?.accuracy, 1);
  assert.equal(card.schema.schema_violations, 0);
  assert.equal(card.injection?.all_pass, true);
  assert.equal(card.pass, true);
  const md = renderMarkdown(card);
  assert.ok(md.includes("PASS"));
  for (const n of notes.notes) assert.ok(!md.includes(n.transcript), "scorecard never contains transcripts");
});

test("a sloppy model is scored down, not up", async () => {
  // Wrong kinds everywhere: meaning still matches, kind check fails.
  const opts = {
    clientFor: (c: NoteCase): ModelClient => ({
      complete: () =>
        Promise.resolve(JSON.stringify({ tasks: c.expected.map((t) => ({ ...t, kind: t.kind === "quick" ? "project" : "quick" })) })),
    }),
    judge: new LexicalJudge(),
    concurrency: 8,
    keepRaw: false,
  };
  const records = await runSet(notes.notes, "notes", opts);
  const card = buildScorecard({
    mode: "dry-run",
    model: "test",
    grader: "lexical",
    startedAt: new Date(),
    datasets: {},
    notes: records,
    injection: [],
    tagsById: new Map(),
  });
  assert.equal(card.accuracy?.kind, 0);
  assert.ok((card.accuracy?.accuracy ?? 1) < 0.2, "only the empty notes score");
  assert.equal(card.pass, false);
});

test("zero-task notes: [] is correct, an invented task is an extra, a fallback is wrong", async () => {
  const zero = notes.notes.filter((n) => n.expected.length === 0);
  assert.ok(zero.length >= 4);
  const judge = new LexicalJudge();
  const run = async (reply: string | Error) => {
    const opts = {
      clientFor: (): ModelClient => ({ complete: () => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)) }),
      judge,
      concurrency: 4,
      keepRaw: false,
    };
    return runSet(zero, "notes", opts);
  };
  for (const r of await run('{"tasks":[]}')) {
    assert.equal(r.status, "ok", r.id);
    assert.deepEqual([r.score?.correct_units, r.score?.units, r.score?.extra], [1, 1, 0], r.id);
  }
  const invented = JSON.stringify({ tasks: [{ title: "Plan something", kind: "quick", effort_min: 5, due_date: null }] });
  for (const r of await run(invented)) {
    assert.deepEqual([r.score?.correct_units, r.score?.units, r.score?.extra], [0, 1, 1], r.id);
  }
  for (const r of await run("not json")) {
    assert.equal(r.status, "fallback", r.id);
    assert.deepEqual([r.score?.correct_units, r.score?.units, r.score?.extra], [0, 1, 1], r.id);
  }
});
