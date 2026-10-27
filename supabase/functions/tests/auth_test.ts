import { strict as assert } from "node:assert";
import { bearerToken, decodeJwtPayload, requireFreshSession, sessionAgeSeconds } from "../_shared/auth.ts";
import { HttpError } from "../_shared/http.ts";
import { fakeJwt, NOW, NOW_S, tokenFor } from "./helpers.ts";

function freshCode(claims: Record<string, unknown>): string | null {
  try {
    requireFreshSession(claims, NOW);
    return null;
  } catch (e) {
    assert.ok(e instanceof HttpError);
    return e.code;
  }
}

Deno.test("bearerToken accepts only a well-formed Bearer JWT", () => {
  const t = tokenFor();
  assert.equal(bearerToken(new Request("http://x", { headers: { authorization: `Bearer ${t}` } })), t);
  assert.equal(bearerToken(new Request("http://x", { headers: { authorization: `Basic ${t}` } })), null);
  assert.equal(
    bearerToken(new Request("http://x", { headers: { authorization: "Bearer not-a-jwt" } })),
    null,
  );
  assert.equal(bearerToken(new Request("http://x")), null);
});

Deno.test("decodeJwtPayload returns claims or null", () => {
  assert.equal(decodeJwtPayload(tokenFor())?.sub, "00000000-0000-4000-a000-00000000000a");
  assert.equal(decodeJwtPayload("a.%%%.c"), null);
  assert.equal(decodeJwtPayload(fakeJwt([] as unknown as Record<string, unknown>)), null);
});

Deno.test("session age comes from amr sign-in timestamps, not iat", () => {
  // iat is recent (a refresh), but the Apple sign-in was an hour ago.
  const claims = { iat: NOW_S, amr: [{ method: "oauth", timestamp: NOW_S - 3600 }] };
  assert.equal(sessionAgeSeconds(claims, NOW_S), 3600);
  assert.equal(freshCode(claims), "reauth_required");
});

Deno.test("fresh Apple sign-in under 5 minutes passes", () => {
  assert.equal(freshCode({ amr: [{ method: "oauth", timestamp: NOW_S - 299 }] }), null);
  assert.equal(freshCode({ amr: [{ method: "id_token", timestamp: NOW_S - 10 }] }), null);
  // The latest qualifying entry wins.
  assert.equal(
    freshCode({
      amr: [{ method: "oauth", timestamp: NOW_S - 9000 }, { method: "oauth", timestamp: NOW_S - 5 }],
    }),
    null,
  );
});

Deno.test("stale, missing, foreign-method or future amr fails closed", () => {
  assert.equal(freshCode({ amr: [{ method: "oauth", timestamp: NOW_S - 301 }] }), "reauth_required");
  assert.equal(freshCode({}), "reauth_required");
  assert.equal(freshCode({ amr: "oauth" }), "reauth_required");
  assert.equal(freshCode({ amr: [{ method: "password", timestamp: NOW_S }] }), "reauth_required");
  assert.equal(freshCode({ amr: [{ method: "token_refresh", timestamp: NOW_S }] }), "reauth_required");
  assert.equal(freshCode({ amr: [{ method: "oauth", timestamp: String(NOW_S) }] }), "reauth_required");
  assert.equal(freshCode({ amr: [{ method: "oauth", timestamp: NOW_S + 3600 }] }), "reauth_required");
});
