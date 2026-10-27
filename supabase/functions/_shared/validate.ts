// Small, dependency-free validators for edge function input.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

// IANA names only ("America/Chicago", "UTC"); Intl also accepts offsets like "+05:30",
// which Postgres would read differently, so those are refused up front.
const TZ_NAME_RE = /^(?:[A-Za-z][A-Za-z0-9_+-]*)(?:\/[A-Za-z0-9][A-Za-z0-9_+-]*){0,2}$/;

export function isIanaTimeZone(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 64 || !TZ_NAME_RE.test(v)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
    return true;
  } catch {
    return false;
  }
}

// RFC 3339 with an explicit offset or Z, e.g. 2026-10-27T09:00:00Z or 2026-10-27T09:00:00.123-05:00.
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseTimestamp(v: unknown): Date | null {
  if (typeof v !== "string" || !TIMESTAMP_RE.test(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
