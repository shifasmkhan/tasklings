import { createHandler } from "./handler.ts";
import { supabaseCaptureStore } from "./store.ts";
import { getUserFromAuth } from "../_shared/supabase.ts";
import { logEvent } from "../_shared/log.ts";

Deno.serve(createHandler({
  getUser: getUserFromAuth,
  store: supabaseCaptureStore,
  now: () => new Date(),
  log: logEvent,
}));
