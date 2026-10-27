-- US-03: real extraction in process-capture.
--
-- 1. tasks.needs_review becomes insertable by the app's normal role (approved by the owner).
--    The insert trigger that forced it to false is removed. Edits still clear it
--    (tasks_clear_needs_review is unchanged), and there is still no UPDATE grant on the column.
-- 2. Cost and abuse controls (security review S-05): a daily usage counter per user in the
--    private schema, which clients cannot read or write, and one SECURITY DEFINER function
--    that reserves a unit for the caller. This is internal, not a client contract.

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
-- public.reserve_extraction: the only way an edge function (running as the caller) can touch the
-- counters.
--
-- Why SECURITY DEFINER: the table must have no client grants, and the service-role key is not
-- allowed in process-capture. This is the narrowest option that satisfies both rules.
--   * auth.uid() must be set; the function writes only that user's row for today (UTC).
--   * It reads other users' rows only as a sum for today, for the global cap. It returns
--     nothing but a verdict.
--   * search_path is pinned to '' and every name is qualified.
--   * Execute is granted to authenticated only.
-- Verdicts: 'ok' (one unit reserved), 'user_cap' or 'global_cap' (nothing reserved; the caller
-- must not call the model).
--
-- The limits are arguments so the owner can tune them with function secrets. They are clamped
-- by hard ceilings here, because any signed-in client can call this function directly: such a
-- call can only use up the caller's own units, at most p_user_limit (<= 200) a day.
-- The global check is a sum read, then the upsert: two concurrent calls can overshoot the cap by
-- a few units. That is acceptable for a spend breaker.
-- ---------------------------------------------------------------------------
create function public.reserve_extraction(p_user_limit integer, p_global_limit integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_day date := (now() at time zone 'utc')::date;
  v_total bigint;
  v_mine integer;
begin
  if p_user_limit is null or p_user_limit not between 1 and 200
     or p_global_limit is null or p_global_limit not between 1 and 100000 then
    perform private.raise_error('invalid_argument', 400, 'Limit out of range');
  end if;

  select coalesce(sum(u.calls), 0) into v_total
    from private.extraction_usage u
   where u.day = v_day;
  if v_total >= p_global_limit then
    return 'global_cap';
  end if;

  insert into private.extraction_usage as u (user_id, day, calls)
  values (v_uid, v_day, 1)
  on conflict (user_id, day) do update set calls = u.calls + 1
    where u.calls < p_user_limit
  returning u.calls into v_mine;
  if v_mine is null then
    return 'user_cap';
  end if;
  return 'ok';
end;
$$;

revoke all on function public.reserve_extraction(integer, integer) from public, anon, authenticated;
grant execute on function public.reserve_extraction(integer, integer) to authenticated;

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
  else
    raise notice 'pg_cron not available; extraction usage is not purged';
  end if;
end;
$do$;
