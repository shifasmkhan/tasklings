import { createAppleNonce } from '@/lib/nonce';

/**
 * What signInWithApple needs: Apple's identity token and the raw nonce whose hash Apple signed.
 * `authorizationCode` is Apple's one-time code from the same sign-in; delete-account sends it so
 * the server can revoke the sign-in with Apple (TM-02). Null when Apple gave none.
 */
export interface AppleCredential {
  identityToken: string;
  rawNonce: string;
  authorizationCode: string | null;
}

/** Shows Apple's sign-in sheet and returns its credential. Rejects with ApiError `canceled` if dismissed. */
export type AppleCredentialSource = () => Promise<AppleCredential>;

/**
 * TODO(US-10): replace with expo-apple-authentication (AppleAuthentication.signInAsync with
 * `nonce: hashed`). Until then there is no Apple sheet, so this returns a placeholder token:
 * the mock accepts any non-empty token; the live client sends it to Supabase Auth, which refuses
 * it, and the screen says Sign in with Apple isn't set up yet.
 * US-10: expo-apple-authentication returns `authorizationCode` on the same credential
 * (string | null); pass it through unchanged and never log it.
 */
export const defaultAppleCredentialSource: AppleCredentialSource = async () => {
  const nonce = await createAppleNonce();
  return { identityToken: 'pending-us-10', rawNonce: nonce.raw, authorizationCode: 'pending-us-10' };
};
