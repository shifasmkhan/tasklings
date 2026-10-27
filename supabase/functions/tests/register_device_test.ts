import { strict as assert } from "node:assert";
import { createHandler } from "../register-device/handler.ts";
import { errorCode, fakeGetUser, NOW, post, recordingLog, tokenFor } from "./helpers.ts";

const APNS = "a1".repeat(32);

function handler() {
  const upserts: string[] = [];
  const tokens: string[] = [];
  const rec = recordingLog();
  const h = createHandler({
    getUser: fakeGetUser(),
    now: () => NOW,
    log: rec.log,
    store: (token) => (tokens.push(token), {
      upsertDevice: (t) => (upserts.push(t), Promise.resolve()),
    }),
  });
  return { h, upserts, tokens, rec };
}

Deno.test("register-device: valid token returns 204 and upserts with the caller's JWT", async () => {
  const { h, upserts, tokens, rec } = handler();
  const jwt = tokenFor();
  const res = await h(post("register-device", { apns_token: APNS.toUpperCase() }, jwt));
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
  assert.deepEqual(upserts, [APNS]); // normalised to lowercase
  assert.deepEqual(tokens, [jwt]);
  assert.ok(!JSON.stringify(rec.events).includes(APNS), "APNs token is never logged");
});

for (
  const [name, body] of [
    ["missing token", {}],
    ["non-string token", { apns_token: 123 }],
    ["short token", { apns_token: "ab".repeat(10) }],
    ["non-hex token", { apns_token: "zz".repeat(32) }],
    ["token with spaces", { apns_token: `<${"ab".repeat(32)}>` }],
    ["extra field", { apns_token: APNS, user_id: "00000000-0000-4000-a000-00000000000b" }],
  ] as [string, unknown][]
) {
  Deno.test(`register-device: rejects ${name}`, async () => {
    const { h, upserts } = handler();
    const res = await h(post("register-device", body, tokenFor()));
    assert.equal(res.status, 400);
    assert.equal(await errorCode(res), "invalid_request");
    assert.deepEqual(upserts, []);
  });
}

Deno.test("register-device: unauthenticated is 401", async () => {
  const { h, upserts } = handler();
  const res = await h(post("register-device", { apns_token: APNS }, null));
  assert.equal(res.status, 401);
  assert.equal(await errorCode(res), "unauthenticated");
  assert.deepEqual(upserts, []);
});
