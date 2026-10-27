-- US-03: real extraction in process-capture.
--
-- 1. tasks.needs_review becomes insertable by the app's normal role (approved by the owner).
--    The insert trigger that forced it to false is removed. Edits still clear it
--    (tasks_clear_needs_review is unchanged), and there is still no UPDATE grant on the column.
-- 2. Cost and abuse controls (security review S-05): a daily usage counter per user in the
--    private schema, a limits table next to it (both without client grants), and one SECURITY
--    DEFINER function that reserves a unit for the caller. Internal, not a client contract.
-- 3. A sweeper for captures stuck in `parsing` (see below).

grant insert (needs_review) on public.tasks to authenticated;

drop trigger tasks_force_needs_review_false on public.tasks;
drop function private.tasks_force_needs_review_false();

-- ---------------------------------------------------------------------------
-- Daily extraction usage. One row per user per UTC day. Counts extraction runs (a run makes at
-- most two model requests: the call and one retry).
-- ---------------------------------------------------------------------------
create table private.extraction_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  calls integer not null check (calls > 0),
  primary key (user_id, day)
);
create index extraction_usage_day_idx on private.extraction_usage (day);

alter table private.extraction_usage enable row level security;  -- no policies: deny by default
revoke all on private.extraction_usage from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Limits: one row, no client grants. Changed only by the owner, with SQL, for example
--   update private.extraction_limits set user_daily_cap = 80, global_daily_cap = 800;
-- Defaults: 50 runs per user and 500 runs across all users, per UTC day.
-- ---------------------------------------------------------------------------
create table private.extraction_limits (
  singleton boolean primary key default true check (singleton),
  user_daily_cap integer not null check (user_daily_cap between 1 and 100000),
  global_daily_cap integer not null check (global_daily_cap between 1 and 1000000)
);
insert into private.extraction_limits (user_daily_cap, global_daily_cap) values (50, 500);

alter table private.extraction_limits enable row level security;  -- no policies: deny by default
revoke all on private.extraction_limits from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- public.reserve_extraction: the only way an edge function (running as the caller) can touch the
-- counters. It takes no arguments: the limits come from private.extraction_limits, so a client
-- that calls it directly can use up only its own units, never more than the stored per-user limit.
--
-- Why SECURITY DEFINER: the tables must have no client grants, and the service-role key is not
-- allowed in process-capture. This is the narrowest option that satisfies both rules.
--   * auth.uid() must be set; the function writes only that user's row for today (UTC).
--   * It reads other users' rows only as a sum for today, for the global cap. It returns
--     nothing but a verdict.
--   * search_path is pinned to '' and every name is qualified.
--   * Execute is granted to authenticated only.
-- Verdicts: 'ok' (one unit reserved), 'user_cap' or 'global_cap' (nothing reserved; the caller
-- must not call the model).
--
-- The global check is a sum read, then the upsert: two concurrent calls can overshoot the cap by
-- a few units. That is acceptable for a spend breaker.
-- ---------------------------------------------------------------------------
create function public.reserve_extraction()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_day date := (now() at time zone 'utc')::date;
  v_user_cap integer;
  v_global_cap integer;
  v_total bigint;
  v_mine integer;
begin
  select l.user_daily_cap, l.global_daily_cap into v_user_cap, v_global_cap
    from private.extraction_limits l;
  if not found then
    -- Missing config fails closed.
    return 'global_cap';
  end if;

  select coalesce(sum(u.calls), 0) into v_total
    from private.extraction_usage u
   where u.day = v_day;
  if v_total >= v_global_cap then
    return 'global_cap';
  end if;

  insert into private.extraction_usage as u (user_id, day, calls)
  values (v_uid, v_day, 1)
  on conflict (user_id, day) do update set calls = u.calls + 1
    where u.calls < v_user_cap
  returning u.calls into v_mine;
  if v_mine is null then
    return 'user_cap';
  end if;
  return 'ok';
end;
$$;

revoke all on function public.reserve_extraction() from public, anon, authenticated;
grant execute on function public.reserve_extraction() to authenticated;

-- ---------------------------------------------------------------------------
-- Stuck captures. status_changed_at records when a capture last changed status, set by the
-- database (a BEFORE trigger, so no privilege is needed and clients can't write it: it has no
-- insert or update grant). private.fail_stuck_captures marks captures that have been `parsing`
-- for more than 5 minutes as `failed` with error `extraction_timeout`, so the app can retry them
-- (a retry with the same capture_id re-runs the pipeline). Runs from pg_cron as the owner.
-- ---------------------------------------------------------------------------
alter table public.captures add column status_changed_at timestamptz not null default now();

create function private.captures_touch_status_changed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    new.status_changed_at := now();
  else
    new.status_changed_at := old.status_changed_at;
  end if;
  return new;
end;
$$;

create trigger captures_touch_status_changed_at
  before insert or update on public.captures
  for each row execute function private.captures_touch_status_changed_at();

create function private.fail_stuck_captures(p_now timestamptz default now())
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_failed integer;
begin
  update public.captures c
     set status = 'failed', error = 'extraction_timeout'
   where c.status = 'parsing'
     and c.status_changed_at < p_now - interval '5 minutes';
  get diagnostics v_failed = row_count;
  return v_failed;
end;
$$;

revoke all on function private.fail_stuck_captures(timestamptz) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Housekeeping: counters older than 7 days are not needed. Runs from pg_cron as the owner.
-- ---------------------------------------------------------------------------
create function private.purge_extraction_usage(p_now timestamptz default now())
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from private.extraction_usage
   where day < (p_now at time zone 'utc')::date - 7;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function private.purge_extraction_usage(timestamptz) from public, anon, authenticated, service_role;

do $do$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('tasklings-purge-extraction-usage', '17 3 * * *',
                          'select private.purge_extraction_usage()');
    perform cron.schedule('tasklings-fail-stuck-captures', '*/5 * * * *',
                          'select private.fail_stuck_captures()');
  else
    raise notice 'pg_cron not available; extraction usage is not purged and stuck captures are not failed';
  end if;
end;
$do$;
