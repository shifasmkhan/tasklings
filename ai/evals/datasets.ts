// Loads the committed synthetic eval sets and checks them for structural
// problems and for anything that looks like real personal data.

import { readFileSync } from "node:fs";
import { localDateInfo } from "../src/extraction/prompt.ts";
import { isIsoDate, validateExtraction } from "../src/extraction/validate.ts";
import type { InjectionCase, InjectionSet, NoteCase, NoteSet } from "./types.ts";

const DATASET_DIR = new URL("./datasets/", import.meta.url);

export function loadNoteSet(): NoteSet {
  return JSON.parse(readFileSync(new URL("notes.json", DATASET_DIR), "utf8")) as NoteSet;
}

export function loadInjectionSet(): InjectionSet {
  return JSON.parse(readFileSync(new URL("injections.json", DATASET_DIR), "utf8")) as InjectionSet;
}

/** An instant whose local date in `timeZone` is `today` (noon UTC, nudged if needed). */
export function capturedAtFor(today: string, timeZone: string): Date {
  const noon = Date.parse(`${today}T12:00:00Z`);
  for (const h of [0, -6, 6, -11, 11]) {
    const at = new Date(noon + h * 3_600_000);
    if (localDateInfo(at, timeZone).today === today) return at;
  }
  throw new RangeError(`no instant maps to ${today} in ${timeZone}`);
}

// Synthetic-data guardrails. Phone numbers must be 555-01xx (reserved for
// fiction); emails and URLs must use example.* domains.
const PHONE = /\+?\d(?:[\s().-]*\d){6,}/g;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const URL_RE = /\bhttps?:\/\/([^/\s"]+)/g;
const STREET = /\b\d{1,5}\s+[A-Z][a-z]+\s+(?:Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd)\b/;

function isExampleDomain(host: string): boolean {
  return /(^|\.)example\.(com|net|org)$/i.test(host);
}

export function lintCase(c: NoteCase | InjectionCase): string[] {
  const problems: string[] = [];
  if (!/^[ni]\d{2}$/.test(c.id)) problems.push(`${c.id}: bad id`);
  if (!isIsoDate(c.today)) problems.push(`${c.id}: bad today`);
  try {
    capturedAtFor(c.today, c.time_zone);
  } catch {
    problems.push(`${c.id}: bad time_zone`);
  }
  if (c.transcript.trim().length === 0) problems.push(`${c.id}: empty transcript`);
  if (!Array.isArray(c.tags)) problems.push(`${c.id}: tags missing`);
  if (!validateExtraction({ tasks: c.expected }).ok) {
    problems.push(`${c.id}: expected tasks fail the validator`);
  }
  for (const t of c.expected) {
    if (t.due_date !== null && t.due_date < c.today) problems.push(`${c.id}: due_date before today`);
  }
  const text = c.transcript;
  for (const m of text.matchAll(PHONE)) {
    const digits = m[0].replace(/\D/g, "");
    if (!/55501\d\d$/.test(digits)) problems.push(`${c.id}: phone-like number outside 555-01xx`);
  }
  for (const m of text.matchAll(EMAIL)) if (!isExampleDomain(m[1] ?? "")) problems.push(`${c.id}: non-example email`);
  for (const m of text.matchAll(URL_RE)) if (!isExampleDomain(m[1] ?? "")) problems.push(`${c.id}: non-example URL`);
  if (STREET.test(text)) problems.push(`${c.id}: street address`);
  return problems;
}

export function lintSets(notes: NoteSet, injections: InjectionSet): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const c of [...notes.notes, ...injections.notes]) {
    if (ids.has(c.id)) problems.push(`${c.id}: duplicate id`);
    ids.add(c.id);
    problems.push(...lintCase(c));
  }
  if (notes.notes.length !== 50) problems.push(`note set has ${notes.notes.length} notes, expected 50`);
  if (injections.notes.length < 15) problems.push(`injection set has ${injections.notes.length} notes, expected >= 15`);
  for (const c of injections.notes) {
    if (!c.category) problems.push(`${c.id}: missing category`);
    if (!Array.isArray(c.forbidden) || c.forbidden.some((s) => typeof s !== "string" || s.length === 0)) {
      problems.push(`${c.id}: forbidden must be non-empty strings`);
    }
  }
  return problems;
}
