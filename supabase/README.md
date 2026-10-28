# supabase/

Postgres migrations, row-level security, RPCs, edge functions and scheduled jobs. Owned by the Backend workstream.

Rules from the security review: edge functions query Postgres with the caller's JWT; the service-role key is used only by scheduled jobs and delete-account; RPCs are SECURITY INVOKER.

## Layout

| Path | What |
|---|---|
| `config.toml` | Local/CI Supabase config. Only `public` is exposed through the API. |
| `migrations/` | Schema (`0100`), contract additions approved 2026-10-27 (`0200`: `last_rollover_on`, `undo_planned_for`, `needs_review`), task RPCs (`0300`), rollover job (`0400`), realtime (`0500`), process-capture support (`0600`: `needs_review` insert grant, extraction limits and counters, stuck-capture sweeper), `undo_capture` and the guarded task delete (`0700`). |
| `tests/database/` | pgTAP: RLS and privileges, every RPC as the owner and as another user, rollover with time-zone changes, `needs_review`, `undo_capture`. |
| `functions/` | Deno edge functions: `process-capture`, `register-device`, `export-data`, `delete-account`, shared code in `_shared/`, tests in `tests/`. `process-capture` imports the extraction module from `ai/src/extraction` (see below). |
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
- **Task deletes** (`0700`): `authenticated` holds `DELETE` on `tasks` (plus an own-rows RLS policy) only so that `undo_capture` can run as the caller. A `BEFORE DELETE` row trigger rejects every delete unless the RPC set the same transaction-local flag as the task RPCs (`tasklings.task_rpc`), so a direct `DELETE /rest/v1/tasks` fails with `protected_column` (403), also in a transaction that earlier called an RPC (the flag is switched off again). Foreign-key cascades (deleting a user, `task_steps`) run as the table owner and are unaffected. Tests: `06_undo_capture.test.sql`.
- **`apple_refresh_token`** is stored in `public.apple_credentials`, a table only the service role can read (no grants for clients, and RLS with no policies). We chose a separate table over column privileges on `profiles` so no future grant, view, `select *` or realtime publication on `profiles` can expose it. It holds ciphertext; the key lives outside the database. Only `delete-account` reads it.
- **`needs_review`** (`tasks.needs_review boolean not null default false`) marks the single task process-capture saves when extraction fell back to the fixed review task. The owner approved this grant: the app's normal role may set it **on insert only** (`grant insert (needs_review)`); there is no update grant. The insert trigger that used to force it to false is gone, so a flagged insert is kept. A trigger clears it to false whenever title, kind, effort_min, due_date or notes change (any role), so the first edit confirms the task. Changing nothing, or using the task RPCs (defer, complete, drop, undo), leaves it alone. A client can flag its own task; that has no effect beyond the flag. Tests: `04_needs_review.test.sql`.
- **Extraction limits and counters** (`private.extraction_limits`, one row; `private.extraction_usage(user_id, day, calls)`, one row per user per UTC day). Clients and `service_role` have no grants on either, and RLS is on with no policies. Internal, not a client contract. See "Cost and abuse controls".
- **`captures.status_changed_at`** is set by a trigger whenever the status changes. It is readable (table-level select) but has no insert or update grant. The stuck-capture sweeper uses it.
- Child rows use composite foreign keys `(parent_id, user_id)`, so a user can't attach a row to another user's capture or task. Foreign-key checks bypass RLS, so this closes the gap.
- Exactly two SECURITY DEFINER functions exist, and a test fails if any other appears:
  - `private.handle_new_user`, the `auth.users` insert trigger that creates the profile. It pins `search_path` and touches only the new row.
  - `public.reserve_extraction()` (below). It takes no arguments, requires `auth.uid()`, pins `search_path`, writes only the caller's counter row and returns only a verdict. Execute is granted to `authenticated` only.

## undo_capture (US-09)

