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

/**
 * Maps the standard error body {"error": {"code": "...", "message": "..."}} to an ApiError.
 * Anything else becomes a bad_response error so callers never see raw server bodies.
 */
export function toApiError(body: unknown, status: number | null): ApiError {
  if (isRecord(body) && isRecord(body.error)) {
    const { code, message } = body.error;
    if (typeof code === 'string' && code.length > 0) {
      return new ApiError(code, typeof message === 'string' ? message : '', status);
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
