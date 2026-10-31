// export-data and delete-account: fresh-session rule, empty-body contract, scoping.
import { strict as assert } from "node:assert";
import { createHandler as exportHandler, EXPORT_COLUMNS, type ExportTable } from "../export-data/handler.ts";
import { createHandler as deleteHandler } from "../delete-account/handler.ts";
import type { RevocationOutcome } from "../_shared/apple.ts";
import { errorCode, fakeGetUser, NOW, post, recordingLog, tokenFor, USER_A } from "./helpers.ts";

function exportFixture() {
  const reads: string[] = [];
  const tokens: string[] = [];
  const h = exportHandler({
    getUser: fakeGetUser(),
    now: () => NOW,
    log: recordingLog().log,
    store: (token) => (tokens.push(token), {
      selectAll: (table: ExportTable) => {
        reads.push(table);
        return Promise.resolve(
          table === "profiles" ? [{ user_id: USER_A, timezone: "America/Chicago" }] : [],
        );
      },
    }),
  });
  return { h, reads, tokens };
}

const CODE = "c0de.synthetic-authorization_code";

function deleteFixture(outcome: RevocationOutcome = "revoked") {
  const calls: string[] = [];
  const logs = recordingLog();
  const h = deleteHandler({
    getUser: fakeGetUser(),
    now: () => NOW,
    log: logs.log,
    admin: () => ({
      deleteUser: (id) => (calls.push(`delete:${id}`), Promise.resolve()),
    }),
    revokeApple: (code) => (calls.push(`revoke:${code}`), Promise.resolve(outcome)),
  });
  return { h, calls, events: logs.events };
}

Deno.test("export-data: fresh session returns a JSON attachment from the caller's RLS-bound reads", async () => {
  const { h, reads, tokens } = exportFixture();
  const jwt = tokenFor(USER_A, 60);
  const res = await h(post("export-data", undefined, jwt));
  assert.equal(res.status, 200);
  assert.match(
    res.headers.get("content-disposition") ?? "",
    /^attachment; filename="tasklings-export-2026-10-27\.json"$/,
  );
  const body = await res.json();
  assert.equal(body.user_id, USER_A);
  assert.equal(body.profile.timezone, "America/Chicago");
  assert.deepEqual(reads.sort(), Object.keys(EXPORT_COLUMNS).sort());
  assert.deepEqual(tokens, [jwt]);
});

Deno.test("export-data: never selects the Apple token or `*`", () => {
  for (const cols of Object.values(EXPORT_COLUMNS)) {
    assert.ok(!cols.includes("apple"), cols);
    assert.ok(!cols.includes("*"), cols);
  }
  assert.ok(!("apple_credentials" in EXPORT_COLUMNS));
});

Deno.test("export-data: accepts an empty JSON object body", async () => {
  const { h } = exportFixture();
  assert.equal((await h(post("export-data", {}, tokenFor()))).status, 200);
});

Deno.test("export-data and delete-account: session older than 5 minutes is 403 reauth_required", async () => {
  const exp = exportFixture();
  const del = deleteFixture();
  for (const h of [exp.h, del.h]) {
    const res = await h(post("x", { apple_authorization_code: CODE }, tokenFor(USER_A, 301)));
    assert.equal(res.status, 403);
    assert.equal(await errorCode(res), "reauth_required");
  }
  assert.deepEqual(exp.reads, []);
  assert.deepEqual(del.calls, []);
});

Deno.test("export-data and delete-account: non-Apple sign-in method is 403", async () => {
  const exp = exportFixture();
  const del = deleteFixture();
  for (const h of [exp.h, del.h]) {
    const res = await h(post("x", { apple_authorization_code: CODE }, tokenFor(USER_A, 10, "password")));
    assert.equal(res.status, 403);
    assert.equal(await errorCode(res), "reauth_required");
  }
  assert.deepEqual(del.calls, []);
});

Deno.test("export-data: a non-empty body is invalid_request", async () => {
  const exp = exportFixture();
  const res = await exp.h(post("x", { user_id: "00000000-0000-4000-a000-00000000000b" }, tokenFor()));
  assert.equal(res.status, 400);
  assert.equal(await errorCode(res), "invalid_request");
  assert.deepEqual(exp.reads, []);
});

