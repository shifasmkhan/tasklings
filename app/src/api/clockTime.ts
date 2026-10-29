import { ApiError } from './errors';
import type { ClockTime } from './types';

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const HH_MM_SS = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d(\.\d+)?)?$/;

/** Throws `invalid_request` unless the value is "HH:MM" from 00:00 to 23:59. */
export function assertClockTime(value: unknown): asserts value is ClockTime {
  if (typeof value !== 'string' || !HH_MM.test(value)) {
    throw new ApiError('invalid_request', 'Time must be HH:MM, 00:00 to 23:59', 400);
  }
}

/** Postgres `time` ("HH:MM:SS") to "HH:MM". Anything else is a bad_response. */
export function normalizeClockTime(value: unknown): ClockTime {
  if (typeof value === 'string') {
    const m = HH_MM_SS.exec(value);
    if (m) return `${m[1]}:${m[2]}`;
  }
  throw new ApiError('bad_response', 'Unexpected time value');
}
