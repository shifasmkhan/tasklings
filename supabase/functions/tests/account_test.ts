// export-data and delete-account: fresh-session rule, empty-body contract, scoping.
import { strict as assert } from "node:assert";
import { createHandler as exportHandler, EXPORT_COLUMNS, type ExportTable } from "../export-data/handler.ts";
import { createHandler as deleteHandler } from "../delete-account/handler.ts";
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

function deleteFixture(storedToken: string | null = "synthetic-ciphertext") {
  const calls: string[] = [];
  const h = deleteHandler({
    getUser: fakeGetUser(),
    now: () => NOW,
    log: recordingLog().log,
    admin: () => ({
      appleRefreshToken: (id) => (calls.push(`read:${id}`), Promise.resolve(storedToken)),
      deleteUser: (id) => (calls.push(`delete:${id}`), Promise.resolve()),
    }),
    revokeApple: () => (calls.push("revoke"), Promise.resolve("revoked")),
  });
  return { h, calls };
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
    const res = await h(post("x", undefined, tokenFor(USER_A, 301)));
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
    const res = await h(post("x", undefined, tokenFor(USER_A, 10, "password")));
    assert.equal(res.status, 403);
    assert.equal(await errorCode(res), "reauth_required");
  }
  assert.deepEqual(del.calls, []);
});

Deno.test("export-data and delete-account: a non-empty body is invalid_request", async () => {
  const exp = exportFixture();
  const del = deleteFixture();
  for (const h of [exp.h, del.h]) {
    const res = await h(post("x", { user_id: "00000000-0000-4000-a000-00000000000b" }, tokenFor()));
    assert.equal(res.status, 400);
    assert.equal(await errorCode(res), "invalid_request");
  }
  assert.deepEqual(del.calls, []);
});

Deno.test("export-data and delete-account: unauthenticated is 401", async () => {
  const exp = exportFixture();
  const del = deleteFixture();
  for (const h of [exp.h, del.h]) {
    const res = await h(post("x", undefined, null));
    assert.equal(res.status, 401);
    assert.equal(await errorCode(res), "unauthenticated");
  }
});

Deno.test("delete-account: revokes then deletes only the verified caller, returns 204", async () => {
  const { h, calls } = deleteFixture();
  const res = await h(post("delete-account", undefined, tokenFor(USER_A, 30)));
  assert.equal(res.status, 204);
  assert.deepEqual(calls, [`read:${USER_A}`, "revoke", `delete:${USER_A}`]);
});

Deno.test("delete-account: no stored Apple token skips revocation", async () => {
  const { h, calls } = deleteFixture(null);
  const res = await h(post("delete-account", undefined, tokenFor()));
  assert.equal(res.status, 204);
  assert.deepEqual(calls, [`read:${USER_A}`, `delete:${USER_A}`]);
});
