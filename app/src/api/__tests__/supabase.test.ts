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
