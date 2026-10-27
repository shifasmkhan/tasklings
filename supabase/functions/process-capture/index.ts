import { createHandler } from "./handler.ts";
import { supabaseCaptureStore } from "./store.ts";
import { loadConfig } from "./config.ts";
import { createClaudeClient } from "./model_client.ts";
import { getUserFromAuth } from "../_shared/supabase.ts";
import { logEvent } from "../_shared/log.ts";

const config = loadConfig((name) => Deno.env.get(name));
for (const name of config.ignored) logEvent("config_invalid_ignored", { fn: "process-capture", name });
if (config.apiKey === null) logEvent("config_missing", { fn: "process-capture", name: "ANTHROPIC_API_KEY" });

// EdgeRuntime.waitUntil lets the pipeline finish after the 202 is sent. Without it the handler
// finishes the work before answering.
const edge = (globalThis as { EdgeRuntime?: { waitUntil?: (work: Promise<unknown>) => void } }).EdgeRuntime;
const waitUntil = typeof edge?.waitUntil === "function"
  ? (work: Promise<unknown>) => edge.waitUntil!(work)
  : undefined;

Deno.serve(createHandler({
  getUser: getUserFromAuth,
  store: supabaseCaptureStore,
  now: () => new Date(),
  log: logEvent,
  model: config.apiKey === null
    ? null
    : createClaudeClient({ apiKey: config.apiKey, model: config.model, timeoutMs: config.timeoutMs }),
  waitUntil,
}));
