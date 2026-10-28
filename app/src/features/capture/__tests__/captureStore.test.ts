import { ApiError } from '@/api/errors';
import { createMockApi } from '@/api/mock';
import type { MockApiClient } from '@/api/mock';
import { CaptureStore, RESULT_TIMEOUT_MS, type CaptureResult } from '../captureStore';

const mockRandomUUID = jest.fn(() => '3b241101-e2bb-4255-8caf-4136c566a962');
jest.mock('expo-crypto', () => ({ randomUUID: () => mockRandomUUID() }));

const TODAY = '2026-10-27';

function setup(options: { newId?: () => string } = {}) {
  const api: MockApiClient = createMockApi({ tasks: [], today: () => TODAY, captureResultDelayMs: 200 });
  let n = 0;
  const store = new CaptureStore({
    api,
    arrivals: null,
    newId: options.newId ?? (() => `capture-${++n}`),
    now: () => new Date('2026-10-27T14:30:00.000Z'),
    timeZone: () => 'America/Chicago',
  });
  const results: CaptureResult[] = [];
  store.onResult((r) => results.push(r));
  return { api, store, results };
}

async function flush(ms = 0) {
  await jest.advanceTimersByTimeAsync(ms);
}

describe('CaptureStore (US-01, US-02, US-03)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('generates the capture_id on the client from the secure random UUID source', () => {
    const api = createMockApi({ tasks: [], today: () => TODAY });
    const spy = jest.spyOn(api, 'processCapture');
    const store = new CaptureStore({ api, arrivals: null });
    const id = store.submit({ source: 'text', transcript: 'Pay the water bill' });
    expect(mockRandomUUID).toHaveBeenCalledTimes(1);
    expect(id).toBe('3b241101-e2bb-4255-8caf-4136c566a962');
    expect(spy.mock.calls[0]?.[0].capture_id).toBe(id);
  });

  it('sends capture_id, transcript, captured_at and the device IANA time zone, as the contract requires', async () => {
    const { api, store } = setup();
    const spy = jest.spyOn(api, 'processCapture');
    const id = store.submit({ source: 'voice', transcript: '  Call the dentist  ' });
    await flush();
    expect(spy).toHaveBeenCalledWith({
      capture_id: id,
      transcript: 'Call the dentist',
      captured_at: '2026-10-27T14:30:00.000Z',
      timezone: 'America/Chicago',
    });
  });

  it('shows the capture as pending right away, then hands over the tasks when they arrive', async () => {
    const { store, results } = setup();
    const id = store.submit({ source: 'voice', transcript: 'Call the dentist, buy stamps' });
    expect(store.getPending()).toEqual([{ capture_id: id, source: 'voice', status: 'sending', text: null }]);
    await flush();
    expect(store.getPending()[0]?.status).toBe('sorting');
    await flush(200);
    expect(store.getPending()).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0]?.tasks).toHaveLength(2);
    expect(results[0]?.tasks.every((t) => t.capture_id === id)).toBe(true);
  });

  it('keeps the text of a typed note on the pending entry; a voice note carries none', () => {
    const { store } = setup();
    store.submit({ source: 'text', transcript: 'Pay the water bill' });
    store.submit({ source: 'voice', transcript: 'Call the dentist' });
    expect(store.getPending().map((p) => p.text)).toEqual(['Pay the water bill', null]);
  });

  it('an empty result creates no task', async () => {
    const { api, store, results } = setup();
    store.submit({ source: 'text', transcript: 'Never mind, nothing to add' });
    await flush(200);
    expect(results[0]?.tasks).toEqual([]);
    expect(api.snapshot()).toEqual([]);
  });

  it('a fallback result is one needs_review task', async () => {
    const { store, results } = setup();
    store.submit({ source: 'voice', transcript: 'Garbled. Buy stamps, book the vet' });
    await flush(200);
    expect(results[0]?.tasks).toHaveLength(1);
    expect(results[0]?.tasks[0]?.needs_review).toBe(true);
  });

  describe('offline queue', () => {
    it('queues a capture whose request fails with a network error', async () => {
      const { api, store } = setup();
      api.failNext('network_error');
      const id = store.submit({ source: 'text', transcript: 'Pay the water bill' });
      await flush();
      expect(store.getPending()).toEqual([{ capture_id: id, source: 'text', status: 'queued', text: 'Pay the water bill' }]);
    });

    it('retries the queued capture with the same id and the original captured_at', async () => {
      const { api, store, results } = setup();
      const spy = jest.spyOn(api, 'processCapture');
      api.failNext('network_error');
      const id = store.submit({ source: 'voice', transcript: 'Call the dentist' });
      await flush();
      await store.retryQueued();
      await flush(200);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[1]?.[0]).toEqual(spy.mock.calls[0]?.[0]);
      expect(results[0]?.capture_id).toBe(id);
      expect(store.getPending()).toEqual([]);
    });

    it('stays queued while the network is still down', async () => {
      const { api, store } = setup();
      api.failNext('network_error');
      store.submit({ source: 'text', transcript: 'Pay the water bill' });
      await flush();
      api.failNext('network_error');
      await store.retryQueued();
      expect(store.getPending()[0]?.status).toBe('queued');
      await store.retryQueued();
      await flush(200);
      expect(store.getPending()).toEqual([]);
    });

    it('does not send the same capture twice at once', async () => {
      const { api, store } = setup();
      const spy = jest.spyOn(api, 'processCapture');
      api.failNext('network_error');
      store.submit({ source: 'text', transcript: 'Pay the water bill' });
      await flush();
      await Promise.all([store.retryQueued(), store.retryQueued()]);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('a server refusal is not queued for the foreground retry; the row offers Try again', async () => {
      const { api, store } = setup();
      const spy = jest.spyOn(api, 'processCapture');
      api.failNext('capture_conflict');
      const id = store.submit({ source: 'text', transcript: 'Pay the water bill' });
      await flush();
      expect(store.getPending()[0]?.status).toBe('failed');
      await store.retryQueued();
      expect(spy).toHaveBeenCalledTimes(1);
      await store.retry(id);
      await flush(200);
      expect(store.getPending()).toEqual([]);
    });

    it('an ApiError from the network path is the only thing treated as offline', async () => {
      const { api, store } = setup();
      jest.spyOn(api, 'processCapture').mockRejectedValueOnce(new ApiError('internal_error', 'x', 500));
      store.submit({ source: 'text', transcript: 'Pay the water bill' });
      await flush();
      expect(store.getPending()[0]?.status).toBe('failed');
    });
  });

  describe('result timeout', () => {
    function slowSetup() {
      // The result takes far longer than the timeout.
      const api = createMockApi({ tasks: [], today: () => TODAY, captureResultDelayMs: 10 * 60_000 });
      const store = new CaptureStore({ api, arrivals: null, newId: () => 'c1' });
      const results: CaptureResult[] = [];
      store.onResult((r) => results.push(r));
      return { api, store, results };
    }

    it('stays "sorting" until 60 s after the 202, then becomes failed', async () => {
      const { store } = slowSetup();
      store.submit({ source: 'text', transcript: 'Pay the water bill' });
      await flush();
      expect(store.getPending()[0]?.status).toBe('sorting');
      await flush(RESULT_TIMEOUT_MS - 1);
      expect(store.getPending()[0]?.status).toBe('sorting');
      await flush(1);
      expect(store.getPending()[0]?.status).toBe('failed');
    });

    it('Try again resends the same capture_id and waits another 60 s', async () => {
      const { api, store } = slowSetup();
      const spy = jest.spyOn(api, 'processCapture');
      const id = store.submit({ source: 'text', transcript: 'Pay the water bill' });
      await flush(RESULT_TIMEOUT_MS + 1);
      await store.retry(id);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[1]?.[0]).toEqual(spy.mock.calls[0]?.[0]);
      expect(store.getPending()[0]?.status).toBe('sorting');
      await flush(RESULT_TIMEOUT_MS - 1);
      expect(store.getPending()[0]?.status).toBe('sorting');
    });

    it('a result that arrives after the timeout still completes the capture', async () => {
      const api = createMockApi({ tasks: [], today: () => TODAY, captureResultDelayMs: RESULT_TIMEOUT_MS + 5000 });
      const store = new CaptureStore({ api, arrivals: null, newId: () => 'c1' });
      const results: CaptureResult[] = [];
      store.onResult((r) => results.push(r));
      store.submit({ source: 'text', transcript: 'Pay the water bill' });
      await flush(RESULT_TIMEOUT_MS + 1);
      expect(store.getPending()[0]?.status).toBe('failed');
      await flush(5000);
      expect(store.getPending()).toEqual([]);
      expect(results).toHaveLength(1);
    });

    it('a result before the timeout cancels it', async () => {
      const { store, results } = setup();
      store.submit({ source: 'text', transcript: 'Pay the water bill' });
      await flush(200);
      expect(results).toHaveLength(1);
      await flush(RESULT_TIMEOUT_MS * 2);
      expect(store.getPending()).toEqual([]);
    });
  });

  it('delivers a result that arrived while no screen was listening', async () => {
    const api = createMockApi({ tasks: [], today: () => TODAY, captureResultDelayMs: 50 });
    const store = new CaptureStore({ api, arrivals: null, newId: () => 'c1' });
    store.submit({ source: 'text', transcript: 'Pay the water bill' });
    await flush(50);
    const results: CaptureResult[] = [];
    store.onResult((r) => results.push(r));
    expect(results).toHaveLength(1);
  });
});