`POST /rest/v1/rpc/undo_capture {capture_id}` deletes the tasks the caller's capture created and returns how many it removed. SECURITY INVOKER, `search_path` pinned. It succeeds only if **all** of these hold, otherwise it raises `undo_expired` (HTTP 409):

- the capture is the caller's and `done`, and became `done` at most 30 seconds ago (`captures.status_changed_at`);
- every one of its tasks is still `open`;
- none of them has been touched since insert (`updated_at = created_at`; any later update, even to the same value, or a complete/defer/drop followed by an undo, moves `updated_at`).

Another user's capture, an unknown id and a capture that is not `done` all raise the same `undo_expired`, so there is no existence oracle. The capture row is left as it is. The task rows are locked before the checks, so a concurrent `complete_task` can't slip in. A repeat call after a successful undo finds no tasks and returns 0. A null `capture_id` is `invalid_argument`. The delete runs under the task-RPC flag; see "Task deletes" above. Known limit: realtime does not apply row-level security to DELETE events, so a signed-in user subscribed to `tasks` could see the primary key (a random UUID, no other column) of a task deleted by someone else's undo. Nothing else leaks; the app does not subscribe to `tasks`.

`captures` is also in the `supabase_realtime` publication now (`0700`), so the app can see its own capture reach `done`; realtime applies the subscriber's RLS select policy, so a user receives only their own rows.

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
| `undo_capture` | `{capture_id}` | Integer: how many tasks were removed. See "undo_capture" below. |
| `drop_task` | `{id, reason?}` | Updated task. `reason` is `not_needed`, `done_elsewhere`, `obsolete` or null. Only from `open`. |

## Error codes

Edge functions always return `{"error": {"code": "...", "message": "..."}}`.

RPCs and table writes go through PostgREST, which returns `{"code", "message", "details", "hint"}`. Our errors are raised with SQLSTATE `PTxxx`, so the HTTP status is `xxx`, and the stable code is in **`hint`** (also in `message`). Clients map PostgREST errors to the standard shape: `{"error": {"code": hint, "message": details}}`. A PostgREST error with no hint is a platform error (for example `42501` permission denied, or `23505` duplicate). Map it to `forbidden` (HTTP 401/403) or `internal_error`.

| Code | HTTP | Where | Meaning |
|---|---|---|---|
| `unauthenticated` | 401 | all | Missing, invalid or expired user JWT. |
| `invalid_request` | 400 | edge fns | Body fails validation (wrong type, unknown field, bad UUID, time zone or timestamp, a transcript over 20,000 characters, or a non-empty body where none is allowed). |
| `invalid_argument` | 400 | RPCs, profiles | Bad RPC argument (null id, unknown drop reason, a `reserve_extraction` limit out of range) or a profile time zone that is not IANA. |
| `method_not_allowed` | 405 | edge fns | Not POST. |
| `unsupported_media_type` | 415 | edge fns | Body is not `application/json`. |
| `payload_too_large` | 413 | edge fns | Body over 64 KiB (process-capture: 128 KiB). |
| `reauth_required` | 403 | export-data, delete-account | The Apple sign-in is over 5 minutes old. Sign in again. |
| `protected_column` | 403 | task update | Tried to change status, planned_for, completed_at or dropped_reason directly. Use the RPCs. |
| `task_not_found` | 404 | task RPCs | No such task **for this user**. Another user's task looks the same. |
| `profile_not_found` | 404 | task insert | The caller has no profile. |
| `invalid_state` | 409 | task RPCs | The transition isn't allowed (for example, completing a done task). |
| `nothing_to_undo` | 409 | undo_task | An open task with no defer to undo. |
| `undo_expired` | 409 | undo_capture | The capture can't be undone (any reason below), including another user's or an unknown capture. |
| `capture_conflict` | 409 | process-capture | The capture_id belongs to another capture. A retry of your own capture returns 202. |
| `internal_error` | 500 | edge fns | Unexpected failure. No details are returned or logged. |

