// Sign in with Apple revocation (TM-02): client secret, request shapes, every outcome. No network.
import { strict as assert } from "node:assert";
import {
  APPLE_AUDIENCE,
  APPLE_REVOKE_URL,
  APPLE_TOKEN_URL,
  type AppleConfig,
  buildClientSecret,
  CLIENT_SECRET_TTL_SECONDS,
  DEFAULT_APPLE_CLIENT_ID,
  importApplePrivateKey,
  loadAppleConfig,
  revokeWithAuthorizationCode,
} from "../_shared/apple.ts";
import { NOW, NOW_S } from "./helpers.ts";

const CODE = "c0de.synthetic-authorization_code";
const SYNTHETIC_REFRESH = "r-synthetic-refresh-token";
const SYNTHETIC_ACCESS = "a-synthetic-access-token";

const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);

// Built from parts so the secret scanner doesn't mistake a test fixture for a leaked key.
const PEM_BEGIN = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
const PEM_END = ["-----END", "PRIVATE", "KEY-----"].join(" ");

async function pemOf(key: CryptoKey): Promise<string> {
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key));
  const b64 = btoa(String.fromCharCode(...der));
  return `${PEM_BEGIN}\n${b64.match(/.{1,64}/g)!.join("\n")}\n${PEM_END}\n`;
}

const config: AppleConfig = {
  teamId: "TEAM123456",
  keyId: "KEY1234567",
  clientId: "com.example.synthetic",
  privateKey: keyPair.privateKey,
};

function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

const decodePart = (s: string) => JSON.parse(new TextDecoder().decode(unb64url(s)));

interface Recorded {
  url: string;
  method: string;
  contentType: string | null;
  form: URLSearchParams;
  hasSignal: boolean;
  redirect: string | undefined;
}

type Reply = Response | Error;

function fakeFetch(replies: Reply[]) {
  const seen: Recorded[] = [];
  const f = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      contentType: headers.get("content-type"),
      form: new URLSearchParams(String(init?.body)),
      hasSignal: init?.signal instanceof AbortSignal,
      redirect: init?.redirect,
    });
    const r = replies.shift();
    if (!r) return Promise.reject(new Error("unexpected request"));
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }) as typeof fetch;
  return { f, seen };
}

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function run(replies: Reply[], cfg: AppleConfig | null = config) {
  const { f, seen } = fakeFetch(replies);
  const outcome = revokeWithAuthorizationCode(CODE, {
    config: () => Promise.resolve(cfg),
    fetch: f,
    now: () => NOW,
  });
  return { outcome, seen };
}

Deno.test("client secret: ES256 JWT with Apple's claims, verifies with the public key, lives at most 5 minutes", async () => {
  const jwt = await buildClientSecret(config, NOW);
  const [h, c, s] = jwt.split(".");
  assert.deepEqual(decodePart(h), { alg: "ES256", kid: "KEY1234567", typ: "JWT" });
  const claims = decodePart(c);
  assert.deepEqual(claims, {
    iss: "TEAM123456",
    iat: NOW_S,
    exp: NOW_S + CLIENT_SECRET_TTL_SECONDS,
    aud: APPLE_AUDIENCE,
    sub: "com.example.synthetic",
  });
  assert.ok(claims.exp - claims.iat <= 300);
  assert.equal(APPLE_AUDIENCE, "https://appleid.apple.com");
  const sig = unb64url(s);
  assert.equal(sig.length, 64, "raw r||s, not DER");
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.publicKey,
    sig,
    new TextEncoder().encode(`${h}.${c}`),
  );
  assert.ok(ok);
  const tampered = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.publicKey,
    sig,
    new TextEncoder().encode(`${h}.${c}x`),
  );
  assert.ok(!tampered);
});

Deno.test("importApplePrivateKey: reads a PKCS#8 PEM and signs; rejects junk", async () => {
  const key = await importApplePrivateKey(await pemOf(keyPair.privateKey));
  const jwt = await buildClientSecret({ ...config, privateKey: key }, NOW);
  const [h, c, s] = jwt.split(".");
  assert.ok(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.publicKey,
      unb64url(s),
      new TextEncoder().encode(`${h}.${c}`),
    ),
  );
  await assert.rejects(importApplePrivateKey("not a key"));
  await assert.rejects(importApplePrivateKey(`${PEM_BEGIN}\nAAAA\n${PEM_END}`));
});

Deno.test("loadAppleConfig: null unless team, key id and key are all set; client id defaults to the bundle id", async () => {
  const pem = await pemOf(keyPair.privateKey);
  const env = (m: Record<string, string>) => (n: string) => m[n];
  assert.equal(await loadAppleConfig(env({})), null);
  assert.equal(await loadAppleConfig(env({ APPLE_TEAM_ID: "T", APPLE_KEY_ID: "K" })), null);
  assert.equal(await loadAppleConfig(env({ APPLE_TEAM_ID: "T", APPLE_PRIVATE_KEY: pem })), null);
  const c = await loadAppleConfig(env({ APPLE_TEAM_ID: "T", APPLE_KEY_ID: "K", APPLE_PRIVATE_KEY: pem }));
  assert.equal(c?.clientId, DEFAULT_APPLE_CLIENT_ID);
  assert.equal(DEFAULT_APPLE_CLIENT_ID, "com.shifasmkhan.tasklings");
  const custom = await loadAppleConfig(
    env({
      APPLE_TEAM_ID: "T",
      APPLE_KEY_ID: "K",
      APPLE_CLIENT_ID: "com.x.y",
      APPLE_PRIVATE_KEY: pem.replace(/\n/g, "\\n"),
    }),
  );
  assert.equal(custom?.clientId, "com.x.y");
  await assert.rejects(
    loadAppleConfig(env({ APPLE_TEAM_ID: "T", APPLE_KEY_ID: "K", APPLE_PRIVATE_KEY: "junk" })),
  );
});

