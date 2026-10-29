import { isApiError } from '@/api/errors';
import type { ClockTime } from '@/api/types';

/** Dropped tasks stay restorable this long (US-09). Mirrors the API's recentlyDropped window. */
export const RECENTLY_DROPPED_DAYS = 30;

export const TIMES_FOOTNOTE = 'Reminders start once notifications are turned on.';
export const EMPTY_DROPPED_TEXT = `Nothing dropped in the last ${RECENTLY_DROPPED_DAYS} days.`;
export const TIME_SAVE_ERROR = "Couldn't save that time. It was put back.";
export const RESTORE_ERROR = "Couldn't restore that. Try again.";
export const RESTORED_MESSAGE = 'Restored. It’s back on Today.';
export const DELETE_COPY = 'This deletes your account, all tasks and notes. It can’t be undone.';
export const EXPORT_DONE = 'Your data is ready to save or share.';

export type TimeKind = 'briefTime' | 'checkinTime';

/** "HH:MM" to a Date today at that clock time, for the native picker. */
export function clockToDate(hhmm: ClockTime, base: Date = new Date()): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

/** The picker's Date to "HH:MM" in the device's clock. */
export function dateToClock(date: Date): ClockTime {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export type DataAction = 'export' | 'delete';

/**
 * What to say when export or delete fails. Copy comes from the code, never from the server's
 * message. `null` means say nothing (the person cancelled).
 */
export function dataErrorMessage(err: unknown): string | null {
  const code = isApiError(err) ? err.code : 'unknown_error';
  switch (code) {
    case 'canceled':
      return null;
    case 'unauthenticated':
      return "Sign in with Apple isn't set up yet.";
    case 'reauth_required':
      return 'For your security, sign in with Apple again, then try once more.';
    case 'network_error':
      return "Couldn't reach the server. Check your connection and try again.";
    default:
      return 'Something went wrong. Try again.';
  }
}

/** Error code for logs: never the message. */
export function codeOf(err: unknown): string {
  return isApiError(err) ? err.code : 'unknown_error';
}

/** Name of the export file, with the date only. */
export function exportFileName(today: string): string {
  return `tasklings-export-${today}.json`;
}
