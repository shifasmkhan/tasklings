export const DEFAULT_BRIEF_TIME = '08:00';
export const DEFAULT_CHECKIN_TIME = '20:30';
/** The stepper moves in quarter hours. */
export const TIME_STEP_MIN = 15;

const DAY_MIN = 24 * 60;

export function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function fromMinutes(total: number): string {
  const t = ((total % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Moves a "HH:MM" time by whole steps (negative = earlier), wrapping around midnight. */
export function shiftTime(time: string, steps: number): string {
  return fromMinutes(toMinutes(time) + steps * TIME_STEP_MIN);
}

/** "08:00" -> "8:00 AM". */
export function formatTime(time: string): string {
  const total = toMinutes(time);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
