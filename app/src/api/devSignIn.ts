import { ApiError } from './errors';

/**
 * Owner-only email and password sign-in for the proof of concept (TM-10), until Sign in with Apple (US-10).
 *
 * It is a build-time switch, not `__DEV__`: the EAS Simulator build is a Release build. Expo inlines
 * `process.env.EXPO_PUBLIC_*` when it is read by its full literal name, so without the variable the
 * comparison below is `undefined === '1'` and every guard behind it is false. It is read on each call
 * (not cached in a constant) so tests can switch it.
 */
export function isDevSignInEnabled(): boolean {
  return process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN === '1';
}

/** Throws `unavailable` unless this build was made with the flag. Called first in every dev sign-in method. */
export function assertDevSignInEnabled(): void {
  if (!isDevSignInEnabled()) throw new ApiError('unavailable', 'Developer sign-in is not available in this build');
}

/** Shape check only; Supabase is the authority on whether the address can sign in. */
export function normalizeEmail(email: string): string {
  const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (e.length < 3 || e.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(e)) {
    throw new ApiError('signin_failed', 'Invalid email', 400);
  }
  return e;
}

/** Non-empty and a sane length; Supabase decides whether it is right. Never logged. */
export function isUsablePassword(password: string): boolean {
  return typeof password === 'string' && password.length > 0 && password.length <= 1024;
}
