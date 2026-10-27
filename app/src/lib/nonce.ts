import * as Crypto from 'expo-crypto';

// Sign in with Apple nonce (client side). The raw nonce goes to Supabase Auth; only its
// SHA-256 hex goes to Apple. Supabase hashes the raw value and compares it with the `nonce`
// claim in Apple's identity token, so a leaked token can't be replayed with a different nonce.

/** 32 random bytes = 256 bits of entropy, enough that guessing is not a concern. */
export const NONCE_BYTES = 32;

export interface AppleNonce {
  /** Send to Supabase (signInWithIdToken `nonce`). Keep in memory only. */
  raw: string;
  /** Lowercase SHA-256 hex of `raw`. Send to Apple as the request nonce. */
  hashed: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of the raw nonce as lowercase hex. */
export function hashNonce(raw: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, raw, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
}

/** A fresh nonce from the platform's cryptographically secure random source. */
export async function createAppleNonce(): Promise<AppleNonce> {
  const raw = toHex(Crypto.getRandomBytes(NONCE_BYTES));
  return { raw, hashed: await hashNonce(raw) };
}
