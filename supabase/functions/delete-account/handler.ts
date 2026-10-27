// delete-account (US-09). Request: POST, no body. Response: 204.
// Needs a Sign in with Apple under 5 minutes old. The caller is identified with their own JWT;
// only then is the service role used, and only for that user id: read the Apple refresh token,
// revoke it with Apple, delete the auth user (every table cascades from auth.users).
// This is the only function allowed to use the service-role key.

import { type GetUser, requireFreshSession, requireUser } from "../_shared/auth.ts";
import { noContent, requireEmptyBody, requirePost, withErrors } from "../_shared/http.ts";
import type { Logger } from "../_shared/log.ts";

export type RevocationResult = "revoked" | "no_token" | "not_configured";

export interface AdminStore {
  /** Ciphertext of the stored Apple refresh token, or null. */
  appleRefreshToken(userId: string): Promise<string | null>;
  deleteUser(userId: string): Promise<void>;
}

export interface Deps {
  getUser: GetUser;
  admin: () => AdminStore;
  revokeApple: (refreshTokenCiphertext: string) => Promise<RevocationResult>;
  now: () => Date;
  log: Logger;
}

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  return withErrors("delete-account", async (req) => {
    requirePost(req);
    const user = await requireUser(req, deps.getUser);
    requireFreshSession(user.claims, deps.now());
    await requireEmptyBody(req);

    const admin = deps.admin();
    const token = await admin.appleRefreshToken(user.id);
    const revocation: RevocationResult = token ? await deps.revokeApple(token) : "no_token";
    await admin.deleteUser(user.id);
    deps.log("account_deleted", { fn: "delete-account", user_id: user.id, apple_revocation: revocation });
    return noContent();
  }, deps.log);
}
