import * as SecureStore from 'expo-secure-store';

import { CHUNK_SIZE, createSecureSessionStorage, type SecureStoreLike } from '../secureSessionStorage';

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

function fakeStore() {
  const map = new Map<string, string>();
  const seen: unknown[] = [];
  const store: SecureStoreLike = {
    getItemAsync: async (k, o) => (seen.push(o), map.get(k) ?? null),
    setItemAsync: async (k, v, o) => {
      seen.push(o);
      // SecureStore documents 2048 bytes per value.
      if (new TextEncoder().encode(v).length > 2048) throw new Error('value too large');
      map.set(k, v);
    },
    deleteItemAsync: async (k, o) => (seen.push(o), void map.delete(k)),
  };
  return { map, store, seen };
}

describe('secure session storage', () => {
  it('round-trips a session larger than one SecureStore value, split into chunks', async () => {
    const { store, map } = fakeStore();
    const storage = createSecureSessionStorage(store);
    const session = JSON.stringify({ access_token: 'a'.repeat(3000), refresh_token: 'r'.repeat(40), user: { name: 'Synthetic Üser 🙂' } });
    await storage.setItem('tasklings.auth', session);
    expect(await storage.getItem('tasklings.auth')).toBe(session);
    expect(map.get('tasklings.auth.n')).toBe(String(Math.ceil(session.length / CHUNK_SIZE)));
    for (const [k, v] of map) if (k !== 'tasklings.auth.n') expect(v.length).toBeLessThanOrEqual(CHUNK_SIZE);
  });

  it('never splits a surrogate pair across chunks', async () => {
    const { store, map } = fakeStore();
    const storage = createSecureSessionStorage(store);
    const value = 'a'.repeat(CHUNK_SIZE - 1) + '🙂'.repeat(5);
    await storage.setItem('k', value);
    expect(await storage.getItem('k')).toBe(value);
    for (const [key, part] of map) {
      if (key === 'k.n') continue;
      expect(part.isWellFormed()).toBe(true);
    }
  });

  it('keeps every item this-device-only and unlocked-only', async () => {
    const { store, seen } = fakeStore();
    const storage = createSecureSessionStorage(store);
    await storage.setItem('k', 'v');
    await storage.getItem('k');
    await storage.removeItem('k');
    expect(seen.length).toBeGreaterThan(0);
    for (const options of seen) {
      expect(options).toEqual({ keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    }
  });

  it('a shorter value replaces a longer one and removes the leftover chunks', async () => {
    const { store, map } = fakeStore();
    const storage = createSecureSessionStorage(store);
    await storage.setItem('k', 'x'.repeat(CHUNK_SIZE * 3));
    await storage.setItem('k', 'short');
    expect(await storage.getItem('k')).toBe('short');
    expect([...map.keys()].sort()).toEqual(['k.0', 'k.n']);
  });

  it('removeItem deletes every chunk and the count', async () => {
    const { store, map } = fakeStore();
    const storage = createSecureSessionStorage(store);
    await storage.setItem('k', 'x'.repeat(CHUNK_SIZE * 2 + 1));
    await storage.removeItem('k');
    expect(map.size).toBe(0);
    expect(await storage.getItem('k')).toBeNull();
  });

  it('treats a missing chunk or a bad count as signed out', async () => {
    const { store, map } = fakeStore();
    const storage = createSecureSessionStorage(store);
    await storage.setItem('k', 'x'.repeat(CHUNK_SIZE * 2));
    map.delete('k.1');
    expect(await storage.getItem('k')).toBeNull();
    map.set('k.n', 'not a number');
    expect(await storage.getItem('k')).toBeNull();
    map.set('k.n', '9999');
    expect(await storage.getItem('k')).toBeNull();
  });

  it('maps characters SecureStore does not allow in a key', async () => {
    const { store, map } = fakeStore();
    await createSecureSessionStorage(store).setItem('sb:auth token/1', 'v');
    expect([...map.keys()].every((k) => /^[A-Za-z0-9._-]+$/.test(k))).toBe(true);
  });

  it('defaults to expo-secure-store', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValueOnce(null);
    expect(await createSecureSessionStorage().getItem('k')).toBeNull();
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith('k.n', {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  });
});
