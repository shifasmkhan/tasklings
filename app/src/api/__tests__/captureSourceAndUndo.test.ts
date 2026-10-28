import { ApiError } from '../errors';
import { createMockApi, UNDO_CAPTURE_WINDOW_MS } from '../mock';
import type { ProcessCaptureRequest } from '../types';

const TODAY = '2026-10-27';
const CAPTURE_ID = '50000000-0000-4000-a000-000000000001';

function request(extra: Partial<ProcessCaptureRequest> = {}): ProcessCaptureRequest {
  return {
    capture_id: CAPTURE_ID,
    transcript: 'Call the dentist, buy stamps',
    captured_at: '2026-10-27T14:30:00.000Z',
    timezone: 'America/Chicago',
    ...extra,
  };
}

function setup() {
  let clock = new Date('2026-10-27T14:30:00.000Z').getTime();
  const api = createMockApi({ tasks: [], today: () => TODAY, now: () => new Date(clock), captureResultDelayMs: 100 });
  const arrived: string[][] = [];
  api.arrivals.subscribe(CAPTURE_ID, (a) => arrived.push(a.tasks.map((t) => t.id)));
  return { api, arrived, tick: (ms: number) => void (clock += ms) };
}

async function finish(ms = 150) {
  await jest.advanceTimersByTimeAsync(ms);
}

describe('mock: process-capture source', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('stores voice when source is omitted', async () => {
    const { api } = setup();
    await api.processCapture(request());
    expect(api.captureSource(CAPTURE_ID)).toBe('voice');
  });

  it.each(['voice', 'text', 'siri', 'widget'] as const)('stores %s', async (source) => {
    const { api } = setup();
    await api.processCapture(request({ source }));
    expect(api.captureSource(CAPTURE_ID)).toBe(source);
  });

  it.each(['Voice', 'email', '', 'text ', null, 1, ['text']])('refuses source %p with invalid_request', async (source) => {
    const { api } = setup();
    await expect(api.processCapture(request({ source } as unknown as Partial<ProcessCaptureRequest>))).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
    });
    expect(api.captureSource(CAPTURE_ID)).toBeUndefined();
  });
});

describe('mock: undo_capture', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('deletes the capture\'s tasks and returns how many', async () => {
    const { api, arrived } = setup();
    await api.processCapture(request());
    await finish();
    expect(arrived[0]).toHaveLength(2);
    await expect(api.undoCapture(CAPTURE_ID)).resolves.toBe(2);
    expect(api.snapshot()).toEqual([]);
    // A repeat finds nothing to remove.
    await expect(api.undoCapture(CAPTURE_ID)).resolves.toBe(0);
  });

  it('leaves other tasks alone', async () => {
    const { api } = setup();
    await api.processCapture(request());
    await finish();
    const other = await api.processCapture(request({ capture_id: '50000000-0000-4000-a000-000000000002', transcript: 'Pay the water bill' }));
    await finish();
    await api.undoCapture(CAPTURE_ID);
    expect(api.snapshot().map((t) => t.capture_id)).toEqual([other.capture_id]);
  });

  it('works up to 30 seconds after the capture finished, then raises undo_expired', async () => {
    const early = setup();
    await early.api.processCapture(request());
    await finish();
    early.tick(UNDO_CAPTURE_WINDOW_MS);
    await expect(early.api.undoCapture(CAPTURE_ID)).resolves.toBe(2);

    const late = setup();
    await late.api.processCapture(request());
    await finish();
    late.tick(UNDO_CAPTURE_WINDOW_MS + 1);
    await expect(late.api.undoCapture(CAPTURE_ID)).rejects.toMatchObject({ code: 'undo_expired', status: 409 });
    expect(late.api.snapshot()).toHaveLength(2);
  });

  it('raises undo_expired when a task was completed, edited, deferred or dropped', async () => {
    for (const touch of ['complete', 'edit', 'defer', 'drop'] as const) {
      const { api, arrived } = setup();
      await api.processCapture(request());
      await finish();
      const id = arrived[0]![0]!;
      if (touch === 'complete') await api.completeTask(id);
      if (touch === 'edit') await api.updateTask(id, { title: 'Synthetic edit' });
      if (touch === 'defer') await api.deferTask(id);
      if (touch === 'drop') await api.dropTask(id);
      await expect(api.undoCapture(CAPTURE_ID)).rejects.toMatchObject({ code: 'undo_expired' });
      expect(api.snapshot()).toHaveLength(2);
    }
  });

  it('raises undo_expired even after a completed task was reopened', async () => {
    const { api, arrived } = setup();
    await api.processCapture(request());
    await finish();
    const id = arrived[0]![0]!;
    await api.completeTask(id);
    await api.undoTask(id);
    await expect(api.undoCapture(CAPTURE_ID)).rejects.toMatchObject({ code: 'undo_expired' });
  });

  it('raises undo_expired for a capture that is unknown or not finished, and validates the argument', async () => {
    const { api } = setup();
    await expect(api.undoCapture('50000000-0000-4000-a000-0000000000ff')).rejects.toBeInstanceOf(ApiError);
    await expect(api.undoCapture('50000000-0000-4000-a000-0000000000ff')).rejects.toMatchObject({ code: 'undo_expired' });
    await api.processCapture(request());
    // Accepted (202) but the tasks have not arrived yet.
    await expect(api.undoCapture(CAPTURE_ID)).rejects.toMatchObject({ code: 'undo_expired' });
    await expect(api.undoCapture('')).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});
