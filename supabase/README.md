# supabase/

Postgres migrations, row-level security, RPCs, edge functions and scheduled jobs. Owned by the Backend workstream.

Rules from the security review: edge functions query Postgres with the caller's JWT; the service-role key is used only by scheduled jobs and delete-account; RPCs are SECURITY INVOKER.

## Layout

| Path | What |
|---|---|
| `config.toml` | Local/CI Supabase config. Only `public` is exposed through the API. |
| `migrations/` | Schema (`0100`), contract additions awaiting approval (`0200`), task RPCs (`0300`), rollover job (`0400`), realtime (`0500`). |
| `tests/database/` | pgTAP: RLS and privileges, every RPC as the owner and as another user, rollover with time-zone changes. |
| `functions/` | Deno edge functions: `process-capture`, `register-device`, `export-data`, `delete-account`, shared code in `_shared/`, tests in `tests/`. |
| `seed.sql` | Synthetic local data (two `example.test` users). |
| `package.json` | Pins the Supabase CLI and Deno; `package-lock.json` holds the integrity hashes. |

## Run it

```sh
cd supabase
npm ci
npx supabase start          # needs Docker
npx supabase test db        # pgTAP
npm run test:functions      # deno fmt, lint, check, test (no Docker needed)
```

CI runs both on every PR with no secrets (`.github/workflows/ci.yml`).

## Privilege model

