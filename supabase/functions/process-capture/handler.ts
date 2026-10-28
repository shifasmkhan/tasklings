// process-capture (US-03 extraction pipeline on top of the US-04 contract).
// Request:  POST {capture_id, transcript, captured_at, timezone, source?}  (source: voice|text|siri|widget, default voice)
// Response: 202 {capture_id}; tasks arrive by realtime on public.tasks.
//
// Flow: validate, save the capture as `parsing`, answer 202, then (in the background when the
// runtime has waitUntil, otherwise before answering) run the pipeline:
//   * ok       -> insert the extracted tasks (none for an empty list), capture `done`
//   * fallback -> insert the one fixed review task with needs_review = true, capture `done`
//   * a spend cap (per user or global) or a missing model key -> same as fallback, with no model call
//   * unexpected failure -> capture `failed` with a stable error code
// A retry with the same capture_id re-runs the pipeline only if the caller's capture is `failed`
// (it reserves a unit again). Captures stuck in `parsing` are failed by a cron sweeper.
// Everything runs with the caller's JWT (RLS). Logs carry IDs, codes and counts only: never the
// transcript, the prompt, model output or task titles.

import {
  type ExtractedTask,
  extractTasks,
  FALLBACK_TASK,
  MAX_TRANSCRIPT_CHARS as MODULE_MAX_TRANSCRIPT_CHARS,
  type ModelClient,
} from "@tasklings/extraction";
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

export type { ExtractedTask };

/** The 2-minute note cap: about 20,000 characters of transcript. */
export const MAX_TRANSCRIPT_CHARS = MODULE_MAX_TRANSCRIPT_CHARS;
/** 20,000 characters can need 6 bytes each as JSON \uXXXX escapes, plus the other fields. */
export const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_CAPTURE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // offline queue tolerance
const MAX_CLOCK_AHEAD_MS = 5 * 60 * 1000;

/** captures.source values. Typed notes send "text"; "siri" and "widget" are for the native targets. */
export const CAPTURE_SOURCES = ["voice", "text", "siri", "widget"] as const;
export type CaptureSource = typeof CAPTURE_SOURCES[number];
export const DEFAULT_CAPTURE_SOURCE: CaptureSource = "voice";

export interface CaptureRequest {
  capture_id: string;
  transcript: string;
  captured_at: Date;
  timezone: string;
  source: CaptureSource;
}

/** The extraction output may hold zero tasks (e.g. a transcript with nothing actionable). */
export const MIN_EXTRACTED_TASKS = 0;
export const MAX_EXTRACTED_TASKS = 10;

/** Stable values for captures.error when a capture ends as failed. */
export const ERROR_EXTRACTION_FAILED = "extraction_failed";
export const ERROR_TASKS_INSERT_FAILED = "tasks_insert_failed";

/** `retry`: the caller's own capture was `failed` and is now `parsing` again, so the pipeline re-runs. */
export type InsertCaptureResult = "created" | "exists" | "conflict" | "retry";
export type QuotaVerdict = "ok" | "user_cap" | "global_cap";

/** Data access, bound to the caller's JWT. */
export interface CaptureStore {
  insertCapture(id: string, transcript: string, source: CaptureSource): Promise<InsertCaptureResult>;
  insertTasks(captureId: string, tasks: readonly ExtractedTask[], needsReview: boolean): Promise<number>;
  setCaptureStatus(id: string, status: "done" | "failed", error?: string): Promise<void>;
  /** True when the capture already has tasks (a retry after a late failure must not duplicate them). */
  hasTasks(captureId: string): Promise<boolean>;
  /** public.reserve_extraction: reserves one extraction run for the caller, or says which cap is hit. */
  reserveExtraction(): Promise<QuotaVerdict>;
}

export interface Deps {
  getUser: GetUser;
  store: (token: string) => CaptureStore;
  now: () => Date;
  log: Logger;
  /** Null when no API key is configured: captures then save as one needs_review task. */
  model: ModelClient | null;
  /** EdgeRuntime.waitUntil when the runtime has it. Without it the pipeline finishes before the 202. */
  waitUntil?: (work: Promise<unknown>) => void;
}

const FIELDS = ["capture_id", "transcript", "captured_at", "timezone", "source"] as const;

