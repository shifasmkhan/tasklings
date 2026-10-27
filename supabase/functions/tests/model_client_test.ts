import { strict as assert } from "node:assert";
import {
  ANTHROPIC_VERSION,
  createClaudeClient,
  MESSAGES_URL,
  ModelError,
} from "../process-capture/model_client.ts";
import { loadConfig } from "../process-capture/config.ts";

const FAKE_KEY = "test-key-not-real";
const REQ = { system: "SYSTEM-TEXT", user: "USER-TEXT", maxTokens: 1024 };

function reply(body: unknown, status = 200): typeof fetch {
  return () =>
    Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof ModelError, "only ModelError escapes the client");
    return err.code;
  }
  throw new Error("expected a ModelError");
}

Deno.test("model client: sends the Messages API request and returns the text", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const client = createClaudeClient({
    apiKey: FAKE_KEY,
    model: "claude-haiku-5-5",
    fetch: (url, init) => {
      seen = { url: String(url), init: init! };
      return Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: "text", text: '{"tasks":' }, { type: "text", text: "[]}" }] }),
        ),
      );
    },
  });
  assert.equal(await client.complete(REQ), '{"tasks":[]}');
  assert.equal(seen!.url, MESSAGES_URL);
  const headers = seen!.init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], FAKE_KEY);
  assert.equal(headers["anthropic-version"], ANTHROPIC_VERSION);
  assert.equal(seen!.init.redirect, "error");
  assert.ok(seen!.init.signal instanceof AbortSignal, "every call has a timeout");
  const body = JSON.parse(seen!.init.body as string);
  assert.deepEqual(body, {
    model: "claude-haiku-5-5",
    max_tokens: 1024,
    system: "SYSTEM-TEXT",
    messages: [{ role: "user", content: "USER-TEXT" }],
  });
});

Deno.test("model client: max_tokens is capped whatever the caller asks", async () => {
  let sent = 0;
  const client = createClaudeClient({
    apiKey: FAKE_KEY,
    model: "m",
    fetch: (_u, init) => {
      sent = JSON.parse(init!.body as string).max_tokens;
      return Promise.resolve(new Response(JSON.stringify({ content: [{ type: "text", text: "x" }] })));
    },
  });
  await client.complete({ ...REQ, maxTokens: 100_000 });
  assert.equal(sent, 2048);
});

Deno.test("model client: a hung request times out", async () => {
  const client = createClaudeClient({
    apiKey: FAKE_KEY,
    model: "m",
    timeoutMs: 20,
    fetch: (_u, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
      }),
  });
  assert.equal(await code(client.complete(REQ)), "timeout");
});

Deno.test("model client: HTTP errors surface as a status code only, never the body", async () => {
  const secretBody = { error: { message: `echo ${REQ.user} ${REQ.system} ${FAKE_KEY}` } };
  for (const status of [400, 401, 429, 500, 529]) {
    const client = createClaudeClient({ apiKey: FAKE_KEY, model: "m", fetch: reply(secretBody, status) });
    try {
      await client.complete(REQ);
      throw new Error("expected failure");
    } catch (err) {
      assert.ok(err instanceof ModelError);
      assert.equal(err.code, `status_${status}`);
      assert.ok(!String(err.message + err.stack).includes("USER-TEXT"));
      assert.ok(!String(err.message + err.stack).includes(FAKE_KEY));
    }
  }
});

Deno.test("model client: network failures and malformed replies are coded errors", async () => {
  const net = createClaudeClient({
    apiKey: FAKE_KEY,
    model: "m",
    fetch: () => Promise.reject(new TypeError("dns failure for host")),
  });
  assert.equal(await code(net.complete(REQ)), "network");
  for (
    const body of [
      "not json",
      "{}",
      { content: [] },
      { content: [{ type: "tool_use" }] },
      { content: "x" },
      "null",
    ]
  ) {
    const c = createClaudeClient({ apiKey: FAKE_KEY, model: "m", fetch: reply(body) });
    assert.equal(await code(c.complete(REQ)), "bad_response");
  }
});

Deno.test("model client: an oversized reply is refused", async () => {
  const big = JSON.stringify({ content: [{ type: "text", text: "a".repeat(300 * 1024) }] });
  const c = createClaudeClient({ apiKey: FAKE_KEY, model: "m", fetch: reply(big) });
  assert.equal(await code(c.complete(REQ)), "bad_response");
});

Deno.test("config: cap variables no longer exist (limits live in the database)", () => {
  const c = loadConfig((n) => (n === "EXTRACTION_USER_DAILY_CAP" ? "5" : undefined));
  assert.ok(!("userDailyCap" in c) && !("globalDailyCap" in c));
  assert.deepEqual(c.ignored, []);
});

Deno.test("config: defaults, overrides and ignored values", () => {
  const env = (m: Record<string, string>) => (n: string) => m[n];
  const d = loadConfig(env({}));
  assert.deepEqual(
    { apiKey: d.apiKey, model: d.model, ignored: d.ignored },
    { apiKey: null, model: "claude-haiku-5-5", ignored: [] },
  );
  const c = loadConfig(env({
    ANTHROPIC_API_KEY: " k ",
    EXTRACTION_MODEL: "claude-sonnet-5-5",
    EXTRACTION_TIMEOUT_MS: "15000",
  }));
  assert.deepEqual(
    { apiKey: c.apiKey, model: c.model, t: c.timeoutMs },
    { apiKey: "k", model: "claude-sonnet-5-5", t: 15000 },
  );
  const bad = loadConfig(env({
    ANTHROPIC_API_KEY: "  ",
    EXTRACTION_MODEL: "Bad Model!",
    EXTRACTION_TIMEOUT_MS: "abc",
  }));
  assert.equal(bad.apiKey, null);
  assert.equal(bad.model, "claude-haiku-5-5");
  assert.deepEqual(bad.ignored.sort(), [
    "EXTRACTION_MODEL",
    "EXTRACTION_TIMEOUT_MS",
  ]);
  assert.ok(!JSON.stringify(bad).includes("Bad Model"), "ignored lists names, not values");
});
