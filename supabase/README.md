# supabase/

Postgres migrations, row-level security policies, RPCs, edge functions and scheduled jobs. Owned by the Backend workstream.

Rules from the security review: edge functions query Postgres with the caller's JWT; the service-role key is used only by scheduled jobs and delete-account; RPCs are SECURITY INVOKER.

First deliverable: a stub for every Phase 0 contract so the app is never blocked.