export function parseCaptureRequest(body: Record<string, unknown>, now: Date): CaptureRequest {
  rejectUnknownFields(body, FIELDS);
  const { capture_id, transcript, captured_at, timezone, source } = body;
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
  // Optional; strict when present (no case folding, no null): anything else is invalid_request.
  if (source !== undefined && !CAPTURE_SOURCES.includes(source as CaptureSource)) {
    throw new HttpError(400, "invalid_request", `source must be one of ${CAPTURE_SOURCES.join(", ")}`);
  }
  return {
    capture_id: capture_id.toLowerCase(),
    transcript: transcript.trim(),
    captured_at: at,
    timezone,
    source: (source as CaptureSource | undefined) ?? DEFAULT_CAPTURE_SOURCE,
  };
}

/** Why a capture was saved without running the model. */
type SkipReason = "user_cap" | "global_cap" | "quota_unavailable" | "model_unconfigured";

class InsertFailed extends Error {}

/**
 * Runs the pipeline for one accepted capture. Never throws: any failure ends the capture as
 * `failed` with a stable code.
 */
export async function processCapture(
  deps: Deps,
  store: CaptureStore,
  input: CaptureRequest,
  isRetry = false,
): Promise<void> {
  const base = { fn: "process-capture", capture_id: input.capture_id };
  try {
    if (isRetry && await store.hasTasks(input.capture_id)) {
      // The earlier run got as far as saving tasks; only the status update was lost.
      await store.setCaptureStatus(input.capture_id, "done");
      deps.log("capture_processed", {
        ...base,
        outcome: "retry_already_saved",
        tasks: 0,
        needs_review: false,
      });
      return;
    }
    let tasks: readonly ExtractedTask[];
    let needsReview: boolean;
    let outcome: string;
    let skip: SkipReason | null = null;

    if (deps.model === null) {
      skip = "model_unconfigured";
    } else {
      try {
        const verdict = await store.reserveExtraction();
        if (verdict !== "ok") skip = verdict;
      } catch {
        // Fail closed on spend: if the counters can't be read, don't call the model.
        skip = "quota_unavailable";
      }
    }

    if (skip !== null || deps.model === null) {
      tasks = [{ ...FALLBACK_TASK }];
      needsReview = true;
      outcome = "skipped_" + skip;
      deps.log("capture_extraction_skipped", { ...base, reason: skip ?? "model_unconfigured" });
    } else {
      const result = await extractTasks(
        { transcript: input.transcript, capturedAt: input.captured_at, timeZone: input.timezone },
        deps.model,
      );
      tasks = result.tasks;
      needsReview = result.needsReview;
      outcome = result.status;
      deps.log("capture_extracted", {
        ...base,
        status: result.status,
        reason: result.status === "fallback" ? result.reason : "none",
        attempts: result.attempts.length,
        // Validator codes and model error codes only (no content).
        codes: result.attempts.flatMap((a) => a.codes).join(","),
        prompt_version: result.promptVersion,
      });
    }

    let n = 0;
    if (tasks.length > 0) {
      try {
        n = await store.insertTasks(input.capture_id, tasks, needsReview);
      } catch {
        throw new InsertFailed();
      }
    }
    await store.setCaptureStatus(input.capture_id, "done");
    deps.log("capture_processed", { ...base, outcome, tasks: n, needs_review: needsReview });
  } catch (err) {
    const code = err instanceof InsertFailed ? ERROR_TASKS_INSERT_FAILED : ERROR_EXTRACTION_FAILED;
    // Never log the error object: driver and parser errors can carry row or model content.
    deps.log("capture_failed", { ...base, error: code, kind: err instanceof Error ? err.name : typeof err });
    await store.setCaptureStatus(input.capture_id, "failed", code).catch(() => {
      deps.log("capture_status_update_failed", base);
    });
  }
}

export function createHandler(deps: Deps): (req: Request) => Promise<Response> {
  return withErrors("process-capture", async (req) => {
    requirePost(req);
    const user = await requireUser(req, deps.getUser);
    const input = parseCaptureRequest(await readJsonObject(req, MAX_REQUEST_BYTES), deps.now());
    const store = deps.store(user.token);

    const created = await store.insertCapture(input.capture_id, input.transcript, input.source);
    if (created === "conflict") {
      throw new HttpError(409, "capture_conflict", "capture_id is already in use");
    }
    if (created === "exists") {
      // Idempotent retry from the app's offline queue: already accepted.
      deps.log("capture_duplicate", { fn: "process-capture", capture_id: input.capture_id });
      return json(202, { capture_id: input.capture_id });
    }
    if (created === "retry") {
      deps.log("capture_retry", { fn: "process-capture", capture_id: input.capture_id });
    }
    const work = processCapture(deps, store, input, created === "retry");
    if (deps.waitUntil) deps.waitUntil(work);
    else await work;
    return json(202, { capture_id: input.capture_id });
  }, deps.log);
}
