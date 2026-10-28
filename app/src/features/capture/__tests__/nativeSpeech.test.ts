import type { NativeSpeechModule } from '../../../../modules/tasklings-speech/src';
import {
  createNativeSpeechRecognizer,
  createSpeechRecognizer,
  isSpeechRecognizerError,
  toSpeechErrorCode,
  type SpeechRecognizerError,
} from '../speech';

// A fake of the native module: tests drive its events by hand. Synthetic text only.
function fakeNative(overrides: Partial<NativeSpeechModule> = {}) {
  const handlers: Record<string, ((payload: never) => void)[]> = {};
  const removed: string[] = [];
  const native: NativeSpeechModule = {
    start: jest.fn(() => Promise.resolve()),
    stop: jest.fn(() => Promise.resolve('final words')),
    cancel: jest.fn(),
    addListener: jest.fn((event: string, handler: (payload: never) => void) => {
      (handlers[event] ??= []).push(handler);
      return { remove: () => void removed.push(event) };
    }) as unknown as NativeSpeechModule['addListener'],
    ...overrides,
  };
  const emit = (event: string, payload: unknown) =>
    (handlers[event] ?? []).forEach((handler) => handler(payload as never));
  return { native, emit, removed };
}

function listener() {
  return { onPartial: jest.fn(), onLevel: jest.fn(), onError: jest.fn() };
}

describe('native SpeechRecognizer wrapper (US-01)', () => {
  it('maps partial and level events to the listener and clamps levels to 0..1', async () => {
    const { native, emit } = fakeNative();
    const recognizer = createNativeSpeechRecognizer(native);
    const l = listener();
    await recognizer.start(l);
    emit('onPartial', { text: 'buy stamps' });
    emit('onLevel', { level: 0.4 });
    emit('onLevel', { level: 3 });
    emit('onLevel', { level: -1 });
    expect(l.onPartial).toHaveBeenCalledWith('buy stamps');
    expect(l.onLevel.mock.calls).toEqual([[0.4], [1], [0]]);
  });

  it('stop resolves with the native final transcript and stops listening to events', async () => {
    const { native, emit, removed } = fakeNative();
    const recognizer = createNativeSpeechRecognizer(native);
    const l = listener();
    await recognizer.start(l);
    await expect(recognizer.stop()).resolves.toBe('final words');
    expect(removed.sort()).toEqual(['onError', 'onLevel', 'onPartial']);
    emit('onPartial', { text: 'late' });
    expect(l.onPartial).not.toHaveBeenCalled();
  });

  it('stop without a running session returns an empty transcript and does not call native', async () => {
    const { native } = fakeNative();
    const recognizer = createNativeSpeechRecognizer(native);
    await expect(recognizer.stop()).resolves.toBe('');
    expect(native.stop).not.toHaveBeenCalled();
  });

  it('stop returns an empty transcript when the native stop fails', async () => {
    const { native } = fakeNative({ stop: jest.fn(() => Promise.reject(new Error('boom'))) });
    const recognizer = createNativeSpeechRecognizer(native);
    await recognizer.start(listener());
    await expect(recognizer.stop()).resolves.toBe('');
  });

  it('cancel discards everything and tells native to stop', async () => {
    const { native, emit } = fakeNative();
    const recognizer = createNativeSpeechRecognizer(native);
    const l = listener();
    await recognizer.start(l);
    recognizer.cancel();
    emit('onPartial', { text: 'late' });
    expect(native.cancel).toHaveBeenCalledTimes(1);
    expect(l.onPartial).not.toHaveBeenCalled();
  });

  it.each(['permission_denied', 'unavailable', 'failed'] as const)(
    'start rejects with %s when native rejects with that code',
    async (code) => {
      const { native } = fakeNative({ start: jest.fn(() => Promise.reject(Object.assign(new Error('x'), { code }))) });
      const recognizer = createNativeSpeechRecognizer(native);
      const error = await recognizer.start(listener()).catch((e: unknown) => e);
      expect(isSpeechRecognizerError(error)).toBe(true);
      expect((error as SpeechRecognizerError).code).toBe(code);
    },
  );

  it('maps unknown native errors to failed, and never copies their message', async () => {
    const { native } = fakeNative({
      start: jest.fn(() => Promise.reject(Object.assign(new Error('secret words here'), { code: 'ERR_SOMETHING' }))),
    });
    const error = (await createNativeSpeechRecognizer(native)
      .start(listener())
      .catch((e: unknown) => e)) as SpeechRecognizerError;
    expect(error.code).toBe('failed');
    expect(error.message).not.toContain('secret');
  });

  it('forwards an error event once, then goes quiet', async () => {
    const { native, emit } = fakeNative();
    const recognizer = createNativeSpeechRecognizer(native);
    const l = listener();
    await recognizer.start(l);
    emit('onError', { code: 'failed' });
    emit('onError', { code: 'failed' });
    emit('onPartial', { text: 'late' });
    expect(l.onError).toHaveBeenCalledTimes(1);
    expect((l.onError.mock.calls[0] as [SpeechRecognizerError])[0].code).toBe('failed');
    expect(l.onPartial).not.toHaveBeenCalled();
    await expect(recognizer.stop()).resolves.toBe('');
  });

  it('ignores events from a run that was replaced by a new start', async () => {
    const { native, emit } = fakeNative();
    const recognizer = createNativeSpeechRecognizer(native);
    const first = listener();
    const second = listener();
    await recognizer.start(first);
    await recognizer.start(second);
    emit('onPartial', { text: 'hello' });
    expect(first.onPartial).not.toHaveBeenCalled();
    expect(second.onPartial).toHaveBeenCalledWith('hello');
  });

  it('toSpeechErrorCode keeps known codes and maps everything else to failed', () => {
    expect(toSpeechErrorCode({ code: 'unavailable' })).toBe('unavailable');
    expect(toSpeechErrorCode({ code: 'nope' })).toBe('failed');
    expect(toSpeechErrorCode(null)).toBe('failed');
    expect(toSpeechErrorCode('permission_denied')).toBe('failed');
  });
});

describe('createSpeechRecognizer', () => {
  afterEach(() => jest.resetModules());

  it('uses the mock when the native module is not present (Jest, Expo Go, web)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../../modules/tasklings-speech/src', () => ({ loadNativeSpeechModule: () => null }));
      const speech = jest.requireActual<typeof import('../speech')>('../speech');
      const recognizer = speech.createSpeechRecognizer();
      jest.useFakeTimers();
      const l = listener();
      void recognizer.start(l);
      jest.advanceTimersByTime(400);
      expect(l.onPartial).toHaveBeenCalled();
      recognizer.cancel();
      jest.useRealTimers();
    });
  });

  it('uses the native module when it is present', async () => {
    const { native } = fakeNative();
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../../../../modules/tasklings-speech/src', () => ({ loadNativeSpeechModule: () => native }));
      const speech = jest.requireActual<typeof import('../speech')>('../speech');
      await speech.createSpeechRecognizer().start(listener());
    });
    expect(native.start).toHaveBeenCalledTimes(1);
  });

  it('defaults to the mock in this environment', () => {
    expect(createSpeechRecognizer()).toBeDefined();
  });
});
