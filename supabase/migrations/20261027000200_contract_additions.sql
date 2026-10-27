-- CONTRACT CHANGE (owner approved 2026-10-27; the PRD data model still needs updating).
-- Three columns the PRD data model does not define yet:
--
-- profiles.last_rollover_on (US-08): the user's local date of the last nightly rollover.
--   Rollover runs only when the local date in the profile's time zone is later than this value,
--   so carry_count goes up once per local day, and a time-zone change can neither skip a day
--   (east: the new local date is later, so it rolls) nor count one twice (west: the local date
--   is earlier than or equal to the last rollover, so it waits). "Today" for a user is never
--   earlier than this date, so tasks already rolled to a day stay on Today after a move west.
--
-- tasks.undo_planned_for (US-05): the planned_for value before the last defer_task, so
--   undo_task after a defer restores it. Cleared by undo and by the next rollover.
--
-- tasks.needs_review (US-03): true when extraction fell back to saving the transcript as one task
--   for the user to check. Set only by the server's fallback path (it is not insertable or
--   updatable by clients), and cleared automatically when the user edits title, kind, effort_min,
--   due_date or notes.
--
-- None of the three is writable by clients.

alter table public.profiles add column last_rollover_on date;
alter table public.tasks add column undo_planned_for date;

grant select (last_rollover_on) on public.profiles to authenticated;
-- tasks has a table-level select grant, which covers the new column.

alter table public.tasks add column needs_review boolean not null default false;
-- No insert or update grant: clients can neither set nor clear it directly. Table-level select
-- covers it. The tasks insert trigger also forces it to false for client roles, as a second layer.

-- Clear needs_review when the user edits any of the user-editable content columns. Runs for every
-- role, so a server-side edit of those columns clears it too. Setting it to true is only possible
-- for roles with the column privilege (service_role); changing only needs_review keeps it.
create function private.tasks_clear_needs_review()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.needs_review
     and (new.title is distinct from old.title
          or new.kind is distinct from old.kind
          or new.effort_min is distinct from old.effort_min
          or new.due_date is distinct from old.due_date
          or new.notes is distinct from old.notes) then
    new.needs_review := false;
  end if;
  return new;
end;
$$;

create trigger tasks_clear_needs_review
  before update on public.tasks
  for each row execute function private.tasks_clear_needs_review();

create function private.tasks_force_needs_review_false()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.needs_review := false;
  end if;
  return new;
end;
$$;

create trigger tasks_force_needs_review_false
  before insert on public.tasks
  for each row execute function private.tasks_force_needs_review_false();
