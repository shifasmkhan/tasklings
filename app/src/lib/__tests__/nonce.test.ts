import { createAppleNonce, hashNonce, NONCE_BYTES } from '../nonce';

// Node's crypto, typed locally so the app doesn't need @types/node.
const { createHash: mockCreateHash, randomBytes: mockRandomBytes } = jest.requireActual<{
  createHash: (alg: string) => { update: (d: string, enc: string) => { digest: (enc: string) => string } };
  randomBytes: (n: number) => Uint8Array;
}>('node:crypto');

// expo-crypto's native module isn't available under Jest. This double backs it with Node's
// crypto so the helper's own logic (hex encoding, hashing the right value) is what's tested.
const mockGetRandomBytes = jest.fn((n: number) => new Uint8Array(mockRandomBytes(n)));
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { HEX: 'hex' },
  getRandomBytes: (n: number) => mockGetRandomBytes(n),
  digestStringAsync: async (alg: string, data: string, opts: { encoding: string }) => {
    expect(alg).toBe('SHA-256');
    expect(opts.encoding).toBe('hex');
    return mockCreateHash('sha256').update(data, 'utf8').digest('hex');
  },
}));

describe('Sign in with Apple nonce', () => {
  it('hashes to the known SHA-256 hex of the input', async () => {
    expect(await hashNonce('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('draws NONCE_BYTES from the secure random source and hex-encodes them', async () => {
    mockGetRandomBytes.mockReturnValueOnce(new Uint8Array([0, 1, 15, 16, 255, ...new Array(NONCE_BYTES - 5).fill(171)]));
    const { raw } = await createAppleNonce();
    expect(mockGetRandomBytes).toHaveBeenLastCalledWith(NONCE_BYTES);
    expect(raw).toHaveLength(NONCE_BYTES * 2);
    expect(raw.startsWith('00010f10ff')).toBe(true);
    expect(raw).toMatch(/^[0-9a-f]+$/);
  });

  it('returns the SHA-256 hex of the raw nonce, not the raw nonce itself', async () => {
    const { raw, hashed } = await createAppleNonce();
    expect(hashed).toBe(mockCreateHash('sha256').update(raw, 'utf8').digest('hex'));
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed).not.toBe(raw);
  });

  it('gives a different nonce each time', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add((await createAppleNonce()).raw);
    expect(seen.size).toBe(50);
  });

  it('does not use Math.random', async () => {
    const spy = jest.spyOn(Math, 'random');
    await createAppleNonce();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
