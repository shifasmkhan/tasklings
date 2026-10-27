// Caller identity for edge functions.
//
// The gateway verifies the JWT signature (verify_jwt = true in config.toml). Each function then
// asks Supabase Auth for the user with the same token (getUser), which also rejects tokens for
// deleted users or revoked sessions. Claims are decoded locally only after that check succeeds.

import { HttpError } from "./http.ts";

export interface AuthedUser {
  id: string;
  token: string;
  claims: Record<string, unknown>;
}

/** Resolves a bearer token to a user id, or null if Auth rejects it. */
export type GetUser = (token: string) => Promise<{ id: string } | null>;

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header);
  return m ? m[1] : null;
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const value: unknown = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))),
    );
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function requireUser(req: Request, getUser: GetUser): Promise<AuthedUser> {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, "unauthenticated", "A user access token is required");
  const user = await getUser(token);
  const claims = decodeJwtPayload(token);
  if (!user || !claims || claims.sub !== user.id || claims.role !== "authenticated") {
    throw new HttpError(401, "unauthenticated", "Invalid or expired session");
  }
  return { id: user.id, token, claims };
}

/**
 * Sign-in methods that count as a fresh Sign in with Apple. Supabase records the sign-in in the
 * `amr` claim as [{method, timestamp}], and keeps the original entry across token refreshes, so
 * amr.timestamp is the time of the actual sign-in. `iat` is not used: it changes on every
 * refresh and proves nothing about when the user last authenticated.
 * Sign in with Apple via signInWithIdToken is recorded as "oauth"; "id_token" is accepted in
 * case Auth names it that way. Anything else (password, otp, token_refresh, ...) fails closed.
 */
export const FRESH_AUTH_METHODS: readonly string[] = ["oauth", "id_token"];
export const MAX_SESSION_AGE_SECONDS = 5 * 60;
const CLOCK_SKEW_SECONDS = 60;

/** Seconds since the most recent qualifying sign-in, or null if the token has none. */
export function sessionAgeSeconds(claims: Record<string, unknown>, nowSeconds: number): number | null {
  const amr = claims.amr;
  if (!Array.isArray(amr)) return null;
  let latest: number | null = null;
  for (const entry of amr) {
    if (typeof entry !== "object" || entry === null) continue;
    const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
    if (typeof method !== "string" || !FRESH_AUTH_METHODS.includes(method)) continue;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) continue;
    if (latest === null || timestamp > latest) latest = timestamp;
  }
  return latest === null ? null : nowSeconds - latest;
}

/** export-data and delete-account: the Apple sign-in must be under 5 minutes old. */
export function requireFreshSession(claims: Record<string, unknown>, now: Date): void {
  const age = sessionAgeSeconds(claims, Math.floor(now.getTime() / 1000));
  if (age === null || age > MAX_SESSION_AGE_SECONDS || age < -CLOCK_SKEW_SECONDS) {
    throw new HttpError(403, "reauth_required", "Sign in with Apple again to continue");
  }
}