Deno.test("export-data and delete-account: unauthenticated is 401", async () => {
  const exp = exportFixture();
  const del = deleteFixture();
  for (const h of [exp.h, del.h]) {
    const res = await h(post("x", { apple_authorization_code: CODE }, null));
    assert.equal(res.status, 401);
    assert.equal(await errorCode(res), "unauthenticated");
  }
});

const del = (body: unknown, token: string | null = tokenFor(USER_A, 30)) =>
  post("delete-account", body, token);

Deno.test("delete-account: revokes with the code, then deletes only the verified caller, returns 204", async () => {
  const { h, calls, events } = deleteFixture();
  const res = await h(del({ apple_authorization_code: CODE }));
  assert.equal(res.status, 204);
  assert.deepEqual(calls, [`revoke:${CODE}`, `delete:${USER_A}`]);
  assert.deepEqual(events.map((e) => [e.event, e.fields.apple_revocation]), [["account_deleted", "revoked"]]);
});

Deno.test("delete-account: Apple unreachable or not configured still deletes, and logs the outcome", async () => {
  for (const outcome of ["revocation_failed", "not_configured"] as const) {
    const { h, calls, events } = deleteFixture(outcome);
    const res = await h(del({ apple_authorization_code: CODE }));
    assert.equal(res.status, 204);
    assert.deepEqual(calls, [`revoke:${CODE}`, `delete:${USER_A}`]);
    assert.equal(events[0].event, "account_deleted");
    assert.equal(events[0].fields.apple_revocation, outcome);
  }
});

Deno.test("delete-account: a code Apple rejects is 400 apple_code_invalid and deletes nothing", async () => {
  const { h, calls, events } = deleteFixture("code_invalid");
  const res = await h(del({ apple_authorization_code: CODE }));
  assert.equal(res.status, 400);
  assert.equal(await errorCode(res), "apple_code_invalid");
  assert.deepEqual(calls, [`revoke:${CODE}`]);
  assert.equal(events[0].event, "account_delete_refused");
});

Deno.test("delete-account: missing or invalid body is 400 invalid_request, with no Apple call and no delete", async () => {
  const bad: unknown[] = [
    undefined,
    "",
    "not json",
    [],
    {},
    { apple_authorization_code: null },
    { apple_authorization_code: 12345 },
    { apple_authorization_code: "" },
    { apple_authorization_code: "a".repeat(2049) },
    { apple_authorization_code: "has space" },
    { apple_authorization_code: "semi;colon" },
    { apple_authorization_code: "new\nline" },
    { apple_authorization_code: "ünï" },
    { apple_authorization_code: CODE, user_id: "00000000-0000-4000-a000-00000000000b" },
    { apple_authorization_code: CODE, extra: 1 },
  ];
  for (const body of bad) {
    const { h, calls } = deleteFixture();
    const res = await h(del(body));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(await errorCode(res), "invalid_request", JSON.stringify(body));
    assert.deepEqual(calls, [], JSON.stringify(body));
  }
});

Deno.test("delete-account: accepts a code of 1 and of 2048 allowed characters", async () => {
  for (const code of ["a", "A.b_c-9".padEnd(2048, "x")]) {
    const { h, calls } = deleteFixture();
    assert.equal((await h(del({ apple_authorization_code: code }))).status, 204);
    assert.deepEqual(calls, [`revoke:${code}`, `delete:${USER_A}`]);
  }
});

Deno.test("delete-account: freshness is checked before the body, and no Apple call precedes it", async () => {
  const { h, calls } = deleteFixture();
  const res = await h(del("not json", tokenFor(USER_A, 301)));
  assert.equal(res.status, 403);
  assert.equal(await errorCode(res), "reauth_required");
  assert.deepEqual(calls, []);
});

Deno.test("delete-account: wrong method is 405 and a non-JSON body is 415, before any work", async () => {
  const { h, calls } = deleteFixture();
  const get = await h(new Request("http://localhost/functions/v1/delete-account", { method: "GET" }));
  assert.equal(get.status, 405);
  const text = await h(
    post("delete-account", `{"apple_authorization_code":"${CODE}"}`, tokenFor(), "text/plain"),
  );
  assert.equal(text.status, 415);
  assert.deepEqual(calls, []);
});

Deno.test("delete-account: the code never reaches the logs", async () => {
  for (const outcome of ["revoked", "code_invalid", "revocation_failed", "not_configured"] as const) {
    const { h, events } = deleteFixture(outcome);
    await h(del({ apple_authorization_code: CODE }));
    assert.ok(!JSON.stringify(events).includes(CODE), outcome);
  }
});
