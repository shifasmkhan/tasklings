// Where the Sign in with Apple identity token comes from. The native sheet needs
// expo-apple-authentication and the paid Apple membership (US-10), so for now only a mock source
// exists. The mock backend accepts its token; a live backend rejects it with `unauthenticated`.

export interface AppleCredentialSource {
  /** `hashedNonce` is the SHA-256 hex of the raw nonce (lib/nonce.ts); it goes to Apple. Resolves to the identity token. */
  getIdentityToken(hashedNonce: string): Promise<string>;
}

export function createMockAppleCredentialSource(): AppleCredentialSource {
  return {
    async getIdentityToken() {
      return 'mock-identity-token';
    },
  };
}
