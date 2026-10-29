import type { IsoDate } from '@/api/types';

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local calendar date on this device as YYYY-MM-DD. */
export function localIsoDate(date: Date = new Date()): IsoDate {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Adds whole days to a YYYY-MM-DD date. */
export function addDays(iso: IsoDate, days: number): IsoDate {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return localIsoDate(new Date(y, m - 1, d + days));
}

export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "HH:MM" (24-hour) to a 12-hour label such as "7:30 AM". Anything else is returned unchanged. */
export function formatClockTime(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const hour = Number(m[1]);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${m[2]} ${hour < 12 ? 'AM' : 'PM'}`;
}
