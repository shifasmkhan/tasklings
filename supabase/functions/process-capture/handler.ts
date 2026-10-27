// process-capture (US-04 stub of the US-01/US-03 pipeline).
// Request:  POST {capture_id, transcript, captured_at, timezone}
// Response: 202 {capture_id}; tasks arrive by realtime on public.tasks.
//
// Phase 0 stub: no model call. It records the capture and inserts canned synthetic tasks so the
// app's realtime path can be built end to end. Everything runs with the caller's JWT (RLS).
// captured_at and timezone are validated and reserved for the real pipeline, which needs them to
// resolve relative dates ("tomorrow") in the transcript; planned_for comes from the database
// (the user's today in the profile time zone).

import { type GetUser, requireUser } from "../_shared/auth.ts";
import {
  HttpError,
  json,
  readJsonObject,
  rejectUnknownFields,
  requirePost,
  withErrors,
} from "../_shared/http.ts";
import type { Logger } from "../_shared/log.ts";
import { isIanaTimeZone, isUuid, parseTimestamp } from "../_shared/validate.ts";

export const MAX_TRANSCRIPT_CHARS = 10_000;
const MAX_CAPTURE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // offline queue tolerance
const MAX_CLOCK_AHEAD_MS = 5 * 60 * 1000;

export interface CaptureRequest {
  capture_id: string;
  transcript: string;
  captured_at: Date;
  timezone: string;
}

/** Shape of one extracted task (matches the PRD extraction output). */
export interface ExtractedTask {
  title: string;
  kind: "quick" | "errand" | "project";
  effort_min: number;
  due_date: string | null;
}

/** Canned output used until the AI pipeline lands. Synthetic; never derived from the transcript. */
export const STUB_TASKS: readonly ExtractedTask[] = [
  { title: "Review your new capture", kind: "quick", effort_min: 5, due_date: null },
  { title: "Pick up the sample parcel", kind: "errand", effort_min: 20, due_date: null },
];

export type InsertCaptureResult = "created" | "exists" | "conflict";

/** Data access, bound to the caller's JWT. */
export interface CaptureStore {
  insertCapture(id: string, transcript: string): Promise<InsertCaptureResult>;
  insertTasks(captureId: string, tasks: readonly ExtractedTask[]): Promise<number>;
  setCaptureStatus(id: string, status: "done" | "failed", error?: string): Promise<void>;
}

export interface Deps {
  getUser: GetUser;
  store: (token: string) => CaptureStore;
  now: () => Date;
  log: Logger;
}

const FIELDS = ["capture_id", "transcript", "captured_at", "timezone"] as const;

export function parseCaptureRequest(body: Record<string, unknown>, now: Date): CaptureRequest {
  rejectUnknownFields(body, FIELDS);
  const { capture_id, transcript, captured_at, timezone } = body;
  if (!isUuid(capture_id)) throw new HttpError(400, "invalid_request", "capture_id must be a UUID");
  if (typeof transcript !== "string" || transcript.trim().length === 0) {
    throw new HttpError(400, "invalid_request", "transcript must be a non-empty string");
  }
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    throw new HttpError(
      400,
      "invalid_request",
      `transcript must be at most ${MAX_TRANSCRIPT_CHARS} characters`,
    );
  }
  const at = parseTimestamp(captured_at);
  if (!at) {
    throw new HttpError(400, "invalid_request", "captured_at must be an RFC 3339 timestamp with offset");
  }
  const delta = at.getTime() - now.getTime();
  if (delta > MAX_CLOCK_AHEAD_MS || -delta > MAX_CAPTURE_AGE_MS) {
    throw new HttpError(400, "invalid_request", "captured_at is out of range");
  }
  if (!isIanaTimeZone(timezone)) {
    throw new HttpError(400, "invalid_request", "timezone must be an IANA time zone");
  }
  return { capture_id: capture_id.toLowerCase(), transcript: transcript.trim(), captured_at: at, timezone };
}

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  return withErrors("process-capture", async (req) => {
    requirePost(req);
    const user = await requireUser(req, deps.getUser);
    const input = parseCaptureRequest(await readJsonObject(req), deps.now());
    const store = deps.store(user.token);

    const created = await store.insertCapture(input.capture_id, input.transcript);
    if (created === "conflict") {
      throw new HttpError(409, "capture_conflict", "capture_id is already in use");
    }
    if (created === "exists") {
      // Idempotent retry from the app's offline queue: already accepted.
      deps.log("capture_duplicate", { fn: "process-capture", capture_id: input.capture_id });
      return json(202, { capture_id: input.capture_id });
    }
    try {
      const n = await store.insertTasks(input.capture_id, STUB_TASKS);
      await store.setCaptureStatus(input.capture_id, "done");
      deps.log("capture_processed", {
        fn: "process-capture",
        capture_id: input.capture_id,
        tasks: n,
        stub: true,
      });
    } catch (err) {
      await store.setCaptureStatus(input.capture_id, "failed", "stub_insert_failed").catch(() => {});
      throw err;
    }
    return json(202, { capture_id: input.capture_id });
  }, deps.log);
}
