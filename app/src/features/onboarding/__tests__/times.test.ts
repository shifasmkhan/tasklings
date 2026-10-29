import { formatTime, shiftTime } from '../times';

describe('times', () => {
  it('formats 12-hour', () => {
    expect(formatTime('00:00')).toBe('12:00 AM');
    expect(formatTime('08:00')).toBe('8:00 AM');
    expect(formatTime('12:15')).toBe('12:15 PM');
    expect(formatTime('20:30')).toBe('8:30 PM');
  });
  it('shifts by quarter hours and wraps at midnight', () => {
    expect(shiftTime('08:00', 1)).toBe('08:15');
    expect(shiftTime('08:00', -1)).toBe('07:45');
    expect(shiftTime('23:55', 1)).toBe('00:10');
    expect(shiftTime('00:05', -1)).toBe('23:50');
  });
});
