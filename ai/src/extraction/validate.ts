// US-03: strict validator for model output. Dependency-free, web-standard
// APIs only (Deno + Node). Every rule in the PRD's extraction contract is
// enforced here; anything that fails is rejected, never repaired, so the
// pipeline can retry once and then fall back (see extract.ts).

import { LIMITS, TASK_KINDS } from "./schema.ts";
import type { ExtractedTask, ExtractionOutput, TaskKind } from "./schema.ts";

export type ValidationCode =
  | "raw_too_long"
  | "not_json"
  | "not_object"
  | "missing_field"
  | "extra_field"
  | "tasks_not_array"
  | "too_many_tasks"
  | "task_not_object"
  | "title_type"
  | "title_empty"
  | "title_untrimmed"
  | "title_too_long"
  | "title_control_chars"
  | "title_url"
  | "title_email"
  | "title_phone"
  | "kind_invalid"
  | "effort_type"
  | "effort_range"
  | "due_date_type"
  | "due_date_format"
  | "due_date_invalid";

export interface ValidationError {
  code: ValidationCode;
  /** JSON-pointer-ish location, e.g. "/tasks/2/title". Never contains model text. */
  path: string;
}

export type ValidationResult =
  | { ok: true; value: ExtractionOutput }
  | { ok: false; errors: ValidationError[] };

/** Generous ceiling on raw model output; 10 maximal tasks fit in ~1.5 KB. */
export const MAX_RAW_CHARS = 8000;

const TOP_LEVEL_KEYS = ["tasks"] as const;
const TASK_KEYS = ["title", "kind", "effort_min", "due_date"] as const;

// C0/C1 controls, zero-width space/non-joiner, LRM/RLM, bidi embeddings and
// overrides, bidi isolates, BOM. ZWJ (U+200D) is allowed for emoji sequences.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u200b\u200c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const URL_LIKE =
  /(?:\b(?:https?|ftp|file|javascript|data|mailto|tel|sms):)|(?:\bwww\.)|(?:\b[a-z0-9-]+\.(?:com|net|org|io|ly|co|app|dev|xyz|info|biz|me|gg|link|ru|cn|tk|top|site|online|click)\b)/i;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
// 7+ digits, optionally separated by spaces, dots, dashes or parentheses,
// optionally led by "+". ISO dates are removed first so "2026-11-05" passes.
const PHONE_LIKE = /\+?\d(?:[\s().-]*\d){6,}/;
const ISO_DATE_IN_TEXT = /\b\d{4}-\d{2}-\d{2}\b/g;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Calendar-valid YYYY-MM-DD (rejects 2026-02-30, 2026-13-01). */
export function isIsoDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= dim;
}

/** Title length in Unicode code points, which is what Postgres char_length counts. */
export function titleLength(title: string): number {
  return [...title].length;
}

function checkKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: ValidationError[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push({ code: "extra_field", path: `${path}/${escapePointer(key)}` });
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      errors.push({ code: "missing_field", path: `${path}/${key}` });
    }
  }
}

function escapePointer(key: string): string {
  // Keep paths short and free of model-controlled content beyond a key name.
  const safe = key.replace(/~/g, "~0").replace(/\//g, "~1");
  return safe.length > 40 ? `${safe.slice(0, 40)}...` : safe;
}

/** Checks title content rules beyond type and length. Exported for reuse in tests and the scorer. */
export function titleContentErrors(title: string): ValidationCode[] {
  const codes: ValidationCode[] = [];
  if (CONTROL_CHARS.test(title)) codes.push("title_control_chars");
  if (URL_LIKE.test(title)) codes.push("title_url");
  if (EMAIL_LIKE.test(title)) codes.push("title_email");
  if (PHONE_LIKE.test(title.replace(ISO_DATE_IN_TEXT, " "))) codes.push("title_phone");
  return codes;
}

function validateTask(t: unknown, path: string, errors: ValidationError[]): void {
  if (!isPlainObject(t)) {
    errors.push({ code: "task_not_object", path });
    return;
  }
  checkKeys(t, TASK_KEYS, path, errors);

  const title = t.title;
  if ("title" in t) {
    if (typeof title !== "string") {
      errors.push({ code: "title_type", path: `${path}/title` });
    } else if (title.trim().length === 0) {
      errors.push({ code: "title_empty", path: `${path}/title` });
    } else {
      if (title !== title.trim()) errors.push({ code: "title_untrimmed", path: `${path}/title` });
      if (titleLength(title) > LIMITS.maxTitleChars) errors.push({ code: "title_too_long", path: `${path}/title` });
      for (const code of titleContentErrors(title)) errors.push({ code, path: `${path}/title` });
    }
  }

  if ("kind" in t && !(typeof t.kind === "string" && (TASK_KINDS as readonly string[]).includes(t.kind))) {
    errors.push({ code: "kind_invalid", path: `${path}/kind` });
  }

  if ("effort_min" in t) {
    const e = t.effort_min;
    if (typeof e !== "number" || !Number.isInteger(e)) {
      errors.push({ code: "effort_type", path: `${path}/effort_min` });
    } else if (e < LIMITS.minEffortMin || e > LIMITS.maxEffortMin) {
      errors.push({ code: "effort_range", path: `${path}/effort_min` });
    }
  }

  if ("due_date" in t) {
    const d = t.due_date;
    if (d !== null) {
      if (typeof d !== "string") errors.push({ code: "due_date_type", path: `${path}/due_date` });
      else if (!ISO_DATE.test(d)) errors.push({ code: "due_date_format", path: `${path}/due_date` });
      else if (!isIsoDate(d)) errors.push({ code: "due_date_invalid", path: `${path}/due_date` });
    }
  }
}

/** Validates an already-parsed value against the extraction contract. */
export function validateExtraction(value: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  if (!isPlainObject(value)) return { ok: false, errors: [{ code: "not_object", path: "" }] };

  checkKeys(value, TOP_LEVEL_KEYS, "", errors);
  if ("tasks" in value) {
    const tasks = value.tasks;
    if (!Array.isArray(tasks)) {
      errors.push({ code: "tasks_not_array", path: "/tasks" });
    } else {
      if (tasks.length > LIMITS.maxTasks) errors.push({ code: "too_many_tasks", path: "/tasks" });
      // Validate at most maxTasks + 1 items: enough to report, bounded work.
      tasks.slice(0, LIMITS.maxTasks + 1).forEach((t, i) => validateTask(t, `/tasks/${i}`, errors));
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const tasks = (value.tasks as Record<string, unknown>[]).map(
    (t): ExtractedTask => ({
      title: t.title as string,
      kind: t.kind as TaskKind,
      effort_min: t.effort_min as number,
      due_date: t.due_date as string | null,
    }),
  );
  return { ok: true, value: { tasks } };
}

/**
 * Parses raw model text and validates it. The whole response (after trimming
 * whitespace) must be one JSON object: no prose, no Markdown fences.
 */
export function parseAndValidate(raw: string): ValidationResult {
  if (raw.length > MAX_RAW_CHARS) return { ok: false, errors: [{ code: "raw_too_long", path: "" }] };
  const text = raw.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return { ok: false, errors: [{ code: "not_json", path: "" }] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: [{ code: "not_json", path: "" }] };
  }
  return validateExtraction(parsed);
}
