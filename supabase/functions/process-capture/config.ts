// Runtime settings for process-capture, read from function secrets (supabase secrets set ...).
// The daily spend limits are not here: they live in the database (private.extraction_limits).
// Nothing here is logged except the names of variables that were ignored.

import { DEFAULT_MODEL, DEFAULT_TIMEOUT_MS } from "./model_client.ts";

export interface CaptureConfig {
  /** Absent when ANTHROPIC_API_KEY is not set: every capture then falls back (nothing is lost). */
  apiKey: string | null;
  model: string;
  timeoutMs: number;
  /** Names of settings that were present but invalid and replaced by their defaults. */
  ignored: string[];
}

const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function intInRange(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined || raw === "") return null;
  if (!/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

export function loadConfig(getEnv: (name: string) => string | undefined): CaptureConfig {
  const ignored: string[] = [];
  const pick = (name: string, min: number, max: number, dflt: number): number => {
    const raw = getEnv(name);
    const v = intInRange(raw, min, max);
    if (v === null) {
      if (raw !== undefined && raw !== "") ignored.push(name);
      return dflt;
    }
    return v;
  };
  const key = getEnv("ANTHROPIC_API_KEY");
  const modelRaw = getEnv("EXTRACTION_MODEL");
  let model = DEFAULT_MODEL;
  if (modelRaw !== undefined && modelRaw !== "") {
    if (MODEL_RE.test(modelRaw)) model = modelRaw;
    else ignored.push("EXTRACTION_MODEL");
  }
  return {
    apiKey: key && key.trim() !== "" ? key.trim() : null,
    model,
    timeoutMs: pick("EXTRACTION_TIMEOUT_MS", 1_000, 60_000, DEFAULT_TIMEOUT_MS),
    ignored,
  };
}
