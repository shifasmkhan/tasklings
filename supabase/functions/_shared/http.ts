// Standard responses and request parsing shared by every edge function.
// Error bodies are always {"error": {"code": "...", "message": "..."}} with a stable code
// (full list: supabase/README.md). Messages are for developers and never echo user content.

export type ErrorCode =
  | "unauthenticated"
  | "invalid_request"
  | "method_not_allowed"
  | "unsupported_media_type"
  | "payload_too_large"
  | "reauth_required"
  | "capture_conflict"
  | "internal_error";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export function errorResponse(status: number, code: ErrorCode, message: string): Response {
  return json(status, { error: { code, message } });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

/** Thrown inside handlers to return a standard error; caught by withErrors. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: ErrorCode, message: string) {
    super(message);
  }
}

/** Wraps a handler so any HttpError becomes a standard error and anything else a bare 500. */
export function withErrors(
  name: string,
  handler: (req: Request) => Promise<Response>,
  log: (event: string, fields: Record<string, string | number | boolean>) => void,
): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err.status, err.code, err.message);
      // Never log the error object: driver errors can include row values.
      log("unhandled_error", { fn: name, kind: err instanceof Error ? err.name : typeof err });
      return errorResponse(500, "internal_error", "Something went wrong");
    }
  };
}

export const MAX_BODY_BYTES = 64 * 1024;

/** Reads a body up to maxBytes without trusting Content-Length. Returns "" for no body. */
export async function readBodyText(req: Request, maxBytes = MAX_BODY_BYTES): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new HttpError(413, "payload_too_large", "Request body is too large");
  }
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "payload_too_large", "Request body is too large");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new HttpError(400, "invalid_request", "Body must be UTF-8");
  }
}

export function requirePost(req: Request): void {
  if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST");
}

function isJsonContentType(req: Request): boolean {
  const ct = req.headers.get("content-type") ?? "";
  return /^application\/json\s*(;|$)/i.test(ct);
}

/** Parses a JSON object body. Non-objects (arrays, strings, null) are rejected. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  if (!isJsonContentType(req)) {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const text = await readBodyText(req);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_request", "Body must be a JSON object");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "Body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

/** For contracts whose request is "none": accept no body or an empty JSON object only. */
export async function requireEmptyBody(req: Request): Promise<void> {
  const text = (await readBodyText(req, 1024)).trim();
  if (text === "") return;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_request", "This endpoint takes no body");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length > 0) {
    throw new HttpError(400, "invalid_request", "This endpoint takes no body");
  }
}

/** Rejects fields outside the contract so typos and smuggled columns fail loudly. */
export function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    // Field names come from the client; report only how many to keep logs and replies content-free.
    throw new HttpError(400, "invalid_request", `Unexpected field(s): ${extra.length}`);
  }
}
