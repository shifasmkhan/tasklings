-- CONTRACT CHANGE (needs owner approval; flagged at the top of the PR).
-- Two columns the PRD data model does not define yet:
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
-- Neither column is writable by clients.

alter table public.profiles add column last_rollover_on date;
alter table public.tasks add column undo_planned_for date;

grant select (last_rollover_on) on public.profiles to authenticated;
-- tasks has a table-level select grant, which covers the new column.
