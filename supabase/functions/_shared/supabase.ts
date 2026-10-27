// RLS-bound Supabase clients. Every query made with userClient runs as the caller, so Postgres
// row-level security and column privileges apply. The service-role client lives only in
// delete-account/ and must never be added here (enforced by a test in tests/).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { GetUser } from "./auth.ts";

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export function userClient(token: string): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/** Asks Supabase Auth who owns the token (rejects revoked sessions and deleted users). */
export const getUserFromAuth: GetUser = async (token) => {
  const { data, error } = await userClient(token).auth.getUser(token);
  if (error || !data.user) return null;
  return { id: data.user.id };
};
