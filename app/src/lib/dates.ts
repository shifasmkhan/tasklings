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