## Session freshness (export-data, delete-account)

Freshness is measured from the `amr` claim (`[{method, timestamp}]`): the latest entry with method `oauth` or `id_token` (Sign in with Apple) must be at most 300 seconds old. `iat` is not used because it changes on every token refresh. Missing, stale or non-Apple `amr` entries fail closed with `reauth_required`. Tokens are first checked with Supabase Auth (`getUser`), and the claims are decoded only after that check passes.

## process-capture (US-03)

`POST {capture_id, transcript, captured_at, timezone, source?}` returns `202 {capture_id}`; tasks arrive by realtime. `source` is optional and must be exactly `voice`, `text`, `siri` or `widget` (default `voice`); it is stored in `captures.source`. Any other value (wrong case, `null`, a number, an unknown word) is `400 invalid_request` before any database or model work. A retry of an existing capture keeps the source it was created with. A transcript must be 1 to 20,000 characters (the 2-minute note cap); anything longer is `400 invalid_request` before any database or model work.

Flow, all with the caller's JWT:

1. Validate, then insert the capture with `status = parsing`. A retry of your own `capture_id` returns 202 and does nothing more, with one exception: if that capture is `failed`, it goes back to `parsing` (atomically, so of two concurrent retries only one wins) and the pipeline re-runs with the new transcript, reserving a unit again. If the failed capture already has tasks (only the status update was lost), it is just marked `done`. Someone else's id is `409 capture_conflict`.
2. Answer 202. The pipeline then runs in the background through `EdgeRuntime.waitUntil` when the runtime has it. If it does not (an older local runtime), the handler finishes the pipeline before answering, and the answer is still 202.
3. Pipeline (`ai/src/extraction`: model, strict validation, one retry, fallback):
   - **ok**: insert the tasks (`needs_review = false`) and set the capture `done`. An empty list inserts nothing and is also `done`.
   - **fallback** (two invalid or failed attempts, including model timeouts): insert the one fixed task "Review this voice note" with `needs_review = true`, capture `done`.
   - **cap tripped, counters unreadable, or no API key**: same as fallback, with no model call, so nothing is lost.
   - **unexpected failure**: capture `failed` with `captures.error` set to `extraction_failed` or `tasks_insert_failed`. Raw model text is never stored.

Nothing about transcripts, prompts, model output or task titles is logged: logs hold IDs, status and reason codes, validator codes and counts. A capture whose worker dies mid-run stays `parsing` until the sweeper (below) fails it.

### Importing the extraction module

`functions/deno.json` maps `@tasklings/extraction` to `../../ai/src/extraction/mod.ts`; the function imports that bare name. With the pinned CLI (2.121.0) `supabase functions deploy` collects every file in that import graph, because the source root is the repository root (the nearest folder with `.git`), which contains `ai/`. Both bundlers follow it: the API bundler (`--use-api`) uploads `ai/src/extraction/*.ts` next to the function files, and the Docker bundler mounts them read-only. Keep the module dependency-free and inside the repo. `npm run test:functions` also runs `deno bundle` over the function as a check that the graph resolves. Side effect: Deno finds `ai/package.json` and records it in `deno.lock` under `links` (this includes `@anthropic-ai/sdk`, which the function never imports and Deno does not download).

### Model client

`process-capture/model_client.ts` calls the Claude Messages API over `fetch` (`https://api.anthropic.com/v1/messages`, `anthropic-version: 2023-06-01`, redirects refused), with a timeout (default 20 s per request, so at most about 40 s with the one retry) and `max_tokens` 1024 (never above 2048). Errors carry only a code: `timeout`, `network`, `bad_response`, `status_<http status>`.

### Cost and abuse controls (security review S-05)

