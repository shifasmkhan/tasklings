-- US-08: nightly rollover, per user time zone.
--
-- For each user whose local date (profile time zone) is later than last_rollover_on:
--   * open tasks with planned_for < local today move to local today and carry_count + 1;
--   * pending defer-undo state is cleared (undo after a day has passed would be surprising);
--   * last_rollover_on = local today.
-- Nothing is ever deleted. The guard on last_rollover_on makes the job idempotent: it can run
-- every 15 minutes (so each user rolls within 15 minutes of local midnight), twice concurrently,
-- or after an outage, and still counts each local day at most once. A missed day (outage, or a
-- time-zone jump of more than 24 hours) is counted once, not per calendar day: carry_count means
-- "rollovers survived".
--
-- Runs as the table owner from pg_cron, so it is not subject to RLS and is not callable by
-- clients. p_now exists so tests can drive the clock.

create function private.rollover_tasks(p_now timestamptz default now())
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_users integer;
begin
  with due as (
    update public.profiles p
       set last_rollover_on = (p_now at time zone p.timezone)::date
     where p.last_rollover_on is null
        or p.last_rollover_on < (p_now at time zone p.timezone)::date
    returning p.user_id, p.last_rollover_on as local_today
  ), moved as (
    update public.tasks t
       set planned_for = case when t.status = 'open' and t.planned_for < d.local_today
                              then d.local_today else t.planned_for end,
           carry_count = t.carry_count + case when t.status = 'open' and t.planned_for < d.local_today
                                              then 1 else 0 end,
           undo_planned_for = null
      from due d
     where t.user_id = d.user_id
       and ((t.status = 'open' and t.planned_for < d.local_today) or t.undo_planned_for is not null)
    returning t.id
  )
  select count(*) into v_users from due;
  return v_users;
end;
$$;

revoke all on function private.rollover_tasks(timestamptz) from public, anon, authenticated, service_role;

-- Schedule with pg_cron where available (hosted Supabase and the local Supabase image).
do $do$
begin
  if exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('tasklings-rollover', '*/15 * * * *', 'select private.rollover_tasks()');
  else
    raise notice 'pg_cron not available; rollover is not scheduled';
  end if;
end;
$do$;