- RLS is on for every table. `authenticated` has per-user policies keyed on `auth.uid()`; `anon` has no privileges anywhere.
- Supabase's default "grant all" is revoked and access is granted back per column.
- **Task edits**: clients may update only `title, kind, effort_min, due_date, notes`. `status, planned_for, completed_at, dropped_reason` change only inside the task RPCs: the RPCs run as the caller (SECURITY INVOKER), so they need the column grant, and a trigger rejects those columns unless the RPC set a transaction-local flag. A client can't set the flag: PostgREST runs one statement per request and doesn't expose `set_config`. `effort_min_initial, carry_count, user_id, capture_id, first_planned_for` have no client update grant at all. On insert the database sets `planned_for` (the user's today), `first_planned_for` and `effort_min_initial` (= `effort_min`).
- **`apple_refresh_token`** is stored in `public.apple_credentials`, a table only the service role can read (no grants for clients, and RLS with no policies). We chose a separate table over column privileges on `profiles` so no future grant, view, `select *` or realtime publication on `profiles` can expose it. It holds ciphertext; the key lives outside the database. Only `delete-account` reads it.
- Child rows use composite foreign keys `(parent_id, user_id)`, so a user can't attach a row to another user's capture or task. Foreign-key checks bypass RLS, so this closes the gap.
- The only SECURITY DEFINER function is the `auth.users` insert trigger that creates the profile. It pins `search_path` and touches only the new row. A test fails if any other function is SECURITY DEFINER.

## "Today" and rollover (US-08)

- A user's today is the local date in `profiles.timezone`. It is never earlier than `profiles.last_rollover_on`, so after a move west the tasks already rolled forward stay on Today.
- `private.rollover_tasks()` runs every 15 minutes (pg_cron). For each user whose local date is later than `last_rollover_on`, it moves open tasks with `planned_for` < today to today, adds 1 to `carry_count`, clears pending defer-undo state and records the date. It never deletes. Running it again on the same local day changes nothing.
- When the time zone changes: moving east starts the new local day straight away, so no day is skipped. Moving west gives an earlier or equal local date, which never rolls, so no day is counted twice. A missed run (an outage, or a jump of more than 24 hours across the date line) counts once: `carry_count` counts rollovers survived, not calendar days.

## RPCs

All are `POST /rest/v1/rpc/<name>` with the user JWT.

| RPC | Args | Returns |
|---|---|---|
| `today_tasks` | none | **Flat array** of open tasks with `planned_for` <= today, ordered by kind (quick, errand, project), then `sort_order`. Clients group by kind. |
| `complete_task` | `{id}` | Updated task. Only from `open`. |
| `undo_task` | `{id}` | Updated task. done → open, dropped → open, or, after a defer, restores the previous `planned_for`. |
| `defer_task` | `{id}` | Task with `planned_for` = tomorrow in the profile time zone. Only from `open`. |
| `drop_task` | `{id, reason?}` | Updated task. `reason` is `not_needed`, `done_elsewhere`, `obsolete` or null. Only from `open`. |

## Error codes

Edge functions always return `{"error": {"code": "...", "message": "..."}}`.

RPCs and table writes go through PostgREST, which returns `{"code", "message", "details", "hint"}`. Our errors are raised with SQLSTATE `PTxxx`, so the HTTP status is `xxx`, and the stable code is in **`hint`** (also in `message`). Clients map PostgREST errors to the standard shape: `{"error": {"code": hint, "message": details}}`. A PostgREST error with no hint is a platform error (for example `42501` permission denied, or `23505` duplicate). Map it to `forbidden` (HTTP 401/403) or `internal_error`.

| Code | HTTP | Where | Meaning |
|---|---|---|---|
| `unauthenticated` | 401 | all | Missing, invalid or expired user JWT. |
| `invalid_request` | 400 | edge fns | Body fails validation (wrong type, unknown field, bad UUID, time zone or timestamp, or a non-empty body where none is allowed). |
| `invalid_argument` | 400 | RPCs, profiles | Bad RPC argument (null id, unknown drop reason) or a profile time zone that is not IANA. |
| `method_not_allowed` | 405 | edge fns | Not POST. |
| `unsupported_media_type` | 415 | edge fns | Body is not `application/json`. |
| `payload_too_large` | 413 | edge fns | Body over 64 KiB. |
| `reauth_required` | 403 | export-data, delete-account | The Apple sign-in is over 5 minutes old. Sign in again. |
| `protected_column` | 403 | task update | Tried to change status, planned_for, completed_at or dropped_reason directly. Use the RPCs. |
| `task_not_found` | 404 | task RPCs | No such task **for this user**. Another user's task looks the same. |
| `profile_not_found` | 404 | task insert | The caller has no profile. |
| `invalid_state` | 409 | task RPCs | The transition isn't allowed (for example, completing a done task). |
| `nothing_to_undo` | 409 | undo_task | An open task with no defer to undo. |
| `capture_conflict` | 409 | process-capture | The capture_id belongs to another capture. A retry of your own capture returns 202. |
| `internal_error` | 500 | edge fns | Unexpected failure. No details are returned or logged. |

## Session freshness (export-data, delete-account)

Freshness is measured from the `amr` claim (`[{method, timestamp}]`): the latest entry with method `oauth` or `id_token` (Sign in with Apple) must be at most 300 seconds old. `iat` is not used because it changes on every token refresh. Missing, stale or non-Apple `amr` entries fail closed with `reauth_required`. Tokens are first checked with Supabase Auth (`getUser`), and the claims are decoded only after that check passes.

## Edge function stubs (Phase 0)

- `process-capture` validates `{capture_id, transcript, captured_at, timezone}` and creates the capture (`source = voice`) with the caller's JWT. It then inserts two canned synthetic tasks and returns `202 {capture_id}`. It makes no model call. A retry with the same capture_id is idempotent. `captured_at` and `timezone` are kept for the real pipeline, which needs them to resolve relative dates in the transcript.
- `register-device` takes `{apns_token}` as 64–200 hex characters, upserts it on `(user_id, apns_token)` and returns 204.
- `export-data` takes no body and needs a fresh session. It returns a JSON attachment of the caller's rows, read under RLS.
- `delete-account` takes no body and needs a fresh session. It verifies the caller with their JWT, then uses the service role for that user id only: it reads the Apple token, revokes it, and deletes the auth user, which cascades to every table. Apple revocation is a stub for now: it returns `not_configured`.
- Logs carry IDs and counts only.
