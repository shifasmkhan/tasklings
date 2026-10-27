import { test } from "node:test";
import assert from "node:assert/strict";
import { isIsoDate, parseAndValidate, titleLength, validateExtraction } from "../src/extraction/validate.ts";
import type { ValidationCode } from "../src/extraction/validate.ts";

const good = { title: "Call the dentist", kind: "quick", effort_min: 5, due_date: "2026-11-05" };

function codes(value: unknown): ValidationCode[] {
  const r = validateExtraction(value);
  return r.ok ? [] : r.errors.map((e) => e.code);
}

function rawCodes(raw: string): ValidationCode[] {
  const r = parseAndValidate(raw);
  return r.ok ? [] : r.errors.map((e) => e.code);
}

test("accepts a minimal valid output", () => {
  const r = parseAndValidate(JSON.stringify({ tasks: [good] }));
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value, { tasks: [good] });
});

test("accepts null due_date and surrounding whitespace", () => {
  assert.deepEqual(rawCodes(`\n  ${JSON.stringify({ tasks: [{ ...good, due_date: null }] })}  \n`), []);
});

test("accepts 0 to 10 tasks, rejects 11", () => {
  assert.deepEqual(codes({ tasks: Array(10).fill(good) }), []);
  assert.deepEqual(codes({ tasks: [] }), []);
  assert.deepEqual(rawCodes('{"tasks":[]}'), []);
  assert.deepEqual(codes({ tasks: {} }), ["tasks_not_array"]);
  assert.deepEqual(codes({}), ["missing_field"]);
  assert.deepEqual(codes({ tasks: [], extra: 1 }), ["extra_field"]);
  assert.deepEqual(codes({ tasks: Array(11).fill(good) }), ["too_many_tasks"]);
});

