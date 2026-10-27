/** Codes the app produces itself, beside the backend's stable codes. */
export const CLIENT_ERROR_CODES = {
  network: 'network_error',
  badResponse: 'bad_response',
  unknown: 'unknown_error',
  /** PostgREST platform error with no stable code, HTTP 401 or 403 (supabase/README.md). */
  forbidden: 'forbidden',
  /** PostgREST platform error with no stable code, any other status (supabase/README.md). */
  internal: 'internal_error',
} as const;

/**
 * Every API failure surfaces as an ApiError carrying the backend's stable code.
 * The message is for developers; UI copy comes from the code, never from the message.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stable codes are snake_case identifiers (supabase/README.md). Anything else is not one. */
const STABLE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * PostgREST always sends all four keys; `code` is the SQLSTATE or a PGRSTxxx code.
 * That's enough to tell it from a proxy page or some other JSON body.
 */
function isPostgrestError(body: unknown): body is Record<string, unknown> & { code: string; message: string } {
  return (
    isRecord(body) &&
    typeof body.code === 'string' &&
    typeof body.message === 'string' &&
    'details' in body &&
    'hint' in body
  );
}

/**
 * Maps a backend error body to an ApiError (supabase/README.md, backend PR #4):
 * - edge functions: {"error": {"code": "...", "message": "..."}} -> {code, message}
 * - RPCs and table writes (PostgREST): {"code", "message", "details", "hint"}. Our errors are
 *   raised with SQLSTATE PTxxx (HTTP xxx) and carry the stable code in `hint`, so they map to
 *   {code: hint, message: details}. A PostgREST error with no valid hint is a platform error
 *   (e.g. 42501 permission denied, 23505 duplicate): HTTP 401/403 -> forbidden, anything
 *   else -> internal_error. Its server text is never passed through.
 * - any other body -> bad_response, again without echoing it.
 */
export function toApiError(body: unknown, status: number | null): ApiError {
  if (isRecord(body) && isRecord(body.error)) {
    const { code, message } = body.error;
    if (typeof code === 'string' && STABLE_CODE.test(code)) {
      return new ApiError(code, typeof message === 'string' ? message : '', status);
    }
  }
  if (isPostgrestError(body)) {
    const { hint, details } = body;
    if (typeof hint === 'string' && STABLE_CODE.test(hint)) {
      return new ApiError(hint, typeof details === 'string' ? details : '', status);
    }
    const suffix = status === null ? '' : ` (HTTP ${status})`;
    return status === 401 || status === 403
      ? new ApiError(CLIENT_ERROR_CODES.forbidden, `Request not allowed${suffix}`, status)
      : new ApiError(CLIENT_ERROR_CODES.internal, `Server error${suffix}`, status);
  }
  return new ApiError(
    CLIENT_ERROR_CODES.badResponse,
    `Unexpected error response${status === null ? '' : ` (HTTP ${status})`}`,
    status,
  );
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
