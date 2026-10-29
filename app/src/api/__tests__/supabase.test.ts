import type { SupabaseClient } from '@supabase/supabase-js';

import { ApiError } from '../errors';
import { makeTask } from '../fixtures';
import type { SessionStorage } from '../secureSessionStorage';
import { assertPublicKey, createSupabaseApi } from '../supabase';

const TODAY = '2026-10-26';
const URL = 'https://example.test';
const STORAGE_KEY = 'tasklings.auth';
const CAPTURE_ID = '50000000-0000-4000-a000-000000000001';

/** An in-memory stand-in for the Keychain storage, optionally holding a signed-in session. */
function memoryStorage(signedIn: boolean): SessionStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  if (signedIn) {
    map.set(
      STORAGE_KEY,
      JSON.stringify({
        access_token: 'jwt',
        refresh_token: 'refresh',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: 'u1', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' },
      }),
    );
  }
  return {
    map,
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => void map.set(k, v),
    removeItem: async (k) => void map.delete(k),
  };
}

type Reply = { status: number; body?: unknown; contentType?: string } | Error;

function fakeFetch(reply: Reply | Reply[]) {
  const replies = Array.isArray(reply) ? reply : [reply];
  return jest.fn(async (_url: unknown, _init?: unknown) => {
    const next = replies[Math.min(fakeFetch.calls++, replies.length - 1)]!;
    if (next instanceof Error) throw next;
    const text = next.body === undefined ? '' : JSON.stringify(next.body);
    return new Response(next.status === 204 ? null : text, {
      status: next.status,
      headers: next.body === undefined ? {} : { 'Content-Type': next.contentType ?? 'application/json' },
    });
  }) as unknown as typeof fetch & jest.Mock;
}
fakeFetch.calls = 0;

function api(reply: Reply | Reply[], opts: { signedIn?: boolean } = {}) {
  fakeFetch.calls = 0;
  const fetchImpl = fakeFetch(reply);
  const storage = memoryStorage(opts.signedIn ?? true);
  const client = createSupabaseApi({ url: URL, anonKey: 'anon', storage, fetchImpl, autoRefreshToken: false });
  return { client, fetchImpl, storage };
}

