import { ApiError, toApiError } from '../errors';
import { makeTask } from '../fixtures';
import { createMockApi } from '../mock';
import { createSupabaseApi } from '../supabase';

const TODAY = '2026-10-26';

describe('toApiError', () => {
  it('maps the standard error shape', () => {
    const err = toApiError({ error: { code: 'not_found', message: 'Task not found' } }, 404);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('not_found');
    expect(err.message).toBe('Task not found');
    expect(err.status).toBe(404);
  });

  it('turns anything else into bad_response without echoing the body', () => {
    const err = toApiError({ message: 'secret stack trace' }, 500);
    expect(err.code).toBe('bad_response');
    expect(err.message).not.toContain('secret');
    expect(toApiError(null, null).code).toBe('bad_response');
    expect(toApiError({ error: { code: '' } }, 400).code).toBe('bad_response');
  });
});

describe('mock api', () => {
  const tasks = () => [
    makeTask({ id: 't1', title: 'Synthetic one', kind: 'quick', sort_order: 1 }, TODAY),
    makeTask({ id: 't2', title: 'Synthetic two', kind: 'errand', sort_order: 0 }, TODAY),
    makeTask({ id: 't3', title: 'Synthetic later', kind: 'quick', planned_for: '2026-10-27' }, TODAY),
    makeTask({ id: 't4', title: 'Synthetic overdue', kind: 'project', planned_for: '2026-10-20', carry_count: 6 }, TODAY),
  ];

  it('today_tasks returns open tasks planned today or earlier, grouped by kind', async () => {
    const api = createMockApi({ tasks: tasks(), today: () => TODAY });
    const today = await api.todayTasks();
    expect(today.quick.map((t) => t.id)).toEqual(['t1']);
    expect(today.errand.map((t) => t.id)).toEqual(['t2']);
    expect(today.project.map((t) => t.id)).toEqual(['t4']);
  });

  it('complete, defer and drop update the task; undo restores it', async () => {
    const api = createMockApi({ tasks: tasks(), today: () => TODAY });
    expect((await api.completeTask('t1')).status).toBe('done');
    expect((await api.undoTask('t1')).status).toBe('open');
    expect((await api.deferTask('t2')).planned_for).toBe('2026-10-27');
    expect((await api.undoTask('t2')).planned_for).toBe(TODAY);
    const dropped = await api.dropTask('t4', 'obsolete');
    expect(dropped.status).toBe('dropped');
    expect(dropped.dropped_reason).toBe('obsolete');
    expect((await api.undoTask('t4')).status).toBe('open');
  });

  it('rejects with stable codes', async () => {
    const api = createMockApi({ tasks: tasks(), today: () => TODAY });
    await expect(api.completeTask('missing')).rejects.toMatchObject({ code: 'not_found' });
    await api.completeTask('t1');
    await expect(api.completeTask('t1')).rejects.toMatchObject({ code: 'invalid_state' });
    await expect(api.undoTask('t2')).rejects.toMatchObject({ code: 'nothing_to_undo' });
    api.failNext('rate_limited');
    await expect(api.todayTasks()).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('task edits change only editable fields and never effort_min_initial', async () => {
    const api = createMockApi({ tasks: tasks(), today: () => TODAY });
    const updated = await api.updateTask('t1', { effort_min: 25, title: '  Renamed synthetic  ' });
    expect(updated.effort_min).toBe(25);
    expect(updated.effort_min_initial).toBe(10);
    expect(updated.title).toBe('Renamed synthetic');
    await expect(api.updateTask('t1', { title: 'x'.repeat(61) })).rejects.toMatchObject({ code: 'invalid_title' });
    await expect(api.updateTask('t1', { effort_min: 0 })).rejects.toMatchObject({ code: 'invalid_effort' });
    await expect(
      api.updateTask('t1', { effort_min_initial: 1 } as unknown as Parameters<typeof api.updateTask>[1]),
    ).rejects.toMatchObject({ code: 'invalid_field' });
  });

  it('implements the remaining contracts', async () => {
    const api = createMockApi({ tasks: tasks(), today: () => TODAY });
    expect((await api.signInWithApple('synthetic-token')).user_id).toBeTruthy();
    expect(
      await api.processCapture({ capture_id: 'c1', transcript: 'synthetic', captured_at: `${TODAY}T09:00:00Z`, timezone: 'America/Chicago' }),
    ).toEqual({ capture_id: 'c1' });
    await expect(api.registerDevice('synthetic-apns')).resolves.toBeUndefined();
    expect(await api.exportData()).toHaveProperty('tasks');
    await api.deleteAccount();
    expect(api.snapshot()).toEqual([]);
  });
});

describe('supabase stub', () => {
  function fakeFetch(status: number, body: unknown) {
    return jest.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })) as unknown as typeof fetch & jest.Mock;
  }

  it('refuses a non-https URL', () => {
    expect(() =>
      createSupabaseApi({ url: 'http://example.test', anonKey: 'anon', getAccessToken: () => 't' }),
    ).toThrow(ApiError);
  });

  it('sends the user JWT and maps the standard error shape', async () => {
    const fetchImpl = fakeFetch(403, { error: { code: 'forbidden', message: 'Not your task' } });
    const api = createSupabaseApi({ url: 'https://example.test', anonKey: 'anon', getAccessToken: () => 'jwt', fetchImpl });
    await expect(api.completeTask('t1')).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/rest/v1/rpc/complete_task');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt');
  });

  it('fails closed without a session', async () => {
    const fetchImpl = fakeFetch(200, {});
    const api = createSupabaseApi({ url: 'https://example.test', anonKey: 'anon', getAccessToken: () => null, fetchImpl });
    await expect(api.todayTasks()).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('groups a flat today_tasks response by kind', async () => {
    const rows = [
      makeTask({ id: 'a', title: 'Synthetic', kind: 'errand' }, TODAY),
      makeTask({ id: 'b', title: 'Synthetic', kind: 'quick' }, TODAY),
    ];
    const api = createSupabaseApi({
      url: 'https://example.test',
      anonKey: 'anon',
      getAccessToken: () => 'jwt',
      fetchImpl: fakeFetch(200, rows),
    });
    const today = await api.todayTasks();
    expect(today.quick.map((t) => t.id)).toEqual(['b']);
    expect(today.errand.map((t) => t.id)).toEqual(['a']);
    expect(today.project).toEqual([]);
  });

  it('sends only the editable columns on a task edit', async () => {
    const row = makeTask({ id: 't1', title: 'Synthetic', kind: 'quick' }, TODAY);
    const fetchImpl = fakeFetch(200, [row]);
    const api = createSupabaseApi({ url: 'https://example.test', anonKey: 'anon', getAccessToken: () => 'jwt', fetchImpl });
    const edit = { title: 'Synthetic edit', effort_min_initial: 1, user_id: 'other' } as unknown as Parameters<
      typeof api.updateTask
    >[1];
    await api.updateTask('t1', edit);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/rest/v1/tasks?id=eq.t1');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'Synthetic edit' });
  });
});

