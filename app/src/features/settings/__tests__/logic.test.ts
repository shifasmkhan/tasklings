import { ApiError } from '@/api/errors';
import { clockToDate, codeOf, dataErrorMessage, dateToClock } from '../logic';

describe('settings logic', () => {
  it('converts "HH:MM" to a picker date and back', () => {
    expect(dateToClock(clockToDate('07:05'))).toBe('07:05');
    expect(dateToClock(clockToDate('00:00'))).toBe('00:00');
    expect(dateToClock(clockToDate('23:59'))).toBe('23:59');
    expect(clockToDate('20:30').getHours()).toBe(20);
  });

  it('words data errors from the code, never from the server message', () => {
    expect(dataErrorMessage(new ApiError('unauthenticated', 'secret server text'))).toBe("Sign in with Apple isn't set up yet.");
    expect(dataErrorMessage(new ApiError('reauth_required', 'x'))).toMatch(/sign in with Apple again/);
    expect(dataErrorMessage(new ApiError('network_error', 'x'))).toMatch(/reach the server/);
    expect(dataErrorMessage(new ApiError('canceled', 'x'))).toBeNull();
    expect(dataErrorMessage(new ApiError('weird', 'secret server text'))).not.toContain('secret');
    expect(dataErrorMessage(new Error('boom'))).toBe('Something went wrong. Try again.');
    expect(codeOf(new Error('boom'))).toBe('unknown_error');
  });
});
