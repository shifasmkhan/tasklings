import { createHandler, type DeviceStore } from "./handler.ts";
import { getUserFromAuth, userClient } from "../_shared/supabase.ts";
import { logEvent } from "../_shared/log.ts";

function supabaseDeviceStore(token: string): DeviceStore {
  const db = userClient(token);
  return {
    async upsertDevice(apnsToken, seenAt) {
      // user_id comes from the column default auth.uid(); RLS checks it.
      const { error } = await db.from("device_tokens").upsert(
        { apns_token: apnsToken, last_seen_at: seenAt.toISOString() },
        { onConflict: "user_id,apns_token" },
      );
      if (error) throw new Error(`upsert device failed: ${error.code}`);
    },
  };
}

Deno.serve(createHandler({
  getUser: getUserFromAuth,
  store: supabaseDeviceStore,
  now: () => new Date(),
  log: logEvent,
}));
