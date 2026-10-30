// Sign in with Apple revocation (TM-02, App Store guideline 5.1.1(v)).
//
// Native Sign in with Apple never gives the server a refresh token, so nothing is stored. The app
// sends the one-time `authorization_code` from the fresh sign-in; this module exchanges it for a
// token at Apple's token endpoint and revokes that token straight away.
//
// Never log or return codes, tokens, client secrets or Apple response bodies: callers get an
// outcome code only. Network, key and clock are injected so tests run without Apple.

export type RevocationOutcome =
  /** Exchanged and revoked. */
  | "revoked"
  /** Apple rejected the code (invalid_grant: expired or already used). The caller must not delete. */
  | "code_invalid"
  /** Apple secrets are not set up. */
  | "not_configured"
  /** Apple was unreachable, answered 5xx or something unexpected, or our key was refused. */
  | "revocation_failed";

export interface AppleConfig {
  teamId: string;
  keyId: string;
  /** The app's bundle id (the Sign in with Apple client id for native apps). */
  clientId: string;
  /** P-256 signing key imported from the PKCS#8 .p8 file. */
  privateKey: CryptoKey;
}

export interface AppleDeps {
  /** Null or a rejection means Apple is not (correctly) configured. */
  config: () => Promise<AppleConfig | null>;
  fetch: typeof fetch;
  now: () => Date;
  /** Per request. Default 10 s. */
  timeoutMs?: number;
}

export const APPLE_AUDIENCE = "https://appleid.apple.com";
export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
export const DEFAULT_APPLE_CLIENT_ID = "com.shifasmkhan.tasklings";
/** Client secret lifetime. Apple allows up to six months; five minutes is plenty for one exchange. */
export const CLIENT_SECRET_TTL_SECONDS = 300;
const DEFAULT_TIMEOUT_MS = 10_000;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Imports the Apple .p8 key (PEM, PKCS#8, P-256). Throws on anything else. */
export function importApplePrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(body)) throw new Error("apple key is not PEM");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/**
 * Reads the Apple settings from the environment. Returns null when any required one is missing
 * (outcome `not_configured`); throws if the key is present but unusable.
 */
export async function loadAppleConfig(
  env: (name: string) => string | undefined,
): Promise<AppleConfig | null> {
  const teamId = env("APPLE_TEAM_ID")?.trim();
  const keyId = env("APPLE_KEY_ID")?.trim();
  const pem = env("APPLE_PRIVATE_KEY");
  if (!teamId || !keyId || !pem?.trim()) return null;
  const clientId = env("APPLE_CLIENT_ID")?.trim() || DEFAULT_APPLE_CLIENT_ID;
  // Secrets set through a shell often arrive with literal "\n" instead of newlines.
  const privateKey = await importApplePrivateKey(pem.replace(/\\n/g, "\n"));
  return { teamId, keyId, clientId, privateKey };
}

/** ES256 JWT that Apple accepts as `client_secret`. */
export async function buildClientSecret(config: AppleConfig, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  const header = { alg: "ES256", kid: config.keyId, typ: "JWT" };
  const claims = {
    iss: config.teamId,
    iat,
    exp: iat + CLIENT_SECRET_TTL_SECONDS,
    aud: APPLE_AUDIENCE,
    sub: config.clientId,
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  // WebCrypto returns the raw r||s form that JWS ES256 requires.
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    config.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

async function postForm(deps: AppleDeps, url: string, params: Record<string, string>): Promise<Response> {
  return await deps.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    redirect: "error",
    signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
}

/** Reads Apple's `error` field from a 4xx answer. Nothing else from the body is kept. */
async function appleErrorCode(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const e = (body as { error: unknown }).error;
      return typeof e === "string" ? e : null;
    }
  } catch {
    // Not JSON.
  }
  return null;
}

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Nothing to release.
  }
}

/** Exchanges the authorization code and revokes the resulting token. Never throws. */
export async function revokeWithAuthorizationCode(code: string, deps: AppleDeps): Promise<RevocationOutcome> {
  try {
    const config = await deps.config();
    if (!config) return "not_configured";
    const clientSecret = await buildClientSecret(config, deps.now());
    const credentials = { client_id: config.clientId, client_secret: clientSecret };

    const exchange = await postForm(deps, APPLE_TOKEN_URL, {
      ...credentials,
      grant_type: "authorization_code",
      code,
    });
    if (exchange.status === 400) {
      return (await appleErrorCode(exchange)) === "invalid_grant" ? "code_invalid" : "revocation_failed";
    }
    if (!exchange.ok) {
      await drain(exchange);
      return "revocation_failed";
    }
    const tokens: unknown = await exchange.json();
    const t = typeof tokens === "object" && tokens !== null ? tokens as Record<string, unknown> : {};
    const refresh = typeof t.refresh_token === "string" && t.refresh_token !== "" ? t.refresh_token : null;
    const access = typeof t.access_token === "string" && t.access_token !== "" ? t.access_token : null;
    const token = refresh ?? access;
    if (!token) return "revocation_failed";

    const revoke = await postForm(deps, APPLE_REVOKE_URL, {
      ...credentials,
      token,
      token_type_hint: refresh ? "refresh_token" : "access_token",
    });
    await drain(revoke);
    return revoke.ok ? "revoked" : "revocation_failed";
  } catch {
    // Timeouts, network errors, a refused key, a malformed body: the message could hold secrets.
    return "revocation_failed";
  }
}
