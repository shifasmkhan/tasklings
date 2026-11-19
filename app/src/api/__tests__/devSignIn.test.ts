import { isDevSignInEnabled } from '../devSignIn';
import { createMockApi, MOCK_EMAIL_CODE } from '../mock';
import type { SessionStorage } from '../secureSessionStorage';
import { createSupabaseApi } from '../supabase';

// The owner-only email-code sign-in (TM-10) exists only when the build sets
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

  it('the live client refuses both methods with `unavailable` and sends no request', async () => {
    const { client, fetchImpl, storage } = live();
    await expect(client.requestEmailCode('owner@example.test')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(client.verifyEmailCode('owner@example.test', '123456')).rejects.toMatchObject({ code: 'unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(storage.map.size).toBe(0);
  });

  it('the mock refuses both methods too', async () => {
    const mock = createMockApi({ tasks: [] });
    await expect(mock.requestEmailCode('owner@example.test')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(mock.verifyEmailCode('owner@example.test', MOCK_EMAIL_CODE)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await mock.signInMethod()).toBe('apple');
  });
});

describe('with the flag (simulator-live builds)', () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_ENABLE_DEV_SIGNIN = '1';
  });

  it('requestEmailCode asks for a code for an existing user only, with the address trimmed and lowercased', async () => {
    const t = live();
    await t.client.requestEmailCode('  Owner@Example.test ');
    expect(t.sent().url).toContain('/auth/v1/otp');
    expect(t.sent().body).toMatchObject({ email: 'owner@example.test', create_user: false });
  });

  it('a refused code request is one generic code, whatever the server said', async () => {
    const t = live({ status: 422, body: { error_code: 'otp_disabled', msg: 'Signups not allowed for otp' } });
    const err = await t.client.requestEmailCode('nobody@example.test').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'code_request_failed' });
    expect(JSON.stringify(err)).not.toMatch(/signups|otp_disabled|nobody/i);
    expect(String((err as Error).message)).not.toMatch(/signups|nobody/i);
  });

  it('a request that never got an answer is network_error', async () => {
    const t = live(new TypeError('Network request failed'));
    await expect(t.client.requestEmailCode('owner@example.test')).rejects.toMatchObject({ code: 'network_error' });
  });

  it('rejects a malformed address before any request', async () => {
    const t = live();
    for (const bad of ['', 'plain', ' ', '@', 'a b@c']) {
      await expect(t.client.requestEmailCode(bad)).rejects.toMatchObject({ code: 'code_request_failed' });
    }
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it('verifyEmailCode exchanges the 6-digit code for a session kept in the injected (Keychain) storage', async () => {
    const t = live({ status: 200, body: session('email') });
    const result = await t.client.verifyEmailCode('Owner@Example.test', '123456');
    expect(t.sent().url).toContain('/auth/v1/verify');
    expect(t.sent().body).toMatchObject({ email: 'owner@example.test', token: '123456', type: 'email' });
    expect(result).toMatchObject({ access_token: 'jwt', user_id: 'u1' });
    expect(t.storage.map.get('tasklings.auth')).toContain('"access_token":"jwt"');
    expect(await t.client.signInMethod()).toBe('email');
  });

  it('a wrong code is code_invalid; a code that is not 6 digits never leaves the device', async () => {
    const t = live({ status: 403, body: { error_code: 'otp_expired', msg: 'Token has expired or is invalid' } });
    await expect(t.client.verifyEmailCode('owner@example.test', '123456')).rejects.toMatchObject({ code: 'code_invalid' });
    const calls = t.fetchImpl.mock.calls.length;
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456']) {
      await expect(t.client.verifyEmailCode('owner@example.test', bad)).rejects.toMatchObject({ code: 'code_invalid' });
    }
    expect(t.fetchImpl.mock.calls.length).toBe(calls);
    expect(await t.client.signInMethod()).toBeNull();
  });

  it('signInMethod is null signed out, email for an email session and apple otherwise', async () => {
    expect(await live().client.signInMethod()).toBeNull();
    const apple = live({ status: 200, body: session('apple') });
    await apple.client.signInWithApple('apple-id-token', 'raw-nonce');
    expect(await apple.client.signInMethod()).toBe('apple');
  });

  it('the mock accepts any email with the fixed code and rejects others; its export then fails closed', async () => {
    const mock = createMockApi({ tasks: [] });
    await mock.requestEmailCode('anyone@example.test');
    await expect(mock.verifyEmailCode('anyone@example.test', '111111')).rejects.toMatchObject({ code: 'code_invalid' });
    expect(await mock.signInMethod()).toBe('apple');
    await expect(mock.verifyEmailCode('anyone@example.test', MOCK_EMAIL_CODE)).resolves.toMatchObject({ access_token: 'mock-session' });
    expect(await mock.signInMethod()).toBe('email');
    await expect(mock.exportData()).rejects.toMatchObject({ code: 'reauth_required' });
    await expect(mock.deleteAccount('code')).rejects.toMatchObject({ code: 'reauth_required' });
  });
});
