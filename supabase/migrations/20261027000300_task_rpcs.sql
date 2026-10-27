-- US-05 / US-08: Today and task-state RPCs, plus the rules that keep task state honest.
--
-- All RPCs are SECURITY INVOKER with search_path pinned to '' (every name is qualified), so RLS
-- and column privileges apply exactly as for a direct table call. A row owned by another user is
-- invisible, so it surfaces as task_not_found: no cross-user existence oracle.
--
-- Errors: raised with SQLSTATE PTxxx (PostgREST maps it to HTTP status xxx) and the stable code in
-- both MESSAGE and HINT. Clients map PostgREST's {code, message, details, hint} to the standard
-- {"error": {"code": hint, "message": details}}. Code list: supabase/README.md.

-- ---------------------------------------------------------------------------
-- Error helper
-- ---------------------------------------------------------------------------
create function private.raise_error(p_code text, p_http int, p_detail text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = 'PT' || p_http::text,
    message = p_code,
    hint = p_code,
    detail = p_detail;
end;
$$;

create function private.require_uid()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    perform private.raise_error('unauthenticated', 401, 'A signed-in user is required');
  end if;
  return v_uid;
end;
$$;

-- ---------------------------------------------------------------------------
-- The user's "today": the local date in the profile time zone, never earlier than the last
-- rollover date (so a move west never hides tasks already rolled to a later local date).
-- Runs as the caller: under RLS a user can only resolve their own profile.
-- ---------------------------------------------------------------------------
create function private.user_today(p_user_id uuid, p_at timestamptz default now())
returns date
language sql
stable
set search_path = ''
as $$
  select greatest((p_at at time zone p.timezone)::date, coalesce(p.last_rollover_on, '-infinity'::date))
  from public.profiles p
  where p.user_id = p_user_id;
$$;

-- ---------------------------------------------------------------------------
-- Insert defaults for tasks: planned for the user's today; effort_min_initial is the estimate
-- at creation and cannot be supplied by a client (it is not an insertable column either).
-- ---------------------------------------------------------------------------
create function private.tasks_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.effort_min_initial := new.effort_min;
    new.planned_for := private.user_today(new.user_id);
    new.first_planned_for := new.planned_for;
    new.carry_count := 0;
    new.status := 'open';
    new.undo_planned_for := null;
  else
    new.effort_min_initial := coalesce(new.effort_min_initial, new.effort_min);
    new.planned_for := coalesce(new.planned_for, private.user_today(new.user_id));
    new.first_planned_for := coalesce(new.first_planned_for, new.planned_for);
  end if;
  -- Another user's id resolves to no profile under RLS; leave that row to the RLS check
  -- (42501) instead of reporting on someone else's profile.
  if new.planned_for is null
     and (current_user not in ('authenticated', 'anon') or new.user_id = auth.uid()) then
    perform private.raise_error('profile_not_found', 404, 'No profile for this user');
  end if;
  return new;
end;
$$;

create trigger tasks_before_insert
  before insert on public.tasks
  for each row execute function private.tasks_before_insert();

-- ---------------------------------------------------------------------------
-- Protected columns. Clients may edit only title, kind, effort_min, due_date and notes
-- (the "Task edits" contract). status, planned_for, completed_at, dropped_reason and
-- undo_planned_for change only inside the task RPCs. effort_min_initial, carry_count, user_id,
-- capture_id, first_planned_for, script, sort_order and timestamps are not updatable by
-- authenticated at all (no column grant).
--
-- Because the RPCs are SECURITY INVOKER they run as authenticated and need UPDATE on the state
-- columns, so the grant alone cannot keep clients out. The RPCs set a transaction-local flag;
-- this trigger rejects state changes by authenticated without it. A client cannot set the flag:
-- PostgREST runs one statement per request, sets only request.* settings, and does not expose
-- set_config (pg_catalog is not an exposed schema).
-- ---------------------------------------------------------------------------
create function private.tasks_guard_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon')
     and coalesce(current_setting('tasklings.task_rpc', true), '') <> 'on'
     and (new.status is distinct from old.status
          or new.planned_for is distinct from old.planned_for
          or new.completed_at is distinct from old.completed_at
          or new.dropped_reason is distinct from old.dropped_reason
          or new.undo_planned_for is distinct from old.undo_planned_for) then
    perform private.raise_error('protected_column', 403,
      'status, planned_for, completed_at and dropped_reason change only through the task RPCs');
  end if;
  return new;
end;
$$;

create trigger tasks_guard_state
  before update on public.tasks
  for each row execute function private.tasks_guard_state();

grant update (title, kind, effort_min, due_date, notes,
              status, planned_for, completed_at, dropped_reason, undo_planned_for)
  on public.tasks to authenticated;

-- ---------------------------------------------------------------------------
-- Internal: lock the caller's task, or raise task_not_found.
-- ---------------------------------------------------------------------------
create function private.lock_own_task(p_id uuid)
returns public.tasks
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_task public.tasks;
begin
  if p_id is null then
    perform private.raise_error('invalid_argument', 400, 'id is required');
  end if;
  select t.* into v_task
  from public.tasks t
  where t.id = p_id and t.user_id = v_uid
  for update;
  if not found then
    perform private.raise_error('task_not_found', 404, 'No such task');
  end if;
  perform pg_catalog.set_config('tasklings.task_rpc', 'on', true);
  return v_task;
end;
$$;

create function private.end_task_rpc()
returns void
language sql
set search_path = ''
as $$
  select pg_catalog.set_config('tasklings.task_rpc', 'off', true);
$$;

-- ---------------------------------------------------------------------------
-- today_tasks(): open tasks planned for the user's today or earlier, as a flat list ordered by
-- kind (quick, errand, project) then sort_order. Clients group by kind.
-- ---------------------------------------------------------------------------
create function public.today_tasks()
returns setof public.tasks
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_today date := private.user_today(v_uid);
begin
  return query
    select t.*
    from public.tasks t
    where t.user_id = v_uid
      and t.status = 'open'
      and t.planned_for <= v_today
    order by t.kind, t.sort_order, t.created_at, t.id;
end;
$$;

-- complete_task(id): open -> done.
create function public.complete_task(id uuid)
returns public.tasks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_task public.tasks := private.lock_own_task(complete_task.id);
begin
  if v_task.status <> 'open' then
    perform private.raise_error('invalid_state', 409, 'Only an open task can be completed');
  end if;
  update public.tasks t
     set status = 'done', completed_at = pg_catalog.now()
   where t.id = v_task.id
  returning t.* into v_task;
  perform private.end_task_rpc();
  return v_task;
end;
$$;

-- undo_task(id): reverses the last state change.
--   done -> open; dropped -> open; open after a defer -> planned_for restored.
create function public.undo_task(id uuid)
returns public.tasks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_task public.tasks := private.lock_own_task(undo_task.id);
begin
  if v_task.status = 'done' then
    update public.tasks t set status = 'open', completed_at = null
     where t.id = v_task.id returning t.* into v_task;
  elsif v_task.status = 'dropped' then
    update public.tasks t set status = 'open', dropped_reason = null
     where t.id = v_task.id returning t.* into v_task;
  elsif v_task.undo_planned_for is not null then
    update public.tasks t set planned_for = t.undo_planned_for, undo_planned_for = null
     where t.id = v_task.id returning t.* into v_task;
  else
    perform private.raise_error('nothing_to_undo', 409, 'This task has no change to undo');
  end if;
  perform private.end_task_rpc();
  return v_task;
end;
$$;

-- defer_task(id): planned_for = the user's tomorrow (profile time zone).
create function public.defer_task(id uuid)
returns public.tasks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_task public.tasks := private.lock_own_task(defer_task.id);
begin
  if v_task.status <> 'open' then
    perform private.raise_error('invalid_state', 409, 'Only an open task can be deferred');
  end if;
  update public.tasks t
     set undo_planned_for = t.planned_for,
         planned_for = private.user_today(t.user_id) + 1
   where t.id = v_task.id
  returning t.* into v_task;
  perform private.end_task_rpc();
  return v_task;
end;
$$;

-- drop_task(id, reason): open -> dropped. reason is optional; when given it must be one of
-- not_needed, done_elsewhere, obsolete. Typed as text so a bad value gets the standard error.
create function public.drop_task(id uuid, reason text default null)
returns public.tasks
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_task public.tasks := private.lock_own_task(drop_task.id);
  v_reason public.dropped_reason;
begin
  if drop_task.reason is not null then
    if drop_task.reason not in ('not_needed', 'done_elsewhere', 'obsolete') then
      perform private.raise_error('invalid_argument', 400,
        'reason must be not_needed, done_elsewhere or obsolete');
    end if;
    v_reason := drop_task.reason::public.dropped_reason;
  end if;
  if v_task.status <> 'open' then
    perform private.raise_error('invalid_state', 409, 'Only an open task can be dropped');
  end if;
  update public.tasks t
     set status = 'dropped', dropped_reason = v_reason
   where t.id = v_task.id
  returning t.* into v_task;
  perform private.end_task_rpc();
  return v_task;
end;
$$;

-- ---------------------------------------------------------------------------
-- Execute privileges: authenticated only. Supabase's defaults would also grant anon.
-- ---------------------------------------------------------------------------
revoke all on function public.today_tasks() from public, anon;
revoke all on function public.complete_task(uuid) from public, anon;
revoke all on function public.undo_task(uuid) from public, anon;
revoke all on function public.defer_task(uuid) from public, anon;
revoke all on function public.drop_task(uuid, text) from public, anon;
grant execute on function public.today_tasks() to authenticated;
grant execute on function public.complete_task(uuid) to authenticated;
grant execute on function public.undo_task(uuid) to authenticated;
grant execute on function public.defer_task(uuid) to authenticated;
grant execute on function public.drop_task(uuid, text) to authenticated;

grant execute on function
  private.raise_error(text, int, text),
  private.require_uid(),
  private.user_today(uuid, timestamptz),
  private.lock_own_task(uuid),
  private.end_task_rpc()
  to authenticated;
