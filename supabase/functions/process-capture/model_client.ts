// ModelClient for the Claude Messages API over fetch (the edge runtime has no SDK).
//
// Secrets and content rules:
//   * The API key is passed in by index.ts from the ANTHROPIC_API_KEY function secret. It is
//     sent only as a request header, to a fixed https URL (redirects are refused).
//   * Errors carry a short code (timeout, status_429, ...), never the response body, the
//     prompt or the model's text. Callers must not log prompts or replies either.

import type { ModelClient, ModelRequest } from "@tasklings/extraction";

export const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_MODEL = "claude-haiku-5-5";
export const DEFAULT_TIMEOUT_MS = 20_000;
/** Upper bound on max_tokens whatever the caller asks for; extraction needs ~1k. */
export const MAX_TOKENS_CEILING = 2048;
/** The extraction reply is at most 8,000 characters; anything much bigger is not ours. */
const MAX_RESPONSE_BYTES = 256 * 1024;

export type ModelErrorCode = "timeout" | "network" | "bad_response" | `status_${number}`;

export class ModelError extends Error {
  constructor(readonly code: ModelErrorCode) {
    super(code);
    this.name = "ModelError";
  }
}

export interface ClaudeClientOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Tests only. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export function createClaudeClient(opts: ClaudeClientOptions): ModelClient {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async complete(req: ModelRequest): Promise<string> {
      const body = JSON.stringify({
        model: opts.model,
        max_tokens: Math.max(1, Math.min(Math.floor(req.maxTokens), MAX_TOKENS_CEILING)),
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      });
      let res: Response;
      try {
        res = await doFetch(MESSAGES_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new ModelError(isTimeout(err) ? "timeout" : "network");
      }
      try {
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new ModelError(`status_${res.status}`);
        }
        const text = await readLimited(res, MAX_RESPONSE_BYTES);
        return extractText(text);
      } catch (err) {
        if (err instanceof ModelError) throw err;
        throw new ModelError(isTimeout(err) ? "timeout" : "bad_response");
      }
    },
  };
}

function isTimeout(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) throw new ModelError("bad_response");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ModelError("bad_response");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/** Joins the text blocks of a Messages API reply. Anything else is a bad response. */
function extractText(raw: string): string {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ModelError("bad_response");
  }
  const content = (data as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) throw new ModelError("bad_response");
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown } | null;
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  if (parts.length === 0) throw new ModelError("bad_response");
  return parts.join("");
}
