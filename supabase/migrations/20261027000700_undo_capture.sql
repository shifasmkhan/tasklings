-- US-09: undo_capture(capture_id), the "Added N tasks · Undo" action (owner-approved 2026-10-27).
--
-- Deleting tasks is the first client-reachable delete on public.tasks, so it follows the same
-- pattern as the state columns: the RPC is SECURITY INVOKER and needs the table privilege, a
-- BEFORE DELETE trigger refuses every delete unless the RPC set the transaction-local flag
-- (tasklings.task_rpc), and a client cannot set that flag (PostgREST runs one statement per
-- request and does not expose set_config). A direct DELETE on /rest/v1/tasks therefore still
-- fails with protected_column. Foreign-key cascades (task_steps, task_enrichments) run as the
-- table owner, not as a client role, so they are unaffected.

create policy tasks_delete_own on public.tasks
  for delete to authenticated using (user_id = (select auth.uid()));

grant delete on public.tasks to authenticated;

create function private.tasks_guard_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon')
     and coalesce(current_setting('tasklings.task_rpc', true), '') <> 'on' then
    perform private.raise_error('protected_column', 403,
      'tasks are deleted only through undo_capture');
  end if;
  return old;
end;
$$;

create trigger tasks_guard_delete
  before delete on public.tasks
  for each row execute function private.tasks_guard_delete();

-- ---------------------------------------------------------------------------
-- undo_capture(capture_id): deletes the tasks the caller's capture created and returns how many.
-- Allowed only while all of these hold, otherwise it raises undo_expired (HTTP 409):
--   * the capture is the caller's and is `done`, and became done at most 30 seconds ago;
--   * every task of the capture is still open;
--   * none has been touched since it was inserted (updated_at still equals created_at: the
--     insert sets both from one now(), and any later UPDATE, even to the same value, moves
--     updated_at).
-- Another user's capture, and an id that does not exist, are indistinguishable from an expired
-- one (undo_expired), so there is no existence oracle. The capture row is left as it is. A second
-- call after a successful undo finds no tasks and returns 0 (a retry after a lost response is
-- harmless). The task rows are locked first, so a concurrent complete_task cannot slip in
-- between the check and the delete.
-- ---------------------------------------------------------------------------
create function public.undo_capture(capture_id uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_capture public.captures;
  v_total integer;
  v_untouched integer;
  v_removed integer;
begin
  if undo_capture.capture_id is null then
    perform private.raise_error('invalid_argument', 400, 'capture_id is required');
  end if;

  select c.* into v_capture
  from public.captures c
  where c.id = undo_capture.capture_id and c.user_id = v_uid;
  if not found
     or v_capture.status <> 'done'
     or v_capture.status_changed_at < pg_catalog.now() - interval '30 seconds' then
    perform private.raise_error('undo_expired', 409, 'This capture can no longer be undone');
  end if;

  select pg_catalog.count(*)::integer,
         (pg_catalog.count(*) filter (where s.status = 'open' and s.updated_at = s.created_at))::integer
    into v_total, v_untouched
  from (
    select t.status, t.updated_at, t.created_at
    from public.tasks t
    where t.capture_id = undo_capture.capture_id and t.user_id = v_uid
    for update
  ) s;
  if v_total <> v_untouched then
    perform private.raise_error('undo_expired', 409, 'This capture can no longer be undone');
  end if;

  perform pg_catalog.set_config('tasklings.task_rpc', 'on', true);
  delete from public.tasks t
  where t.capture_id = undo_capture.capture_id and t.user_id = v_uid;
  get diagnostics v_removed = row_count;
  perform private.end_task_rpc();
  return v_removed;
end;
$$;

revoke all on function public.undo_capture(uuid) from public, anon;
grant execute on function public.undo_capture(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: the app learns that a capture finished from its own captures row (status), as well as
-- from the new tasks. Realtime postgres_changes apply the subscriber's RLS select policy, so a
-- user receives only their own rows. The row includes the user's own transcript (RLS-limited).
-- ---------------------------------------------------------------------------
do $do$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_catalog.pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'captures') then
    alter publication supabase_realtime add table public.captures;
  end if;
end;
$do$;
