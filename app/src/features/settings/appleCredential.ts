import { createAppleNonce } from '@/lib/nonce';

/** What signInWithApple needs: Apple's identity token and the raw nonce whose hash Apple signed. */
export interface AppleCredential {
  identityToken: string;
  rawNonce: string;
}

/** Shows Apple's sign-in sheet and returns its credential. Rejects with ApiError `canceled` if dismissed. */
export type AppleCredentialSource = () => Promise<AppleCredential>;

/**
 * TODO(US-10): replace with expo-apple-authentication (AppleAuthentication.signInAsync with
 * `nonce: hashed`). Until then there is no Apple sheet, so this returns a placeholder token:
 * the mock accepts any non-empty token; the live client sends it to Supabase Auth, which refuses
 * it, and the screen says Sign in with Apple isn't set up yet.
 */
export const defaultAppleCredentialSource: AppleCredentialSource = async () => {
  const nonce = await createAppleNonce();
  return { identityToken: 'pending-us-10', rawNonce: nonce.raw };
};
