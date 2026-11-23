import { isDevSignInEnabled } from '../devSignIn';
import { createMockApi, MOCK_PASSWORD } from '../mock';
import type { SessionStorage } from '../secureSessionStorage';
import { createSupabaseApi } from '../supabase';

// The owner-only email and password sign-in (TM-10) exists only when the build sets
// EXPO_PUBLIC_ENABLE_DEV_SIGNIN=1. These tests cover both states for the mock and the live client.

const original = process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN;
afterEach(() => {
  if (original === undefined) delete process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN;
  else process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = original;
});

function memoryStorage(): SessionStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => void map.set(k, v),
    removeItem: async (k) => void map.delete(k),
  };
}

function session(provider: string) {
  return {
    access_token: 'jwt',
    refresh_token: 'refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'u1', aud: 'authenticated', app_metadata: { provider }, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' },
  };
}

function live(reply: { status: number; body?: unknown } | Error = { status: 200, body: {} }) {
  const fetchImpl = jest.fn(async (_url: unknown, _init?: unknown) => {
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch & jest.Mock;
  const storage = memoryStorage();
  const client = createSupabaseApi({ url: 'https://example.test', anonKey: 'anon', storage, fetchImpl, autoRefreshToken: false });
  const sent = (i = 0) => {
    const [url, init] = fetchImpl.mock.calls[i] as [string, RequestInit];
    return { url: String(url), body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined };
  };
  return { client, fetchImpl, storage, sent };
}

describe('the build flag', () => {
  it('is on only for exactly "1"', () => {
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1']) {
      if (v === undefined) delete process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN;
      else process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = v;
      expect(isDevSignInEnabled()).toBe(false);
    }
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
    expect(isDevSignInEnabled()).toBe(true);
  });
});

describe('without the flag (every other build)', () => {
  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN;
  });

  it('the live client refuses it with `unavailable` and sends no request', async () => {
    const { client, fetchImpl, storage } = live();
    await expect(client.signInWithPassword('owner@example.test', 'a-long-password')).rejects.toMatchObject({ code: 'unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(storage.map.size).toBe(0);
  });

  it('the mock refuses it too', async () => {
    const mock = createMockApi({ tasks: [] });
    await expect(mock.signInWithPassword('owner@example.test', MOCK_PASSWORD)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await mock.signInMethod()).toBe('apple');
  });
});

describe('with the flag (simulator-live builds)', () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
  });

  it('signs in with the address trimmed and lowercased, and keeps the session in the injected (Keychain) storage', async () => {
    const t = live({ status: 200, body: session('email') });
    const result = await t.client.signInWithPassword('  Owner@Example.test ', 'correct horse battery');
    expect(t.sent().url).toContain('/auth/v1/token?grant_type=password');
    expect(t.sent().body).toMatchObject({ email: 'owner@example.test', password: 'correct horse battery' });
    expect(result).toMatchObject({ access_token: 'jwt', user_id: 'u1' });
    expect(t.storage.map.get('tasklings.auth')).toContain('"access_token":"jwt"');
    expect(await t.client.signInMethod()).toBe('email');
  });

  it('a refused sign-in is one generic code, whatever the server said', async () => {
    const t = live({ status: 400, body: { error_code: 'invalid_credentials', msg: 'Invalid login credentials' } });
    const err = await t.client.signInWithPassword('nobody@example.test', 'wrong').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'signin_failed' });
    expect(JSON.stringify(err)).not.toMatch(/invalid|credentials|nobody|wrong/i);
    expect(String((err as Error).message)).not.toMatch(/credentials|nobody|wrong/i);
    expect(await t.client.signInMethod()).toBeNull();
  });

  it('a request that never got an answer is network_error', async () => {
    const t = live(new TypeError('Network request failed'));
    await expect(t.client.signInWithPassword('owner@example.test', 'x')).rejects.toMatchObject({ code: 'network_error' });
  });

  it('rejects a malformed address or an empty password before any request', async () => {
    const t = live();
    for (const bad of ['', 'plain', ' ', '@', 'a b@c']) {
      await expect(t.client.signInWithPassword(bad, 'x')).rejects.toMatchObject({ code: 'signin_failed' });
    }
    await expect(t.client.signInWithPassword('owner@example.test', '')).rejects.toMatchObject({ code: 'signin_failed' });
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it('signInMethod is null signed out, email for an email session and apple otherwise', async () => {
    expect(await live().client.signInMethod()).toBeNull();
    const apple = live({ status: 200, body: session('apple') });
    await apple.client.signInWithApple('apple-id-token', 'raw-nonce');
    expect(await apple.client.signInMethod()).toBe('apple');
  });

  it('the mock accepts any email with the fixed password and rejects others; its export then fails closed', async () => {
    const mock = createMockApi({ tasks: [] });
    await expect(mock.signInWithPassword('anyone@example.test', 'nope')).rejects.toMatchObject({ code: 'signin_failed' });
    expect(await mock.signInMethod()).toBe('apple');
    await expect(mock.signInWithPassword('anyone@example.test', MOCK_PASSWORD)).resolves.toMatchObject({ access_token: 'mock-session' });
    expect(await mock.signInMethod()).toBe('email');
    await expect(mock.exportData()).rejects.toMatchObject({ code: 'reauth_required' });
    await expect(mock.deleteAccount('code')).rejects.toMatchObject({ code: 'reauth_required' });
  });
});
