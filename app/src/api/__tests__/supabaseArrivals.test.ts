import type { SupabaseClient } from '@supabase/supabase-js';

import type { CaptureArrival } from '../arrivals';
import { makeTask } from '../fixtures';
import { createSupabaseArrivals, TASK_COLUMNS } from '../supabaseArrivals';

const ID = '50000000-0000-4000-a000-000000000001';
type Status = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';

/** A fake supabase-js client with just the realtime and select surface the arrivals use. */
function fakeClient(opts: { captureStatus?: string; tasksError?: boolean } = {}) {
  const state = { captureStatus: opts.captureStatus ?? 'parsing', tasksError: opts.tasksError ?? false };
  const tasks = [
    makeTask({ id: 't1', title: 'Synthetic one', kind: 'quick', capture_id: ID, sort_order: 0 }, '2026-10-27'),
    makeTask({ id: 't2', title: 'Synthetic two', kind: 'errand', capture_id: ID, sort_order: 1 }, '2026-10-27'),
  ];
  const filters: Record<string, unknown>[] = [];
  const handlers: ((payload: { new?: unknown }) => void)[] = [];
  const queries: { table: string; columns?: string; eq?: [string, unknown]; order?: string }[] = [];
  let statusCallback: ((s: Status) => void) | null = null;
  const removed: unknown[] = [];
  const channelNames: string[] = [];

  const channel = {
    on: (_type: string, filter: Record<string, unknown>, cb: (p: { new?: unknown }) => void) => {
      filters.push(filter);
      handlers.push(cb);
      return channel;
    },
    subscribe: (cb: (s: Status) => void) => {
      statusCallback = cb;
      return channel;
    },
  };
  const client = {
    channel: (name: string) => (channelNames.push(name), channel),
    removeChannel: async (ch: unknown) => (removed.push(ch), 'ok'),
    from: (table: string) => {
      const q: (typeof queries)[number] = { table };
      queries.push(q);
      const result = () =>
        table === 'captures'
          ? { data: { status: state.captureStatus }, error: null }
          : state.tasksError
            ? { data: null, error: { code: '57014', message: 'canceled' } }
            : { data: tasks, error: null };
      const builder = {
        select: (columns: string) => ((q.columns = columns), builder),
        eq: (col: string, value: unknown) => ((q.eq = [col, value]), builder),
        order: (col: string) => ((q.order = col), Promise.resolve(result())),
        maybeSingle: () => Promise.resolve(result()),
      };
      return builder;
    },
  } as unknown as SupabaseClient;

  return {
    client,
    state,
    tasks,
    filters,
    queries,
    removed,
    channel,
    channelNames,
    emitCapture: (status: string) => handlers.forEach((h) => h({ new: { status } })),
    setStatus: (s: Status) => statusCallback?.(s),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('realtime capture arrivals', () => {
  it('subscribes to the capture row only, filtered by its id', () => {
    const f = fakeClient();
    createSupabaseArrivals(f.client).subscribe(ID, () => {});
    expect(f.channelNames).toEqual([`capture-${ID}`]);
    expect(f.filters).toEqual([{ event: '*', schema: 'public', table: 'captures', filter: `id=eq.${ID}` }]);
  });

  it('delivers the capture\'s tasks, in order, when the status becomes done', async () => {
    const f = fakeClient();
    const got: CaptureArrival[] = [];
    createSupabaseArrivals(f.client).subscribe(ID, (a) => got.push(a));
    f.setStatus('SUBSCRIBED');
    await flush();
    f.emitCapture('parsing');
    await flush();
    expect(got).toEqual([]);
    f.emitCapture('done');
    await flush();
    expect(got).toHaveLength(1);
    expect(got[0]?.capture_id).toBe(ID);
    expect(got[0]?.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    const read = f.queries.find((q) => q.table === 'tasks');
    expect(read).toMatchObject({ columns: TASK_COLUMNS, eq: ['capture_id', ID], order: 'sort_order' });
    expect(f.removed).toHaveLength(1);
  });

  it('delivers once even when done is seen twice', async () => {
    const f = fakeClient();
    const got: CaptureArrival[] = [];
    createSupabaseArrivals(f.client).subscribe(ID, (a) => got.push(a));
    f.emitCapture('done');
    f.emitCapture('done');
    await flush();
    f.emitCapture('done');
    await flush();
    expect(got).toHaveLength(1);
  });

  it('delivers a result that finished before the channel was live (catch-up on join)', async () => {
    const f = fakeClient({ captureStatus: 'done' });
    const got: CaptureArrival[] = [];
    createSupabaseArrivals(f.client).subscribe(ID, (a) => got.push(a));
    expect(got).toEqual([]);
    f.setStatus('SUBSCRIBED');
    await flush();
    expect(got).toHaveLength(1);
  });

  it('does not deliver while parsing, and does not deliver a failed capture', async () => {
    const f = fakeClient({ captureStatus: 'parsing' });
    const got: CaptureArrival[] = [];
    createSupabaseArrivals(f.client).subscribe(ID, (a) => got.push(a));
    f.setStatus('SUBSCRIBED');
    await flush();
    f.emitCapture('failed');
    await flush();
    expect(got).toEqual([]);
    expect(f.removed).toHaveLength(0);
  });

  it('delivers an empty list: the capture finished and created no task', async () => {
    const f = fakeClient();
    f.tasks.length = 0;
    const got: CaptureArrival[] = [];
    createSupabaseArrivals(f.client).subscribe(ID, (a) => got.push(a));
    f.emitCapture('done');
    await flush();
    expect(got).toEqual([{ capture_id: ID, tasks: [] }]);
  });

  it('keeps listening after a failed task read and delivers on the next join', async () => {
    const f = fakeClient({ captureStatus: 'done', tasksError: true });
    const got: CaptureArrival[] = [];
    createSupabaseArrivals(f.client).subscribe(ID, (a) => got.push(a));
    f.setStatus('SUBSCRIBED');
    await flush();
    expect(got).toEqual([]);
    expect(f.removed).toHaveLength(0);
    f.state.tasksError = false;
    f.setStatus('SUBSCRIBED');
    await flush();
    expect(got).toHaveLength(1);
  });

  it('ignores channel errors (supabase-js rejoins by itself)', async () => {
    const f = fakeClient();
    const got: CaptureArrival[] = [];
    createSupabaseArrivals(f.client).subscribe(ID, (a) => got.push(a));
    f.setStatus('CHANNEL_ERROR');
    f.setStatus('TIMED_OUT');
    await flush();
    expect(got).toEqual([]);
  });

  it('unsubscribe removes the channel and stops delivery', async () => {
    const f = fakeClient();
    const got: CaptureArrival[] = [];
    const unsubscribe = createSupabaseArrivals(f.client).subscribe(ID, (a) => got.push(a));
    unsubscribe();
    expect(f.removed).toHaveLength(1);
    f.emitCapture('done');
    f.setStatus('SUBSCRIBED');
    await flush();
    expect(got).toEqual([]);
    unsubscribe();
    expect(f.removed).toHaveLength(1);
  });

  it('refuses an id that is not a UUID instead of putting it in a filter', () => {
    const f = fakeClient();
    const unsubscribe = createSupabaseArrivals(f.client).subscribe('x,user_id=neq.0', () => {});
    expect(f.channelNames).toEqual([]);
    expect(() => unsubscribe()).not.toThrow();
  });
});
