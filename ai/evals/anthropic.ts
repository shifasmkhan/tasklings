// Live model access for the eval harness, via the official Anthropic SDK.
// The key comes only from the ANTHROPIC_API_KEY environment variable.

import Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, ModelRequest } from "../src/extraction/extract.ts";

/** Current small/fast model; override with --model or EVAL_MODEL. */
export const DEFAULT_MODEL = "claude-haiku-5-5";
/** Grader model; override with --grader-model or EVAL_GRADER_MODEL. */
export const DEFAULT_GRADER_MODEL = "claude-sonnet-5-5";

export function anthropicFromEnv(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey, maxRetries: 3, timeout: 60_000 });
}

export function anthropicClient(sdk: Anthropic, model: string): ModelClient {
  return {
    async complete(req: ModelRequest): Promise<string> {
      const msg = await sdk.messages.create({
        model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      });
      let text = "";
      for (const block of msg.content) if (block.type === "text") text += block.text;
      return text;
    },
  };
}
