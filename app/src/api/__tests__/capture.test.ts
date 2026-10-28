import { ApiError } from '../errors';
import { createMockApi } from '../mock';
import type { CaptureArrival } from '../arrivals';
import type { ProcessCaptureRequest } from '../types';
import { sanitizeTitle, synthesizeCapture } from '../syntheticCapture';

const TODAY = '2026-10-27';
const TOMORROW = '2026-10-28';

function request(transcript: string, id = '11111111-1111-4111-8111-111111111111'): ProcessCaptureRequest {
  return { capture_id: id, transcript, captured_at: '2026-10-27T09:00:00.000Z', timezone: 'America/Chicago' };
}

describe('synthetic extraction keywords (mock backend)', () => {
  it('turns clauses into tasks with kind, effort and due date', () => {
    const out = synthesizeCapture(
      'I need to call the dentist, and buy stamps at the post office, then plan the garage clean out tomorrow.',
      TODAY,
      TOMORROW,
    );
    expect(out.type).toBe('tasks');
    if (out.type !== 'tasks') return;
    expect(out.tasks.map((t) => [t.title, t.kind])).toEqual([
      ['Call the dentist', 'quick'],
      ['Buy stamps at the post office', 'errand'],
      ['Plan the garage clean out tomorrow', 'project'],
    ]);
    expect(out.tasks[2]?.due_date).toBe(TOMORROW);
    expect(out.tasks[0]?.due_date).toBeNull();
  });

  it.each(['Um, never mind, nothing to add.', 'Just thinking out loud here'])('"%s" gives zero tasks', (text) => {
    expect(synthesizeCapture(text, TODAY, TOMORROW)).toEqual({ type: 'empty' });
  });

  it('a transcript with no usable clause gives zero tasks', () => {
    expect(synthesizeCapture('um uh', TODAY, TOMORROW)).toEqual({ type: 'empty' });
  });

  it('"garbled" gives the fallback: the transcript as one task', () => {
    const out = synthesizeCapture('Garbled. Buy stamps, book the vet.', TODAY, TOMORROW);
    expect(out.type).toBe('fallback');
    if (out.type === 'fallback') expect(out.task.title).toBe('Garbled. Buy stamps, book the vet.');
  });

  it('never makes more than 10 tasks, or a title over 60 characters', () => {
    const many = Array.from({ length: 14 }, (_, i) => `call person number ${i}`).join(', ');
    const out = synthesizeCapture(many, TODAY, TOMORROW);
    expect(out.type === 'tasks' && out.tasks.length).toBe(10);
    expect(sanitizeTitle('word '.repeat(40)).length).toBeLessThanOrEqual(60);
  });

  it('titles never carry links, emails, phone numbers or hidden characters', () => {
    expect(sanitizeTitle('Email sam@example.test about https://example.test/x or call 555-123-4567')).toBe(
      'Email about or call',
    );
    const zeroWidth = String.fromCodePoint(0x200b);
    const override = String.fromCodePoint(0x202e);
    expect(sanitizeTitle(`Pay${zeroWidth} the bill${override}`)).toBe('Pay the bill');
  });
});

describe('mock process-capture', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('answers 202 at once and delivers the tasks after the delay, stored with the capture id', async () => {
    const api = createMockApi({ tasks: [], today: () => TODAY, captureResultDelayMs: 500 });
    const got: CaptureArrival[] = [];
    const req = request('Call the dentist, buy stamps');
    api.arrivals.subscribe(req.capture_id, (a) => got.push(a));
    await expect(api.processCapture(req)).resolves.toEqual({ capture_id: req.capture_id });
    expect(got).toHaveLength(0);
    jest.advanceTimersByTime(500);
    expect(got).toHaveLength(1);
    expect(got[0]?.tasks).toHaveLength(2);
    expect(api.snapshot().every((t) => t.capture_id === req.capture_id)).toBe(true);
    expect((await api.todayTasks()).quick).toHaveLength(1);
  });

  it('is idempotent: a retry of the same capture_id creates no second set of tasks', async () => {
    const api = createMockApi({ tasks: [], today: () => TODAY, captureResultDelayMs: 100 });
    const req = request('Call the dentist, buy stamps');
    await api.processCapture(req);
    await api.processCapture(req);
    jest.advanceTimersByTime(1000);
    expect(api.snapshot()).toHaveLength(2);
  });

  it('delivers an empty result and a needs_review fallback', async () => {
    const api = createMockApi({ tasks: [], today: () => TODAY, captureResultDelayMs: 0 });
    const results: CaptureArrival[] = [];
    api.arrivals.subscribe('a', (r) => results.push(r));
    api.arrivals.subscribe('b', (r) => results.push(r));
    await api.processCapture(request('Never mind', 'a'));
    await api.processCapture(request('Garbled mumbling', 'b'));
    jest.advanceTimersByTime(1);
    expect(results[0]?.tasks).toEqual([]);
    expect(results[1]?.tasks).toHaveLength(1);
    expect(results[1]?.tasks[0]?.needs_review).toBe(true);
  });

  it('validates the request with the standard error shape', async () => {
    const api = createMockApi({ tasks: [], today: () => TODAY });
    await expect(api.processCapture({ ...request('x y'), transcript: '  ' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(api.processCapture({ ...request('x y'), timezone: '' })).rejects.toBeInstanceOf(ApiError);
  });
});