function call(fetchImpl: jest.Mock, i = 0) {
  const [url, init] = fetchImpl.mock.calls[i] as [string, RequestInit & { headers: Headers | Record<string, string> }];
  const headers = new Headers(init.headers as HeadersInit);
  return { url: String(url), method: init.method, headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
}

describe('config', () => {
  const storage = memoryStorage(false);

  it('refuses a non-https URL, except for loopback in local development', () => {
    expect(() => createSupabaseApi({ url: 'http://example.test', anonKey: 'anon', storage })).toThrow(ApiError);
    expect(() => createSupabaseApi({ url: 'http://10.0.0.5:54321', anonKey: 'anon', storage })).toThrow(ApiError);
    expect(() => createSupabaseApi({ url: 'http://127.0.0.1:54321', anonKey: 'anon', storage, autoRefreshToken: false })).not.toThrow();
  });

  it('refuses a service-role or secret key: those never ship in an app', () => {
    const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const serviceRole = `${b64({ alg: 'HS256' })}.${b64({ role: 'service_role' })}.sig`;
    const anon = `${b64({ alg: 'HS256' })}.${b64({ role: 'anon' })}.sig`;
    expect(() => assertPublicKey(serviceRole)).toThrow(ApiError);
    expect(() => assertPublicKey('sb_secret_abc123')).toThrow(ApiError);
    expect(() => assertPublicKey('')).toThrow(ApiError);
    expect(() => assertPublicKey(anon)).not.toThrow();
    expect(() => assertPublicKey('sb_publishable_abc123')).not.toThrow();
    expect(() => createSupabaseApi({ url: URL, anonKey: serviceRole, storage })).toThrow(ApiError);
  });
});

describe('supabase client: no session', () => {
  it('fails closed with unauthenticated and sends nothing', async () => {
    const { client, fetchImpl } = api({ status: 200, body: [] }, { signedIn: false });
    await expect(client.todayTasks()).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
    await expect(client.completeTask('t1')).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(client.updateTask('t1', { title: 'Synthetic' })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(client.undoCapture(CAPTURE_ID)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(
      client.processCapture({ capture_id: CAPTURE_ID, transcript: 'x', captured_at: '2026-10-27T09:00:00Z', timezone: 'UTC' }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('supabase client: sign-in', () => {
  it('signs in by sending the raw nonce next to the identity token, never the hash', async () => {
    const { client, fetchImpl, storage } = api(
      {
        status: 200,
        body: {
          access_token: 'jwt',
          refresh_token: 'r',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: 1900000000,
          user: { id: 'u1', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' },
        },
      },
      { signedIn: false },
    );
    const session = await client.signInWithApple('apple-id-token', 'raw-nonce');
    expect(session).toEqual({ access_token: 'jwt', user_id: 'u1', expires_at: 1900000000 });
    const c = call(fetchImpl);
    expect(c.url).toContain('/auth/v1/token');
    expect(c.url).toContain('grant_type=id_token');
    expect(c.body).toMatchObject({ provider: 'apple', id_token: 'apple-id-token', nonce: 'raw-nonce' });
    // The session went to the injected (Keychain) storage.
    expect(storage.map.get(STORAGE_KEY)).toContain('"access_token":"jwt"');
  });

  it('refuses to sign in without a nonce and sends nothing', async () => {
    const { client, fetchImpl } = api({ status: 200, body: {} }, { signedIn: false });
    await expect(client.signInWithApple('apple-id-token', '')).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(client.signInWithApple('', 'raw-nonce')).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('turns a refused sign-in into unauthenticated without the server text', async () => {
    const { client } = api(
      { status: 400, body: { error: 'invalid_grant', error_description: 'secret provider detail' } },
      { signedIn: false },
    );
    const err = await client.signInWithApple('apple-id-token', 'raw-nonce').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'unauthenticated' });
    expect((err as ApiError).message).not.toContain('secret');
  });
});

describe('supabase client: RPCs and table edits', () => {
  it('sends the user JWT and the anon key', async () => {
    const { client, fetchImpl } = api({ status: 200, body: makeTask({ id: 't1', title: 'Synthetic', kind: 'quick' }, TODAY) });
    await client.completeTask('t1');
    const c = call(fetchImpl);
    expect(c.url).toBe(`${URL}/rest/v1/rpc/complete_task`);
    expect(c.method).toBe('POST');
    expect(c.headers.get('Authorization')).toBe('Bearer jwt');
    expect(c.headers.get('apikey')).toBe('anon');
  });

  it('maps a PostgREST RPC error: stable code from hint, message from details', async () => {
    const { client } = api({
      status: 404,
      body: { code: 'PT404', message: 'task_not_found', details: 'No such task', hint: 'task_not_found' },
    });
    await expect(client.deferTask('t1')).rejects.toMatchObject({ code: 'task_not_found', message: 'No such task', status: 404 });
  });

  it('maps a platform error with no hint to forbidden or internal_error, without the server text', async () => {
    const denied = api({ status: 403, body: { code: '42501', message: 'permission denied for table tasks', details: null, hint: null } });
    const err = await denied.client.dropTask('t1').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'forbidden', status: 403 });
    expect((err as ApiError).message).not.toContain('permission denied');
    const broken = api({ status: 500, body: { code: 'XX000', message: 'boom', details: null, hint: null } });
    await expect(broken.client.dropTask('t1')).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('maps a request that never got an answer to network_error', async () => {
    const { client } = api(new TypeError('Network request failed'));
    await expect(client.todayTasks()).rejects.toMatchObject({ code: 'network_error' });
  });

  it('groups the flat today_tasks list (kind, then sort_order) and keeps the order', async () => {
    const rows = [
      makeTask({ id: 'q1', title: 'Synthetic', kind: 'quick', sort_order: 0 }, TODAY),
      makeTask({ id: 'q2', title: 'Synthetic', kind: 'quick', sort_order: 4 }, TODAY),
      makeTask({ id: 'e1', title: 'Synthetic', kind: 'errand', sort_order: 1 }, TODAY),
      makeTask({ id: 'e2', title: 'Synthetic', kind: 'errand', sort_order: 2 }, TODAY),
      makeTask({ id: 'p1', title: 'Synthetic', kind: 'project', sort_order: 3 }, TODAY),
    ];
    const { client, fetchImpl } = api({ status: 200, body: rows });
    const today = await client.todayTasks();
    expect(today.quick.map((t) => t.id)).toEqual(['q1', 'q2']);
    expect(today.errand.map((t) => t.id)).toEqual(['e1', 'e2']);
    expect(today.project.map((t) => t.id)).toEqual(['p1']);
    expect(call(fetchImpl).url).toBe(`${URL}/rest/v1/rpc/today_tasks`);
  });

  it('rejects a today_tasks response that is not a flat list', async () => {
    const { client } = api({ status: 200, body: { quick: [], errand: [], project: [] } });
    await expect(client.todayTasks()).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('sends the RPC arguments the backend defines', async () => {
    const row = makeTask({ id: 't1', title: 'Synthetic', kind: 'quick' }, TODAY);
    const { client, fetchImpl } = api({ status: 200, body: row });
    await client.completeTask('t1');
    await client.undoTask('t1');
    await client.deferTask('t1');
    await client.dropTask('t1', 'obsolete');
    await client.dropTask('t1');
    expect(fetchImpl.mock.calls.map((_, i) => [call(fetchImpl, i).url.split('/rpc/')[1], call(fetchImpl, i).body])).toEqual([
      ['complete_task', { id: 't1' }],
      ['undo_task', { id: 't1' }],
      ['defer_task', { id: 't1' }],
      ['drop_task', { id: 't1', reason: 'obsolete' }],
      ['drop_task', { id: 't1', reason: null }],
    ]);
  });

  it('sends only the editable columns on a task edit and returns the updated row', async () => {
    const row = makeTask({ id: 't1', title: 'Synthetic edit', kind: 'quick' }, TODAY);
    const { client, fetchImpl } = api({ status: 200, body: [row] });
    const edit = { title: 'Synthetic edit', effort_min_initial: 1, user_id: 'other', status: 'done' } as unknown as Parameters<
      typeof client.updateTask
    >[1];
    const updated = await client.updateTask('t1', edit);
    expect(updated.id).toBe('t1');
    const c = call(fetchImpl);
    expect(c.method).toBe('PATCH');
    expect(c.url).toContain('/rest/v1/tasks?');
    expect(c.url).toContain('id=eq.t1');
    expect(c.body).toEqual({ title: 'Synthetic edit' });
  });

  it('reports task_not_found when an edit matches no row, and maps protected_column', async () => {
    const none = api({ status: 200, body: [] });
    await expect(none.client.updateTask('t1', { title: 'Synthetic' })).rejects.toMatchObject({ code: 'task_not_found' });
    const guarded = api({
      status: 403,
      body: { code: 'PT403', message: 'protected_column', details: 'Use the RPCs', hint: 'protected_column' },
    });
    await expect(guarded.client.updateTask('t1', { title: 'Synthetic' })).rejects.toMatchObject({ code: 'protected_column' });
  });
});

describe('supabase client: undo_capture (US-09)', () => {
  it('calls the RPC with { capture_id } and returns the number of tasks removed', async () => {
    const { client, fetchImpl } = api({ status: 200, body: 3 });
    await expect(client.undoCapture(CAPTURE_ID)).resolves.toBe(3);
    const c = call(fetchImpl);
    expect(c.url).toBe(`${URL}/rest/v1/rpc/undo_capture`);
    expect(c.body).toEqual({ capture_id: CAPTURE_ID });
  });

  it('maps undo_expired (409) through the hint convention', async () => {
    const { client } = api({
      status: 409,
      body: { code: 'PT409', message: 'undo_expired', details: 'This capture can no longer be undone', hint: 'undo_expired' },
    });
    await expect(client.undoCapture(CAPTURE_ID)).rejects.toMatchObject({ code: 'undo_expired', status: 409 });
  });

  it('rejects a response that is not a number', async () => {
    const { client } = api({ status: 200, body: { removed: 3 } });
    await expect(client.undoCapture(CAPTURE_ID)).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('supabase client: edge functions', () => {
  const request = { capture_id: CAPTURE_ID, transcript: 'Synthetic note', captured_at: '2026-10-27T09:00:00Z', timezone: 'America/Chicago' };

  it('process-capture sends the source with the user JWT and returns the 202 body', async () => {
    const { client, fetchImpl } = api({ status: 202, body: { capture_id: CAPTURE_ID } });
    await expect(client.processCapture({ ...request, source: 'text' })).resolves.toEqual({ capture_id: CAPTURE_ID });
    const c = call(fetchImpl);
    expect(c.url).toContain('/functions/v1/process-capture');
    expect(c.headers.get('Authorization')).toBe('Bearer jwt');
    expect(c.body).toEqual({ ...request, source: 'text' });
  });

  it('process-capture omits source when the caller does not set one (the server defaults to voice)', async () => {
    const { client, fetchImpl } = api({ status: 202, body: { capture_id: CAPTURE_ID } });
    await client.processCapture(request);
    expect(call(fetchImpl).body).toEqual(request);
  });

  it('maps the edge-function error envelope', async () => {
    const { client } = api({ status: 400, body: { error: { code: 'invalid_request', message: 'source must be one of voice, text, siri, widget' } } });
    await expect(client.processCapture({ ...request, source: 'text' })).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    const conflict = api({ status: 409, body: { error: { code: 'capture_conflict', message: 'capture_id is already in use' } } });
    await expect(conflict.client.processCapture(request)).rejects.toMatchObject({ code: 'capture_conflict', status: 409 });
  });

  it('maps an unreachable function to network_error and a non-JSON failure to bad_response', async () => {
    const down = api(new TypeError('Network request failed'));
    await expect(down.client.processCapture(request)).rejects.toMatchObject({ code: 'network_error' });
    const html = api({ status: 502, body: '<html>proxy error</html>', contentType: 'text/html' });
    await expect(html.client.processCapture(request)).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('register-device, export-data and delete-account call their functions', async () => {
    const reg = api({ status: 204 });
    await expect(reg.client.registerDevice('ab'.repeat(32))).resolves.toBeUndefined();
    expect(call(reg.fetchImpl).body).toEqual({ apns_token: 'ab'.repeat(32) });
    const exp = api({ status: 200, body: { tasks: [] } });
    await expect(exp.client.exportData()).resolves.toEqual({ tasks: [] });
    expect(call(exp.fetchImpl).url).toContain('/functions/v1/export-data');
    const del = api({ status: 204 });
    await expect(del.client.deleteAccount()).resolves.toBeUndefined();
    expect(call(del.fetchImpl).url).toContain('/functions/v1/delete-account');
  });
});

describe('supabase client: injected client', () => {
  it('uses a client it is given and still checks the session first', async () => {
    const getSession = jest.fn(async () => ({ data: { session: null }, error: null }));
    const rpc = jest.fn();
    const fake = { auth: { getSession }, rpc, channel: jest.fn(), from: jest.fn() } as unknown as SupabaseClient;
    const client = createSupabaseApi({ url: URL, anonKey: 'anon', storage: memoryStorage(false), client: fake });
    await expect(client.todayTasks()).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('supabase client: profile (US-11)', () => {
  const row = { display_name: null, timezone: 'America/Chicago', brief_time: '08:00:00', checkin_time: '20:30:00' };

  it('reads only the four profile columns and normalises Postgres time to HH:MM', async () => {
    const { client, fetchImpl } = api({ status: 200, body: row });
    await expect(client.getProfile()).resolves.toEqual({
      displayName: null,
      timezone: 'America/Chicago',
      briefTime: '08:00',
      checkinTime: '20:30',
    });
    const req = call(fetchImpl);
    expect(req.method).toBe('GET');
    expect(decodeURIComponent(req.url)).toContain('select=display_name,timezone,brief_time,checkin_time');
    expect(req.url).not.toContain('apple');
  });

  it('rejects a time that is not a time', async () => {
    const { client } = api({ status: 200, body: { ...row, brief_time: 'soon' } });
    await expect(client.getProfile()).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('fails closed without a session', async () => {
    const { client, fetchImpl } = api({ status: 200, body: row }, { signedIn: false });
    await expect(client.getProfile()).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('updates the caller\'s own row and sends only brief_time and checkin_time', async () => {
    const { client, fetchImpl } = api({ status: 200, body: { ...row, brief_time: '07:15:00' } });
    const sneaky = { briefTime: '07:15', display_name: 'x', timezone: 'Mars/Base', user_id: 'u2' } as never;
    await expect(client.updateProfileTimes(sneaky)).resolves.toMatchObject({ briefTime: '07:15', checkinTime: '20:30' });
    const req = call(fetchImpl);
    expect(req.method).toBe('PATCH');
    expect(req.body).toEqual({ brief_time: '07:15' });
    expect(req.url).toContain('user_id=eq.u1');
  });

  it('sends both times when both change', async () => {
    const { client, fetchImpl } = api({ status: 200, body: row });
    await client.updateProfileTimes({ briefTime: '06:00', checkinTime: '21:45' });
    expect(call(fetchImpl).body).toEqual({ brief_time: '06:00', checkin_time: '21:45' });
  });

  it.each(['24:00', '8:00', '12:60', '', '08:00:00', 'ab:cd'])('refuses %p with invalid_request and sends nothing', async (bad) => {
    const { client, fetchImpl } = api({ status: 200, body: row });
    await expect(client.updateProfileTimes({ briefTime: bad })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.updateProfileTimes({ checkinTime: bad })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts the day\'s edges and refuses an empty update', async () => {
    const { client, fetchImpl } = api({ status: 200, body: row });
    await client.updateProfileTimes({ briefTime: '00:00', checkinTime: '23:59' });
    expect(call(fetchImpl).body).toEqual({ brief_time: '00:00', checkin_time: '23:59' });
    await expect(client.updateProfileTimes({})).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('supabase client: task read (US-05)', () => {
  const ID = '10000000-0000-4000-8000-000000000001';
  const task = { ...makeTask({ id: ID, title: 'Synthetic task', kind: 'quick', capture_id: CAPTURE_ID }, TODAY) };

  it('joins the capture transcript and the enrichments onto the task', async () => {
    const { client, fetchImpl } = api([
      { status: 200, body: [task] },
      { status: 200, body: [{ transcript: 'synthetic transcript' }] },
      {
        status: 200,
        body: [
          { id: 'en1', type: 'phone', value: '(555) 010-0100', source_url: null },
          { id: 'en2', type: 'url', value: 'https://example.test', source_url: 'https://example.test/src' },
          { id: 'en3', type: 'bogus', value: 'x', source_url: null },
        ],
      },
    ]);
    const detail = await client.getTask(ID);
    expect(detail).toMatchObject({ id: ID, transcript: 'synthetic transcript' });
    expect(detail.enrichments).toEqual([
      { id: 'en1', type: 'phone', value: '(555) 010-0100', sourceUrl: null },
      { id: 'en2', type: 'url', value: 'https://example.test', sourceUrl: 'https://example.test/src' },
    ]);
    const urls = fetchImpl.mock.calls.map((c: unknown[]) => decodeURIComponent(String(c[0])));
    expect(urls.some((u: string) => u.includes('/rest/v1/tasks') && u.includes(`id=eq.${ID}`))).toBe(true);
    expect(urls.some((u: string) => u.includes('/rest/v1/captures') && u.includes(`id=eq.${CAPTURE_ID}`) && u.includes('select=transcript'))).toBe(true);
    expect(urls.some((u: string) => u.includes('/rest/v1/task_enrichments') && u.includes(`task_id=eq.${ID}`))).toBe(true);
  });

  it('skips the capture read when the task has no capture', async () => {
    const { client, fetchImpl } = api([
      { status: 200, body: [{ ...task, capture_id: null }] },
      { status: 200, body: [] },
    ]);
    const detail = await client.getTask(ID);
    expect(detail.transcript).toBeNull();
    expect(detail.enrichments).toEqual([]);
    const urls = fetchImpl.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(urls.some((u: string) => u.includes('/captures'))).toBe(false);
  });

  it('maps a missing task (or another user\'s, which RLS hides) to not_found', async () => {
    const { client } = api({ status: 200, body: [] });
    await expect(client.getTask(ID)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('answers not_found for an id that is not a UUID without a request', async () => {
    const { client, fetchImpl } = api({ status: 200, body: [] });
    await expect(client.getTask('not-a-uuid')).rejects.toMatchObject({ code: 'not_found' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('supabase client: recently dropped (US-09)', () => {
  it('asks for dropped tasks updated in the last 30 days, newest first, at most 100', async () => {
    const now = new Date('2026-10-28T12:00:00.000Z');
    fakeFetch.calls = 0;
    const fetchImpl = fakeFetch({ status: 200, body: [makeTask({ id: 'd1', title: 'Synthetic', kind: 'quick', status: 'dropped' }, TODAY)] });
    const client = createSupabaseApi({ url: URL, anonKey: 'anon', storage: memoryStorage(true), fetchImpl, autoRefreshToken: false, now: () => now });
    const tasks = await client.recentlyDropped();
    expect(tasks).toHaveLength(1);
    const u = new globalThis.URL(decodeURIComponent(call(fetchImpl).url));
    expect(u.searchParams.get('status')).toBe('eq.dropped');
    expect(u.searchParams.get('updated_at')).toBe('gte.2026-09-28T12:00:00.000Z');
    expect(u.searchParams.get('order')).toBe('updated_at.desc');
    expect(u.searchParams.get('limit')).toBe('100');
  });

  it('returns an empty list for no rows', async () => {
    const { client } = api({ status: 200, body: [] });
    await expect(client.recentlyDropped()).resolves.toEqual([]);
  });
});

describe('supabase client: delete-account', () => {
  it('clears the stored session after the account is deleted, and not when it fails', async () => {
    const ok = api({ status: 204 });
    await ok.client.deleteAccount();
    expect(ok.storage.map.size).toBe(0);
    const stale = api({ status: 403, body: { error: { code: 'reauth_required', message: 'Sign in again' } } });
    await expect(stale.client.deleteAccount()).rejects.toMatchObject({ code: 'reauth_required' });
    expect(stale.storage.map.size).toBeGreaterThan(0);
  });
});
