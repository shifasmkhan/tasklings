// delete-account (US-11, TM-02). Request: POST {"apple_authorization_code": "<string>"}. Response: 204.
// Needs a Sign in with Apple under 5 minutes old; the code is the one-time authorization code from
// that same sign-in. The caller is identified with their own JWT; only then is the service role
// used, and only for that user id: revoke the Apple sign-in with the code, then delete the auth
// user (every table cascades from auth.users). No Apple token is ever stored.
// This is the only function allowed to use the service-role key.
//
// Failure policy: if Apple says the code is invalid (expired or used), nothing is deleted and the
// app asks the person to sign in again (400 apple_code_invalid). If Apple is unreachable, answers
// 5xx or is not configured, the account is still deleted: the person's right to delete wins.

import { type GetUser, requireFreshSession, requireUser } from "../_shared/auth.ts";
import type { RevocationOutcome } from "../_shared/apple.ts";
import {
  HttpError,
  noContent,
  readJsonObject,
  rejectUnknownFields,
  requirePost,
  withErrors,
} from "../_shared/http.ts";
import type { Logger } from "../_shared/log.ts";

export interface AdminStore {
  deleteUser(userId: string): Promise<void>;
}

export interface Deps {
  getUser: GetUser;
  admin: () => AdminStore;
  /** Exchanges the one-time code with Apple and revokes at once. Must not throw. */
  revokeApple: (authorizationCode: string) => Promise<RevocationOutcome>;
  now: () => Date;
  log: Logger;
}

const CODE_RE = /^[A-Za-z0-9._-]{1,2048}$/;

function parseBody(body: Record<string, unknown>): string {
  rejectUnknownFields(body, ["apple_authorization_code"]);
  const code = body.apple_authorization_code;
  if (typeof code !== "string" || !CODE_RE.test(code)) {
    throw new HttpError(400, "invalid_request", "apple_authorization_code is missing or invalid");
  }
  return code;
}

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  return withErrors("delete-account", async (req) => {
    requirePost(req);
    const user = await requireUser(req, deps.getUser);
    requireFreshSession(user.claims, deps.now());
    const code = parseBody(await readJsonObject(req, 8 * 1024));

    const revocation = await deps.revokeApple(code);
    if (revocation === "code_invalid") {
      deps.log("account_delete_refused", {
        fn: "delete-account",
        user_id: user.id,
        apple_revocation: revocation,
      });
      throw new HttpError(400, "apple_code_invalid", "Sign in with Apple again");
    }
    await deps.admin().deleteUser(user.id);
    deps.log("account_deleted", { fn: "delete-account", user_id: user.id, apple_revocation: revocation });
    return noContent();
  }, deps.log);
}
