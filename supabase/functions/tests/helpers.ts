// Test helpers. Tokens here are unsigned synthetic JWTs: signature checks happen at the gateway
// and in Supabase Auth (faked by fakeGetUser), not in the handlers under test.

import type { GetUser } from "../_shared/auth.ts";
import type { LogFields } from "../_shared/log.ts";

export const USER_A = "00000000-0000-4000-a000-00000000000a";
export const NOW = new Date("2026-10-27T15:00:00Z");
export const NOW_S = Math.floor(NOW.getTime() / 1000);

function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fakeJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}.c2lnbmF0dXJl`;
}

/** Signed in with Apple `ageSeconds` ago. */
export function tokenFor(userId = USER_A, ageSeconds = 30, method = "oauth"): string {
  return fakeJwt({
    sub: userId,
    role: "authenticated",
    aud: "authenticated",
    iat: NOW_S - 10,
    exp: NOW_S + 3600,
    amr: [{ method, timestamp: NOW_S - ageSeconds }],
  });
}

/** Auth accepts any token whose sub is in `valid`. */
export function fakeGetUser(valid: string[] = [USER_A]): GetUser {
  return (token) => {
    const sub = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub;
    return Promise.resolve(valid.includes(sub) ? { id: sub } : null);
  };
}

export function recordingLog(): {
  events: { event: string; fields: LogFields }[];
  log: (e: string, f: LogFields) => void;
} {
  const events: { event: string; fields: LogFields }[] = [];
  return { events, log: (event, fields) => events.push({ event, fields }) };
}

export function post(
  path: string,
  body: unknown,
  token: string | null,
  contentType = "application/json",
): Request {
  const headers: Record<string, string> = { "content-type": contentType };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost/functions/v1/${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

export async function errorCode(res: Response): Promise<string> {
  const body = await res.json();
  if (!body?.error || typeof body.error.code !== "string" || typeof body.error.message !== "string") {
    throw new Error(`not a standard error body: ${JSON.stringify(body)}`);
  }
  return body.error.code;
}
