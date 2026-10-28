import { createMockSpeechRecognizer, createSpeechRecognizer, isSpeechRecognizerError, type SpeechRecognizerError } from '../speech';

describe('mock SpeechRecognizer (US-01)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function listener() {
    return { onPartial: jest.fn(), onLevel: jest.fn(), onError: jest.fn() };
  }

  it('streams scripted partials that grow, with levels between 0 and 1', async () => {
    const r = createMockSpeechRecognizer({ transcript: 'one two three four five', tickMs: 100 });
    const l = listener();
    await r.start(l);
    jest.advanceTimersByTime(100);
    expect(l.onPartial).toHaveBeenLastCalledWith('one two');
    jest.advanceTimersByTime(200);
    expect(l.onPartial).toHaveBeenLastCalledWith('one two three four five');
    for (const [level] of l.onLevel.mock.calls as [number][]) {
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(1);
    }
  });

  it('stop resolves with the final transcript and ends the stream', async () => {
    const r = createMockSpeechRecognizer({ transcript: 'one two three four', tickMs: 100 });
    const l = listener();
    await r.start(l);
    jest.advanceTimersByTime(100);
    await expect(r.stop()).resolves.toBe('one two');
    l.onPartial.mockClear();
    jest.advanceTimersByTime(1000);
    expect(l.onPartial).not.toHaveBeenCalled();
  });

  it('cancel discards everything: no more partials, and stop returns nothing', async () => {
    const r = createMockSpeechRecognizer({ tickMs: 100 });
    const l = listener();
    await r.start(l);
    jest.advanceTimersByTime(200);
    r.cancel();
    l.onPartial.mockClear();
    jest.advanceTimersByTime(1000);
    expect(l.onPartial).not.toHaveBeenCalled();
    await expect(r.stop()).resolves.toBe('');
  });

  it('endAfterTicks ends the run like an interruption: onEnded fires and stop still returns the text', async () => {
    const r = createMockSpeechRecognizer({ transcript: 'one two three four five six', tickMs: 100, endAfterTicks: 2 });
    const l = { ...listener(), onEnded: jest.fn() };
    await r.start(l);
    jest.advanceTimersByTime(1000);
    expect(l.onEnded).toHaveBeenCalledTimes(1);
    expect(l.onError).not.toHaveBeenCalled();
    await expect(r.stop()).resolves.toBe('one two three four');
  });

  it('rejects start with permission_denied when access is refused', async () => {
    const r = createMockSpeechRecognizer({ denyPermission: true });
    const err = await r.start(listener()).catch((e: unknown) => e);
    expect(isSpeechRecognizerError(err)).toBe(true);
    expect((err as SpeechRecognizerError).code).toBe('permission_denied');
  });

  it('the app uses the mock until the native module lands', async () => {
    const r = createSpeechRecognizer();
    const l = listener();
    await r.start(l);
    jest.advanceTimersByTime(400);
    expect(l.onPartial).toHaveBeenCalled();
    r.cancel();
  });
});
