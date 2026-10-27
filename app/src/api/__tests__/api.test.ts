import { ApiError, toApiError } from '../errors';
import { makeTask } from '../fixtures';
import { createMockApi } from '../mock';
import { createSupabaseApi } from '../supabase';

const TODAY = '2026-10-26';

describe('toApiError', () => {
  it('maps the standard error shape', () => {
    const err = toApiError({ error: { code: 'task_not_found', message: 'Task not found' } }, 404);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('task_not_found');
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

  // PostgREST shape from the backend (supabase/README.md): SQLSTATE PTxxx sets the HTTP
  // status, the stable code is in hint, and details is the message.
  it('maps a PostgREST error to {code: hint, message: details}', () => {
    const err = toApiError(
      { code: 'PT409', message: 'invalid_state', details: 'Task is not open', hint: 'invalid_state' },
      409,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('invalid_state');
    expect(err.message).toBe('Task is not open');
    expect(err.status).toBe(409);
    const noDetails = toApiError({ code: 'PT404', message: 'task_not_found', details: null, hint: 'task_not_found' }, 404);
    expect(noDetails.code).toBe('task_not_found');
    expect(noDetails.message).toBe('');
  });

  it('maps a PostgREST error with no valid hint by HTTP status, without its server text', () => {
    // Platform errors: no hint (permission denied, unique violation) or a prose hint.
    const denied = toApiError(
      { code: '42501', message: 'permission denied for table tasks', details: null, hint: null },
      403,
    );
    expect(denied).toMatchObject({ code: 'forbidden', status: 403 });
    expect(denied.message).not.toContain('permission denied');

    const expired = toApiError({ code: 'PGRST301', message: 'JWT expired', details: null, hint: null }, 401);
    expect(expired).toMatchObject({ code: 'forbidden', status: 401 });
    expect(expired.message).not.toContain('JWT');

    const dup = toApiError({ code: '23505', message: 'duplicate key', details: 'Key (id)=(x) exists.', hint: null }, 409);
    expect(dup).toMatchObject({ code: 'internal_error', status: 409 });
    expect(dup.message).not.toContain('Key (id)');
    expect(dup.message).not.toContain('duplicate');

    const prose = toApiError(
      { code: 'PGRST202', message: 'Could not find the function', details: null, hint: 'Perhaps you meant public.today_tasks' },
      404,
    );
    expect(prose).toMatchObject({ code: 'internal_error', status: 404 });
    expect(prose.message).not.toContain('Perhaps');

    const forbiddenProse = toApiError({ code: '42501', message: 'denied', details: null, hint: 'Grant SELECT' }, 403);
    expect(forbiddenProse.code).toBe('forbidden');

    expect(toApiError({ code: 'XX000', message: 'boom', details: null, hint: null }, null).code).toBe('internal_error');
  });

  it('keeps a body that is not a recognised error shape as bad_response', () => {
    // Missing details/hint keys, so not PostgREST; and not the edge-function envelope.
    expect(toApiError({ code: '42501', message: 'permission denied' }, 403).code).toBe('bad_response');
    expect(toApiError({ error: 'invalid_grant', error_description: 'secret' }, 400).code).toBe('bad_response');
    expect(toApiError('<html>proxy error</html>', 502).code).toBe('bad_response');
    expect(toApiError([], 500).code).toBe('bad_response');
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
    await expect(api.completeTask('missing')).rejects.toMatchObject({ code: 'task_not_found' });
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
    await expect(api.updateTask('t1', { title: 'x'.repeat(61) })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(api.updateTask('t1', { effort_min: 0 })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(
      api.updateTask('t1', { effort_min_initial: 1 } as unknown as Parameters<typeof api.updateTask>[1]),
    ).rejects.toMatchObject({ code: 'protected_column' });
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
    await expect(api.todayTasks()).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps a PostgREST RPC error from the real client', async () => {
    const fetchImpl = fakeFetch(404, { code: 'PT404', message: 'task_not_found', details: 'No such task', hint: 'task_not_found' });
    const api = createSupabaseApi({ url: 'https://example.test', anonKey: 'anon', getAccessToken: () => 'jwt', fetchImpl });
    await expect(api.deferTask('t1')).rejects.toMatchObject({ code: 'task_not_found', message: 'No such task', status: 404 });
  });

  it('groups the flat today_tasks list (kind, then sort_order) and keeps the order', async () => {
    // Server order: kind (quick, errand, project), then sort_order.
    const rows = [
      makeTask({ id: 'q1', title: 'Synthetic', kind: 'quick', sort_order: 0 }, TODAY),
      makeTask({ id: 'q2', title: 'Synthetic', kind: 'quick', sort_order: 4 }, TODAY),
      makeTask({ id: 'e1', title: 'Synthetic', kind: 'errand', sort_order: 1 }, TODAY),
      makeTask({ id: 'e2', title: 'Synthetic', kind: 'errand', sort_order: 2 }, TODAY),
      makeTask({ id: 'p1', title: 'Synthetic', kind: 'project', sort_order: 3 }, TODAY),
    ];
    const fetchImpl = fakeFetch(200, rows);
    const api = createSupabaseApi({ url: 'https://example.test', anonKey: 'anon', getAccessToken: () => 'jwt', fetchImpl });
    const today = await api.todayTasks();
    expect(today.quick.map((t) => t.id)).toEqual(['q1', 'q2']);
    expect(today.errand.map((t) => t.id)).toEqual(['e1', 'e2']);
    expect(today.project.map((t) => t.id)).toEqual(['p1']);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/rest/v1/rpc/today_tasks');
    expect(init.method).toBe('POST');
  });

  it('rejects a today_tasks response that is not a flat list', async () => {
    const api = createSupabaseApi({
      url: 'https://example.test',
      anonKey: 'anon',
      getAccessToken: () => 'jwt',
      fetchImpl: fakeFetch(200, { quick: [], errand: [], project: [] }),
    });
    await expect(api.todayTasks()).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('sends the RPC arguments the backend defines', async () => {
    const row = makeTask({ id: 't1', title: 'Synthetic', kind: 'quick' }, TODAY);
    const fetchImpl = fakeFetch(200, row);
    const api = createSupabaseApi({ url: 'https://example.test', anonKey: 'anon', getAccessToken: () => 'jwt', fetchImpl });
    await api.completeTask('t1');
    await api.dropTask('t1', 'obsolete');
    await api.dropTask('t1');
    const bodies = fetchImpl.mock.calls.map((c) => JSON.parse((c as [string, RequestInit])[1].body as string));
    expect(bodies).toEqual([{ id: 't1' }, { id: 't1', reason: 'obsolete' }, { id: 't1', reason: null }]);
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
