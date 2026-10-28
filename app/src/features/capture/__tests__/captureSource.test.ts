import { createMockApi } from '@/api/mock';
import { CaptureStore } from '../captureStore';

const TODAY = '2026-10-27';

describe('capture source (US-01, US-02)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each([
    ['text', 'text'],
    ['voice', 'voice'],
  ] as const)('a %s note is sent to process-capture with source %s', async (source, expected) => {
    const api = createMockApi({ tasks: [], today: () => TODAY, captureResultDelayMs: 50 });
    const spy = jest.spyOn(api, 'processCapture');
    const store = new CaptureStore({ api, arrivals: null, newId: () => '50000000-0000-4000-a000-000000000009' });
    store.submit({ source, transcript: 'Pay the water bill' });
    await jest.advanceTimersByTimeAsync(0);
    expect(spy.mock.calls[0]?.[0].source).toBe(expected);
    expect(api.captureSource('50000000-0000-4000-a000-000000000009')).toBe(expected);
    store.dispose();
  });
});
