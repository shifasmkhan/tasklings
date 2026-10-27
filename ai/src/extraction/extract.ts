// US-03: extraction pipeline. Call the model, validate strictly, retry once
// on invalid output, then fall back to one task with needsReview: true (stored
// as tasks.needs_review; PRD: "else reject, retry once, then save transcript
// as one task flagged for review"). A valid {"tasks":[]} is a normal result:
// status "ok" with no tasks to save. Model-agnostic: the caller supplies a ModelClient, so the edge
// function can use fetch and the eval harness can use the Anthropic SDK.
// Never logs; results carry validator codes only, never transcript text.

import { buildUserMessage, localDateInfo, newNonce, retryNote, SYSTEM_PROMPT, PROMPT_VERSION } from "./prompt.ts";
import type { ExtractedTask } from "./schema.ts";
import { parseAndValidate } from "./validate.ts";
import type { ValidationCode } from "./validate.ts";

export interface ModelRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export interface ModelClient {
  /** Returns the model's text reply. May throw on transport or API errors. */
  complete(req: ModelRequest): Promise<string>;
}

export interface ExtractInput {
  transcript: string;
  /** When the note was captured (process-capture's captured_at). */
  capturedAt: Date;
  /** IANA time zone (profiles.timezone / the request's time zone). */
  timeZone: string;
}

export type FallbackReason =
  | "invalid_output" // two attempts failed validation (or the model call threw)
  | "empty_transcript"
  | "transcript_too_long";

export interface AttemptRecord {
  valid: boolean;
  /** Validator codes, or "model_error" if the call threw. */
  codes: Array<ValidationCode | "model_error">;
  /** Raw model text, for eval scorecards only. Callers in production must not log or persist it. */
  raw?: string;
}

export type ExtractionResult =
  | { status: "ok"; tasks: ExtractedTask[]; needsReview: false; attempts: AttemptRecord[]; promptVersion: string }
  | {
      status: "fallback";
      tasks: [ExtractedTask];
      needsReview: true;
      reason: FallbackReason;
      attempts: AttemptRecord[];
      promptVersion: string;
    };

export const MAX_TRANSCRIPT_CHARS = 20_000;
export const MAX_OUTPUT_TOKENS = 1024;

/**
 * The single task saved when extraction fails. Its title is fixed rather than
 * derived from the transcript so a hostile note can't shape it; the caller
 * keeps the transcript (captures.transcript) for the user to review.
 */
export const FALLBACK_TASK: Readonly<ExtractedTask> = Object.freeze({
  title: "Review this voice note",
  kind: "quick",
  effort_min: 5,
  due_date: null,
});

export interface ExtractOptions {
  /** Keep raw model text in attempts (eval harness only). Default false. */
  keepRaw?: boolean;
  /** Override the nonce source (tests). */
  nonce?: () => string;
}

function fallback(reason: FallbackReason, attempts: AttemptRecord[]): ExtractionResult {
  return {
    status: "fallback",
    tasks: [{ ...FALLBACK_TASK }],
    needsReview: true,
    reason,
    attempts,
    promptVersion: PROMPT_VERSION,
  };
}

export async function extractTasks(input: ExtractInput, client: ModelClient, opts: ExtractOptions = {}): Promise<ExtractionResult> {
  const attempts: AttemptRecord[] = [];
  if (input.transcript.trim().length === 0) return fallback("empty_transcript", attempts);
  if (input.transcript.length > MAX_TRANSCRIPT_CHARS) return fallback("transcript_too_long", attempts);

  // Throws RangeError on a bad time zone or date: that's a caller bug, not model output.
  const { today, weekday } = localDateInfo(input.capturedAt, input.timeZone);
  const baseUser = buildUserMessage({
    transcript: input.transcript,
    today,
    weekday,
    timeZone: input.timeZone,
    nonce: (opts.nonce ?? newNonce)(),
  });

  let lastCodes: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = attempt === 0 ? baseUser : baseUser + retryNote(lastCodes);
    let raw: string;
    try {
      raw = await client.complete({ system: SYSTEM_PROMPT, user, maxTokens: MAX_OUTPUT_TOKENS });
    } catch {
      attempts.push({ valid: false, codes: ["model_error"] });
      lastCodes = ["model_error"];
      continue;
    }
    const result = parseAndValidate(raw);
    const record: AttemptRecord = result.ok
      ? { valid: true, codes: [] }
      : { valid: false, codes: [...new Set(result.errors.map((e) => e.code))] };
    if (opts.keepRaw) record.raw = raw;
    attempts.push(record);

    if (result.ok) {
      return { status: "ok", tasks: result.value.tasks, needsReview: false, attempts, promptVersion: PROMPT_VERSION };
    }
    lastCodes = record.codes;
  }
  return fallback("invalid_output", attempts);
}
