import { strict as assert } from "node:assert";
import {
  type CaptureStore,
  createHandler,
  type ExtractedTask,
  type InsertCaptureResult,
  MAX_TRANSCRIPT_CHARS,
  STUB_TASKS,
} from "../process-capture/handler.ts";
import { errorCode, fakeGetUser, NOW, post, recordingLog, tokenFor } from "./helpers.ts";

const CAPTURE_ID = "50000000-0000-4000-a000-000000000001";
const VALID = {
  capture_id: CAPTURE_ID,
  transcript: "synthetic transcript about buying synthetic milk",
  captured_at: "2026-10-27T09:58:00-05:00",
  timezone: "America/Chicago",
};

function fakeStore(result: InsertCaptureResult = "created") {
  const calls: string[] = [];
  const tokens: string[] = [];
  const tasks: ExtractedTask[] = [];
  const factory = (token: string): CaptureStore => {
    tokens.push(token);
    return {
      insertCapture: (id) => (calls.push(`capture:${id}`), Promise.resolve(result)),
      insertTasks: (_id, t) => (calls.push("tasks"), tasks.push(...t), Promise.resolve(t.length)),
      setCaptureStatus: (_id, s) => (calls.push(`status:${s}`), Promise.resolve()),
    };
  };
  return { calls, tokens, tasks, factory };
}

function handler(store = fakeStore()) {
  const rec = recordingLog();
  return {
    h: createHandler({ getUser: fakeGetUser(), store: store.factory, now: () => NOW, log: rec.log }),
    store,
    rec,
  };
}

Deno.test("process-capture: valid request returns 202 {capture_id} and inserts canned tasks with the caller's JWT", async () => {
  const { h, store, rec } = handler();
  const token = tokenFor();
  const res = await h(post("process-capture", VALID, token));
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { capture_id: CAPTURE_ID });
  assert.deepEqual(store.calls, [`capture:${CAPTURE_ID}`, "tasks", "status:done"]);
  assert.deepEqual(store.tokens, [token]);
  assert.deepEqual(store.tasks, STUB_TASKS);
  // Logs carry IDs and counts only, never the transcript.
  assert.ok(!JSON.stringify(rec.events).includes("synthetic transcript"));
});

Deno.test("process-capture: canned tasks satisfy the extraction schema", () => {
  assert.ok(STUB_TASKS.length >= 1 && STUB_TASKS.length <= 10);
  for (const t of STUB_TASKS) {
    assert.deepEqual(Object.keys(t).sort(), ["due_date", "effort_min", "kind", "title"]);
    assert.ok(t.title.length > 0 && t.title.length <= 60);
    assert.ok(["quick", "errand", "project"].includes(t.kind));
    assert.ok(Number.isInteger(t.effort_min) && t.effort_min >= 1 && t.effort_min <= 480);
  }
});

Deno.test("process-capture: duplicate capture_id from the same user is idempotent", async () => {
  const { h, store } = handler(fakeStore("exists"));
  const res = await h(post("process-capture", VALID, tokenFor()));
  assert.equal(res.status, 202);
  assert.deepEqual(store.calls, [`capture:${CAPTURE_ID}`]);
});

Deno.test("process-capture: capture_id owned by someone else is a conflict", async () => {
  const { h } = handler(fakeStore("conflict"));
  const res = await h(post("process-capture", VALID, tokenFor()));
  assert.equal(res.status, 409);
  assert.equal(await errorCode(res), "capture_conflict");
});

const invalid: [string, unknown][] = [
  ["missing capture_id", { ...VALID, capture_id: undefined }],
  ["non-uuid capture_id", { ...VALID, capture_id: "capture-1" }],
  ["empty transcript", { ...VALID, transcript: "   " }],
  ["non-string transcript", { ...VALID, transcript: 42 }],
  ["overlong transcript", { ...VALID, transcript: "a".repeat(MAX_TRANSCRIPT_CHARS + 1) }],
  ["timestamp without offset", { ...VALID, captured_at: "2026-10-27T09:58:00" }],
  ["date-only timestamp", { ...VALID, captured_at: "2026-10-27" }],
  ["timestamp far in the future", { ...VALID, captured_at: "2026-10-28T09:58:00Z" }],
  ["timestamp too old", { ...VALID, captured_at: "2026-08-01T09:58:00Z" }],
  ["unknown time zone", { ...VALID, timezone: "Mars/Olympus_Mons" }],
  ["offset instead of IANA zone", { ...VALID, timezone: "+05:30" }],
  ["old field name time_zone", { ...VALID, timezone: undefined, time_zone: "America/Chicago" }],
  ["extra field", { ...VALID, user_id: "00000000-0000-4000-a000-00000000000b" }],
  ["array body", [VALID]],
  ["null body", null],
];

for (const [name, body] of invalid) {
  Deno.test(`process-capture: rejects ${name} with 400 invalid_request before touching the database`, async () => {
    const { h, store } = handler();
    const res = await h(post("process-capture", body, tokenFor()));
    assert.equal(res.status, 400);
    assert.equal(await errorCode(res), "invalid_request");
    assert.deepEqual(store.calls, []);
  });
}

Deno.test("process-capture: malformed JSON is invalid_request", async () => {
  const { h } = handler();
  const res = await h(post("process-capture", "{not json", tokenFor()));
  assert.equal(res.status, 400);
  assert.equal(await errorCode(res), "invalid_request");
});

Deno.test("process-capture: wrong content type is 415", async () => {
  const { h } = handler();
  const res = await h(post("process-capture", JSON.stringify(VALID), tokenFor(), "text/plain"));
  assert.equal(res.status, 415);
  assert.equal(await errorCode(res), "unsupported_media_type");
});

Deno.test("process-capture: oversized body is 413", async () => {
  const { h } = handler();
  const res = await h(post("process-capture", { ...VALID, transcript: "a".repeat(70_000) }, tokenFor()));
  assert.equal(res.status, 413);
  assert.equal(await errorCode(res), "payload_too_large");
});

Deno.test("process-capture: no token, bad token or unknown user is 401", async () => {
  const { h, store } = handler();
  for (const token of [null, "garbage", tokenFor("00000000-0000-4000-a000-00000000000b")]) {
    const res = await h(post("process-capture", VALID, token));
    assert.equal(res.status, 401);
    assert.equal(await errorCode(res), "unauthenticated");
  }
  assert.deepEqual(store.calls, []);
});

Deno.test("process-capture: GET is 405", async () => {
  const { h } = handler();
  const res = await h(
    new Request("http://localhost/functions/v1/process-capture", {
      headers: { authorization: `Bearer ${tokenFor()}` },
    }),
  );
  assert.equal(res.status, 405);
  assert.equal(await errorCode(res), "method_not_allowed");
});

Deno.test("process-capture: store failure marks the capture failed and returns a bare 500", async () => {
  const calls: string[] = [];
  const rec = recordingLog();
  const h = createHandler({
    getUser: fakeGetUser(),
    now: () => NOW,
    log: rec.log,
    store: () => ({
      insertCapture: () => Promise.resolve("created"),
      insertTasks: () => Promise.reject(new Error("insert tasks failed: 23514 synthetic secret detail")),
      setCaptureStatus: (_id, s) => (calls.push(s), Promise.resolve()),
    }),
  });
  const res = await h(post("process-capture", VALID, tokenFor()));
  assert.equal(res.status, 500);
  assert.equal(await errorCode(res), "internal_error");
  assert.deepEqual(calls, ["failed"]);
  assert.ok(!JSON.stringify(rec.events).includes("synthetic secret detail"));
});
