/** Codes the app produces itself, beside the backend's stable codes. */
export const CLIENT_ERROR_CODES = {
  network: 'network_error',
  badResponse: 'bad_response',
  unknown: 'unknown_error',
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
 * Maps a backend error body to an ApiError. Two shapes carry a stable code:
 * - edge functions: {"error": {"code": "...", "message": "..."}}
 * - RPCs and table writes (PostgREST): {"code", "message", "details", "hint"}. Our errors are
 *   raised with SQLSTATE PTxxx (HTTP xxx) and put the stable code in `hint`; they map to
 *   {code: hint, message: details}.
 * Anything else, including a PostgREST platform error with no hint (e.g. 42501), becomes
 * bad_response, so callers never see raw server bodies.
 */
export function toApiError(body: unknown, status: number | null): ApiError {
  if (isRecord(body) && isRecord(body.error)) {
    const { code, message } = body.error;
    if (typeof code === 'string' && STABLE_CODE.test(code)) {
      return new ApiError(code, typeof message === 'string' ? message : '', status);
    }
  }
  if (isRecord(body) && typeof body.code === 'string' && typeof body.hint === 'string') {
    const { hint, details } = body;
    if (STABLE_CODE.test(hint)) {
      return new ApiError(hint, typeof details === 'string' ? details : '', status);
    }
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
