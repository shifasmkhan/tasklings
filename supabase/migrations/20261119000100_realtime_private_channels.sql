-- TM-05: realtime on private channels only. The hosted project turns "Allow public access" off, so
-- every channel must be private, and joining a private channel needs a SELECT policy on
-- realtime.messages for the caller. The app's topic is 'capture:<capture_id>'; the only thing this
-- allows is joining the topic of a capture the caller owns.
--
-- No INSERT (or UPDATE/DELETE) policy: clients can't broadcast or write messages at all. The
-- postgres_changes events on public.captures still go through the table's own RLS, per subscriber
-- (realtime evaluates captures_select_own for each event), so the topic check is a second lock, not
-- the only one. The policy deliberately reads no column of realtime.messages, only the topic.

-- The check lives in a plain function so it is testable where the realtime schema isn't installed
-- (CI starts only Postgres and Auth). SECURITY INVOKER: it reads captures as the caller, so
-- captures_select_own applies on top of the explicit user_id test. It never raises: a malformed
-- topic is simply false, and so is a caller with no auth.uid().
create function private.can_join_capture_topic(p_topic text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    p_topic ~ '^capture:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and exists (
      select 1
      from public.captures c
      where c.user_id = (select auth.uid())
        and c.id::text = substr(p_topic, 9)
    ),
    false
  );
$$;

revoke all on function private.can_join_capture_topic(text) from public, anon, authenticated, service_role;
grant execute on function private.can_join_capture_topic(text) to authenticated;

-- realtime.messages and realtime.topic() are created by the Realtime service, not by this repo. They
-- exist in the hosted project; a local or CI database without the Realtime container doesn't have
-- them, so the policy is created only when both are there (same approach as the pg_cron jobs). If
-- this notice shows up locally after `supabase start`, run `supabase db reset` once the Realtime
-- container is up so the policy is applied.
do $do$
begin
  if to_regclass('realtime.messages') is not null and to_regprocedure('realtime.topic()') is not null then
    drop policy if exists tasklings_capture_topic_select on realtime.messages;
    create policy tasklings_capture_topic_select on realtime.messages
      for select to authenticated
      using (private.can_join_capture_topic((select realtime.topic())));
  else
    raise notice 'realtime.messages / realtime.topic() not available; private channel policy not created';
  end if;
end;
$do$;
