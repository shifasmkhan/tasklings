// register-device (US-06 groundwork). Request: POST {apns_token}. Response: 204.
// Upserts (user_id, apns_token) with the caller's JWT and bumps last_seen_at.

import { type GetUser, requireUser } from "../_shared/auth.ts";
import {
  HttpError,
  noContent,
  readJsonObject,
  rejectUnknownFields,
  requirePost,
  withErrors,
} from "../_shared/http.ts";
import type { Logger } from "../_shared/log.ts";

// APNs device tokens are hex; Apple says not to assume a fixed length (32 bytes today).
const APNS_TOKEN_RE = /^[0-9a-f]{64,200}$/;

export interface DeviceStore {
  upsertDevice(apnsToken: string, seenAt: Date): Promise<void>;
}

export interface Deps {
  getUser: GetUser;
  store: (token: string) => DeviceStore;
  now: () => Date;
  log: Logger;
}

export function parseDeviceRequest(body: Record<string, unknown>): string {
  rejectUnknownFields(body, ["apns_token"]);
  const raw = body.apns_token;
  if (typeof raw !== "string") throw new HttpError(400, "invalid_request", "apns_token must be a string");
  const token = raw.toLowerCase();
  if (!APNS_TOKEN_RE.test(token)) {
    throw new HttpError(400, "invalid_request", "apns_token must be 64-200 hex characters");
  }
  return token;
}

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  return withErrors("register-device", async (req) => {
    requirePost(req);
    const user = await requireUser(req, deps.getUser);
    const apnsToken = parseDeviceRequest(await readJsonObject(req));
    await deps.store(user.token).upsertDevice(apnsToken, deps.now());
    // The APNs token is a credential for pushing to the device: never log it.
    deps.log("device_registered", { fn: "register-device", user_id: user.id });
    return noContent();
  }, deps.log);
}