test("bounds work on huge task arrays", () => {
  const r = validateExtraction({ tasks: Array(10_000).fill({ nope: 1 }) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.length < 100);
});

test("title length is 60 code points max", () => {
  assert.deepEqual(codes({ tasks: [{ ...good, title: "A".repeat(60) }] }), []);
  assert.deepEqual(codes({ tasks: [{ ...good, title: "A".repeat(61) }] }), ["title_too_long"]);
  // 60 emoji = 120 UTF-16 code units but 60 code points: allowed.
  const emoji = "\u{1F4DE}".repeat(60);
  assert.equal(titleLength(emoji), 60);
  assert.deepEqual(codes({ tasks: [{ ...good, title: emoji }] }), []);
});

test("rejects empty, untrimmed and non-string titles", () => {
  assert.deepEqual(codes({ tasks: [{ ...good, title: "   " }] }), ["title_empty"]);
  assert.deepEqual(codes({ tasks: [{ ...good, title: " Call mom" }] }), ["title_untrimmed"]);
  assert.deepEqual(codes({ tasks: [{ ...good, title: 42 }] }), ["title_type"]);
});

test("rejects control, zero-width and bidi characters in titles", () => {
  for (const ch of ["\n", "\u0000", "\u200b", "\u202e", "\u2066", "\ufeff", "\u0085"]) {
    assert.deepEqual(codes({ tasks: [{ ...good, title: `Call${ch}mom` }] }), ["title_control_chars"], JSON.stringify(ch));
  }
  // ZWJ emoji sequence is fine.
  assert.deepEqual(codes({ tasks: [{ ...good, title: "Plan family dinner \u{1F468}\u200d\u{1F469}" }] }), []);
});

test("rejects URLs, emails and phone numbers in titles", () => {
  const cases: Array<[string, ValidationCode]> = [
    ["Visit https://example.com/login", "title_url"],
    ["Open www.example.org", "title_url"],
    ["Verify account at evil-example.com", "title_url"],
    ["Open javascript:alert(1)", "title_url"],
    ["Email bob@example.net", "title_email"],
    ["Call 214-555-0134", "title_phone"],
    ["Call +1 (555) 010 0199", "title_phone"],
    ["Text 5550100199", "title_phone"],
  ];
  for (const [title, code] of cases) assert.ok(codes({ tasks: [{ ...good, title }] }).includes(code), title);
  // Not phones: ISO dates, money, short numbers, times.
  for (const title of ["Pay $1,250 rent", "Submit form by 2026-11-05", "Book 3:30 pickup", "Buy 12 eggs", "Return Node.js book"]) {
    assert.deepEqual(codes({ tasks: [{ ...good, title }] }), [], title);
  }
});

test("enforces the kind enum", () => {
  assert.deepEqual(codes({ tasks: [{ ...good, kind: "urgent" }] }), ["kind_invalid"]);
  assert.deepEqual(codes({ tasks: [{ ...good, kind: "Quick" }] }), ["kind_invalid"]);
  for (const kind of ["quick", "errand", "project"]) assert.deepEqual(codes({ tasks: [{ ...good, kind }] }), []);
});

test("effort_min is an integer in 1..480", () => {
  assert.deepEqual(codes({ tasks: [{ ...good, effort_min: 1 }] }), []);
  assert.deepEqual(codes({ tasks: [{ ...good, effort_min: 480 }] }), []);
  assert.deepEqual(codes({ tasks: [{ ...good, effort_min: 0 }] }), ["effort_range"]);
  assert.deepEqual(codes({ tasks: [{ ...good, effort_min: 481 }] }), ["effort_range"]);
  assert.deepEqual(codes({ tasks: [{ ...good, effort_min: 99999 }] }), ["effort_range"]);
  assert.deepEqual(codes({ tasks: [{ ...good, effort_min: 7.5 }] }), ["effort_type"]);
  assert.deepEqual(codes({ tasks: [{ ...good, effort_min: "5" }] }), ["effort_type"]);
  assert.deepEqual(codes({ tasks: [{ ...good, effort_min: Number.NaN }] }), ["effort_type"]);
});

test("due_date is a calendar-valid ISO date or null", () => {
  assert.equal(isIsoDate("2028-02-29"), true);
  assert.equal(isIsoDate("2026-02-29"), false);
  assert.deepEqual(codes({ tasks: [{ ...good, due_date: "2026-13-45" }] }), ["due_date_invalid"]);
  assert.deepEqual(codes({ tasks: [{ ...good, due_date: "2026-02-30" }] }), ["due_date_invalid"]);
  assert.deepEqual(codes({ tasks: [{ ...good, due_date: "tomorrow" }] }), ["due_date_format"]);
  assert.deepEqual(codes({ tasks: [{ ...good, due_date: "2026-11-05T17:00:00Z" }] }), ["due_date_format"]);
  assert.deepEqual(codes({ tasks: [{ ...good, due_date: 20261105 }] }), ["due_date_type"]);
});

test("rejects extra and missing fields at both levels", () => {
  assert.deepEqual(codes({ tasks: [good], note: "hi" }), ["extra_field"]);
  assert.deepEqual(codes({ tasks: [{ ...good, priority: "high" }] }), ["extra_field"]);
  const { due_date: _omit, ...noDue } = good;
  assert.deepEqual(codes({ tasks: [noDue] }), ["missing_field"]);
  assert.deepEqual(codes({}), ["missing_field"]);
});

test("__proto__ smuggling is an extra field", () => {
  assert.ok(rawCodes(`{"tasks":[${JSON.stringify(good)}],"__proto__":{"admin":true}}`).includes("extra_field"));
  assert.ok(
    rawCodes(`{"tasks":[{"title":"Call mom","kind":"quick","effort_min":5,"due_date":null,"__proto__":{"x":1}}]}`).includes(
      "extra_field",
    ),
  );
});

test("rejects non-JSON, fenced JSON, prose, arrays and oversized output", () => {
  const json = JSON.stringify({ tasks: [good] });
  assert.deepEqual(rawCodes("Sure! Here are your tasks."), ["not_json"]);
  assert.deepEqual(rawCodes("```json\n" + json + "\n```"), ["not_json"]);
  assert.deepEqual(rawCodes(`Here you go: ${json}`), ["not_json"]);
  assert.deepEqual(rawCodes("{not json}"), ["not_json"]);
  assert.deepEqual(rawCodes("tasks:\n  - title: Call mom"), ["not_json"]);
  assert.deepEqual(codes([good]), ["not_object"]);
  assert.deepEqual(codes({ tasks: "Call mom" }), ["tasks_not_array"]);
  assert.deepEqual(codes({ tasks: ["Call mom"] }), ["task_not_object"]);
  assert.deepEqual(rawCodes(`{"tasks":[${JSON.stringify(good)}],"pad":"${"x".repeat(9000)}"}`), ["raw_too_long"]);
});

test("error paths never echo model-controlled values", () => {
  const r = validateExtraction({ tasks: [{ ...good, title: "https://evil.example.com/steal?x=SECRET" }] });
  assert.equal(r.ok, false);
  if (!r.ok) for (const e of r.errors) assert.ok(!e.path.includes("SECRET"));
  const long = validateExtraction({ tasks: [good], ["k".repeat(500)]: 1 });
  if (!long.ok) for (const e of long.errors) assert.ok(e.path.length < 60);
});
