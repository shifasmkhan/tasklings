import { createDefaultApi } from '../index';
import { createLiveApi, readLiveConfig } from '../live';

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

const URL_VAR = 'EXPO_PUBLIC_SUPABASE_URL';
const KEY_VAR = 'EXPO_PUBLIC_SUPABASE_ANON_KEY';
const saved = { url: process.env[URL_VAR], key: process.env[KEY_VAR] };

function setEnv(url: string | undefined, key: string | undefined) {
  if (url === undefined) delete process.env[URL_VAR];
  else process.env[URL_VAR] = url;
  if (key === undefined) delete process.env[KEY_VAR];
  else process.env[KEY_VAR] = key;
}

afterEach(() => setEnv(saved.url, saved.key));

describe('which backend the app uses', () => {
  it('keeps the mock unless both variables are set', () => {
    for (const [url, key] of [
      [undefined, undefined],
      ['https://example.test', undefined],
      [undefined, 'anon'],
      ['https://example.test', ''],
      ['  ', 'anon'],
    ] as const) {
      setEnv(url, key);
      expect(readLiveConfig()).toBeNull();
      expect('snapshot' in createDefaultApi()).toBe(true); // only the mock has the test hooks
    }
  });

  it('uses the live client when both are set', () => {
    setEnv('https://example.test', 'anon');
    expect(readLiveConfig()).toEqual({ url: 'https://example.test', anonKey: 'anon' });
    const api = createDefaultApi();
    expect('snapshot' in api).toBe(false);
    expect('client' in api).toBe(true);
  });

  it('fails loudly on a bad URL instead of silently falling back to the mock', () => {
    setEnv('http://example.test', 'anon');
    expect(() => createDefaultApi()).toThrow(/https/);
  });

  it('without a session the live client rejects with unauthenticated', async () => {
    const api = createLiveApi({ url: 'https://example.test', anonKey: 'anon' });
    await expect(api.todayTasks()).rejects.toMatchObject({ code: 'unauthenticated' });
    await api.client.auth.stopAutoRefresh();
  });
});
