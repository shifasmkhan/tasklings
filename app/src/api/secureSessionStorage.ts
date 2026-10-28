import * as SecureStore from 'expo-secure-store';

// Where the Supabase session lives (security review S-12): the iOS Keychain through
// expo-secure-store, readable only while the device is unlocked and never synced to iCloud or
// restored to another device (WHEN_UNLOCKED_THIS_DEVICE_ONLY). Never AsyncStorage: it is plain
// files. ESLint forbids importing it.
//
// A session (access token, refresh token, user) can run past the 2048 bytes SecureStore documents
// per value, so a value is split into chunks of 512 characters (at most 2048 bytes even when every
// character takes 4 bytes) stored under `<key>.0`, `<key>.1`, ... with the count under `<key>.n`.

export interface SecureStoreLike {
  getItemAsync(key: string, options?: SecureStore.SecureStoreOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
  deleteItemAsync(key: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
}

/** The storage shape supabase-js accepts for `auth.storage`. */
export interface SessionStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const CHUNK_SIZE = 512;

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** SecureStore keys may hold only letters, digits, ".", "-" and "_". */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function createSecureSessionStorage(store: SecureStoreLike = SecureStore): SessionStorage {
  const countKey = (key: string) => `${safeKey(key)}.n`;
  const chunkKey = (key: string, i: number) => `${safeKey(key)}.${i}`;

  async function readCount(key: string): Promise<number> {
    const raw = await store.getItemAsync(countKey(key), OPTIONS);
    const n = raw === null ? 0 : Number(raw);
    return Number.isInteger(n) && n > 0 && n <= 64 ? n : 0;
  }

  async function removeItem(key: string): Promise<void> {
    const n = await readCount(key);
    // Count last: if this is interrupted, the count still says what is left to remove.
    for (let i = 0; i < n; i++) await store.deleteItemAsync(chunkKey(key, i), OPTIONS);
    await store.deleteItemAsync(countKey(key), OPTIONS);
  }

  return {
    async getItem(key) {
      const n = await readCount(key);
      if (n === 0) return null;
      let value = '';
      for (let i = 0; i < n; i++) {
        const part = await store.getItemAsync(chunkKey(key, i), OPTIONS);
        // A missing chunk means a torn write: treat as signed out rather than hand back half a token.
        if (part === null) return null;
        value += part;
      }
      return value;
    },

    async setItem(key, value) {
      const previous = await readCount(key);
      const chunks: string[] = [];
      for (let i = 0; i < value.length; ) {
        let end = Math.min(i + CHUNK_SIZE, value.length);
        // Never cut between the halves of a surrogate pair: a lone half would not survive UTF-8.
        const last = value.charCodeAt(end - 1);
        if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
        chunks.push(value.slice(i, end));
        i = end;
      }
      if (chunks.length === 0) chunks.push('');
      // Chunks first, count last: a reader never sees a count that points at chunks not written yet.
      for (const [i, chunk] of chunks.entries()) await store.setItemAsync(chunkKey(key, i), chunk, OPTIONS);
      await store.setItemAsync(countKey(key), String(chunks.length), OPTIONS);
      for (let i = chunks.length; i < previous; i++) await store.deleteItemAsync(chunkKey(key, i), OPTIONS);
    },

    removeItem,
  };
}
