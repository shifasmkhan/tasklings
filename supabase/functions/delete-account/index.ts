import { createClient } from "@supabase/supabase-js";
import { type AdminStore, createHandler, type RevocationResult } from "./handler.ts";
import { getUserFromAuth } from "../_shared/supabase.ts";
import { logEvent } from "../_shared/log.ts";

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
    async appleRefreshToken(userId) {
      const { data, error } = await admin.from("apple_credentials").select("apple_refresh_token")
        .eq("user_id", userId).maybeSingle();
      if (error) throw new Error(`read apple credentials failed: ${error.code}`);
      return data?.apple_refresh_token ?? null;
    },
    async deleteUser(userId) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw new Error(`delete user failed: ${error.status ?? "unknown"}`);
    },
  };
}

// Phase 0 stub: revoking needs the Apple client secret (a JWT signed with the .p8 key) and the
// token decryption key, neither of which exists yet. Until then the revocation is skipped and
// logged as not_configured. Must be implemented before App Store submission (guideline 5.1.1(v)).
function revokeApple(_ciphertext: string): Promise<RevocationResult> {
  return Promise.resolve("not_configured");
}

Deno.serve(createHandler({
  getUser: getUserFromAuth,
  admin: adminStore,
  revokeApple,
  now: () => new Date(),
  log: logEvent,
}));