- **Per user**: at most `user_daily_cap` extraction runs per UTC day (default 50).
- **Global**: at most `global_daily_cap` runs per UTC day across all users (default 500). When the sum reaches it, the breaker is open: new captures save as one `needs_review` task with no model call, until the next UTC day. A user at their own cap gets the same behavior.
- A run is one capture's extraction. The call and its one retry count as one unit, so the worst-case request count is twice the cap. A retry of a failed capture is a new run and reserves a unit.
- The limits live in `private.extraction_limits` (one row, seeded with 50 and 500, no client grants). The owner changes them with SQL, as a database admin (SQL editor or `psql` with the database password; no migration needed):

  ```sql
  update private.extraction_limits set user_daily_cap = 80, global_daily_cap = 800;
  select user_daily_cap, global_daily_cap from private.extraction_limits;
  ```

  They take effect on the next capture. A missing row makes the function refuse (fail closed). They are not function secrets, so a client call can never raise them.
- Counters live in `private.extraction_usage` and are changed only through `public.reserve_extraction()`, which returns `ok`, `user_cap` or `global_cap`. Why SECURITY DEFINER: the tables must have no client grants, and the service-role key is not allowed in this function; this is the narrowest option that meets both rules. It needs `auth.uid()`, pins `search_path`, increments only the caller's row for today, and reads other rows only as one sum. It takes no arguments, so a signed-in user who calls it directly can use up only their own units, never more than the stored per-user limit. Concurrent calls can overshoot a cap by a few units.
- `private.purge_extraction_usage()` deletes counters older than 7 days (pg_cron, daily).
- Not built yet: the PRD's alert at 50% of the monthly budget. It comes with monitoring.
- Tests: `05_extraction_usage.test.sql`, `functions/tests/process_capture_test.ts`.

### Stuck captures

`private.fail_stuck_captures()` runs every 5 minutes from pg_cron. It marks captures that have been `parsing` for more than 5 minutes (`status_changed_at`) as `failed` with `error = 'extraction_timeout'`, so the app can retry them with the same `capture_id`. `captures.error` codes written by this function: `extraction_failed`, `tasks_insert_failed`, `extraction_timeout`.

## Secrets and settings the owner must set

The daily caps are not secrets; see "Cost and abuse controls". Function secrets are set per project and are never in the repo. The API key belongs only in `supabase secrets set`; do not put it in `config.toml`, `.env` files that are committed, or the app.

```sh
cd supabase
npx supabase secrets set ANTHROPIC_API_KEY=<your key> --project-ref <ref>      # required
# Optional (defaults shown):
npx supabase secrets set EXTRACTION_MODEL=claude-haiku-5-5 --project-ref <ref>
npx supabase secrets set EXTRACTION_TIMEOUT_MS=20000 --project-ref <ref>
npx supabase secrets list --project-ref <ref>                                    # names only
```

| Secret | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Without it every capture saves as one `needs_review` task and a `config_missing` event is logged. |
| `EXTRACTION_MODEL` | `claude-haiku-5-5` | Lowercase letters, digits, `.`, `_`, `-`. Anything else is ignored. |
| `EXTRACTION_TIMEOUT_MS` | 20000 | Integer 1,000 to 60,000, per model request. |

A value that is present but invalid is ignored in favor of the default, and a `config_invalid_ignored` event names the variable (never the value). Secrets are read when a worker starts, so redeploy or wait for workers to recycle after changing them. For local `supabase functions serve`, put them in `supabase/functions/.env` (git-ignored; do not commit).

## Other edge functions (Phase 0)

- `register-device` takes `{apns_token}` as 64–200 hex characters, upserts it on `(user_id, apns_token)` and returns 204.
- `export-data` takes no body and needs a fresh session. It returns a JSON attachment of the caller's rows, read under RLS.
- `delete-account` takes no body and needs a fresh session. It verifies the caller with their JWT, then uses the service role for that user id only: it reads the Apple token, revokes it, and deletes the auth user, which cascades to every table. Apple revocation is a stub for now: it returns `not_configured`.
- Logs carry IDs and counts only.
