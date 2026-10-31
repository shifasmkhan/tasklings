import { createClient } from "@supabase/supabase-js";
import { type AdminStore, createHandler } from "./handler.ts";
import { getUserFromAuth } from "../_shared/supabase.ts";
import { logEvent } from "../_shared/log.ts";
import { type AppleConfig, loadAppleConfig, revokeWithAuthorizationCode } from "../_shared/apple.ts";

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

// Service-role client: delete-account only. Every call below is scoped to the verified caller id.
function adminStore(): AdminStore {
  const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    async deleteUser(userId) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw new Error(`delete user failed: ${error.status ?? "unknown"}`);
    },
  };
}

// The imported key is cached for the life of the worker; the secrets are read when it starts.
let appleConfig: Promise<AppleConfig | null> | undefined;
const config = () =>
  appleConfig ??= loadAppleConfig((n) => Deno.env.get(n)).catch((err) => {
    appleConfig = undefined;
    throw err;
  });

Deno.serve(createHandler({
  getUser: getUserFromAuth,
  admin: adminStore,
  revokeApple: (code) => revokeWithAuthorizationCode(code, { config, fetch, now: () => new Date() }),
  now: () => new Date(),
  log: logEvent,
}));