Deno.test("revoke: exchanges the code, then revokes the refresh token", async () => {
  const { outcome, seen } = run([
    jsonRes(200, { refresh_token: SYNTHETIC_REFRESH, access_token: SYNTHETIC_ACCESS }),
    new Response("{}", { status: 200 }),
  ]);
  assert.equal(await outcome, "revoked");
  assert.equal(seen.length, 2);
  const [exchange, revoke] = seen;
  assert.equal(exchange.url, APPLE_TOKEN_URL);
  assert.equal(exchange.method, "POST");
  assert.equal(exchange.contentType, "application/x-www-form-urlencoded");
  assert.equal(exchange.form.get("grant_type"), "authorization_code");
  assert.equal(exchange.form.get("code"), CODE);
  assert.equal(exchange.form.get("client_id"), "com.example.synthetic");
  const secret = exchange.form.get("client_secret")!;
  assert.equal(secret.split(".").length, 3);
  assert.equal([...exchange.form.keys()].sort().join(), "client_id,client_secret,code,grant_type");
  assert.equal(revoke.url, APPLE_REVOKE_URL);
  assert.equal(revoke.form.get("token"), SYNTHETIC_REFRESH);
  assert.equal(revoke.form.get("token_type_hint"), "refresh_token");
  assert.equal(revoke.form.get("client_id"), "com.example.synthetic");
  assert.equal(revoke.form.get("client_secret"), secret);
  assert.equal([...revoke.form.keys()].sort().join(), "client_id,client_secret,token,token_type_hint");
  for (const r of seen) {
    assert.ok(r.hasSignal, "every request has a timeout");
    assert.equal(r.redirect, "error");
  }
});

Deno.test("revoke: falls back to the access token when Apple sends no refresh token", async () => {
  const { outcome, seen } = run([
    jsonRes(200, { access_token: SYNTHETIC_ACCESS }),
    new Response(null, { status: 200 }),
  ]);
  assert.equal(await outcome, "revoked");
  assert.equal(seen[1].form.get("token"), SYNTHETIC_ACCESS);
  assert.equal(seen[1].form.get("token_type_hint"), "access_token");
});

Deno.test("revoke: no token in Apple's answer is revocation_failed and nothing is revoked", async () => {
  for (const body of [{}, { refresh_token: "", access_token: "" }, { refresh_token: 5 }, []]) {
    const { outcome, seen } = run([jsonRes(200, body)]);
    assert.equal(await outcome, "revocation_failed");
    assert.equal(seen.length, 1);
  }
  const { outcome } = run([new Response("not json", { status: 200 })]);
  assert.equal(await outcome, "revocation_failed");
});

Deno.test("revoke: invalid_grant (expired or used code) is code_invalid and revoke is never called", async () => {
  const { outcome, seen } = run([
    jsonRes(400, { error: "invalid_grant", error_description: "secret detail" }),
  ]);
  assert.equal(await outcome, "code_invalid");
  assert.equal(seen.length, 1);
});

Deno.test("revoke: other 400s (our client secret is wrong), 5xx, network errors and timeouts are revocation_failed", async () => {
  const cases: Reply[] = [
    jsonRes(400, { error: "invalid_client" }),
    jsonRes(400, { error: "invalid_request" }),
    new Response("bad", { status: 400 }),
    jsonRes(401, { error: "invalid_client" }),
    jsonRes(500, {}),
    jsonRes(503, {}),
    new TypeError("network down"),
    new DOMException("timed out", "TimeoutError"),
    new DOMException("aborted", "AbortError"),
  ];
  for (const reply of cases) {
    const { outcome, seen } = run([reply]);
    assert.equal(await outcome, "revocation_failed");
    assert.equal(seen.length, 1);
  }
});

Deno.test("revoke: a failing revoke call is revocation_failed", async () => {
  for (
    const second of [
      jsonRes(400, { error: "invalid_grant" }),
      jsonRes(500, {}),
      new TypeError("down"),
    ] as Reply[]
  ) {
    const { outcome } = run([jsonRes(200, { refresh_token: SYNTHETIC_REFRESH }), second]);
    assert.equal(await outcome, "revocation_failed");
  }
});

Deno.test("revoke: not configured makes no request", async () => {
  const { outcome, seen } = run([], null);
  assert.equal(await outcome, "not_configured");
  assert.equal(seen.length, 0);
});

Deno.test("revoke: an unusable key (config throws) is revocation_failed, never an exception", async () => {
  const { f, seen } = fakeFetch([]);
  const outcome = await revokeWithAuthorizationCode(CODE, {
    config: () => Promise.reject(new Error("secret key material in message")),
    fetch: f,
    now: () => NOW,
  });
  assert.equal(outcome, "revocation_failed");
  assert.equal(seen.length, 0);
});

Deno.test("revoke: nothing is written to the console, whatever happens", async () => {
  const lines: string[] = [];
  const orig = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) {
    console[k] = (...a: unknown[]) => void lines.push(a.join(" "));
  }
  try {
    await run([jsonRes(200, { refresh_token: SYNTHETIC_REFRESH }), new Response("{}", { status: 200 })])
      .outcome;
    await run([jsonRes(400, { error: "invalid_grant" })]).outcome;
    await run([new TypeError(`leak ${CODE}`)]).outcome;
    await run([jsonRes(500, { error: SYNTHETIC_REFRESH })]).outcome;
  } finally {
    Object.assign(console, orig);
  }
  assert.deepEqual(lines, []);
});
