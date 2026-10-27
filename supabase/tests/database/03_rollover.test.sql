-- US-08: nightly rollover per user time zone, driven with a fixed clock (p_now).
-- Covers: once per local day, idempotent reruns, never deletes, per-user zones, and time-zone
-- changes east (no skipped day) and west (no double count; rolled tasks stay on Today).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-4000-a000-00000000000a', 'user-a@example.test'),
  ('00000000-0000-4000-a000-00000000000b', 'user-b@example.test');
update public.profiles set timezone = 'America/Chicago' where user_id = '00000000-0000-4000-a000-00000000000a';
update public.profiles set timezone = 'Asia/Tokyo' where user_id = '00000000-0000-4000-a000-00000000000b';

insert into public.tasks (id, user_id, title, kind, effort_min, planned_for, status, completed_at, dropped_reason) values
  ('40000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-00000000000a', 'Old open synthetic task', 'quick', 5, '2026-10-25', 'open', null, null),
  ('40000000-0000-4000-a000-000000000002', '00000000-0000-4000-a000-00000000000a', 'Done synthetic task', 'quick', 5, '2026-10-25', 'done', '2026-10-25 15:00Z', null),
  ('40000000-0000-4000-a000-000000000003', '00000000-0000-4000-a000-00000000000a', 'Dropped synthetic task', 'quick', 5, '2026-10-25', 'dropped', null, 'obsolete'),
  ('40000000-0000-4000-a000-000000000004', '00000000-0000-4000-a000-00000000000a', 'Future synthetic task', 'quick', 5, '2026-10-30', 'open', null, null),
  ('40000000-0000-4000-a000-0000000000b1', '00000000-0000-4000-a000-00000000000b', 'B synthetic task', 'quick', 5, '2026-10-26', 'open', null, null);
-- A deferred task with pending undo state.
update public.tasks set undo_planned_for = '2026-10-24' where id = '40000000-0000-4000-a000-000000000004';

create temp view t_a as
  select planned_for, carry_count from public.tasks where id = '40000000-0000-4000-a000-000000000001';

select function_privs_are('private', 'rollover_tasks', array['timestamp with time zone'], 'authenticated', array[]::text[],
                          'clients cannot run rollover');

-- 2026-10-27 06:00Z = Oct 27 01:00 in Chicago, Oct 27 15:00 in Tokyo.
select is(private.rollover_tasks('2026-10-27 06:00Z'), 2, 'first run rolls both users');
select results_eq('select planned_for, carry_count from t_a', $$ values ('2026-10-27'::date, 1) $$, 'open past task moves to local today, carry_count 1');
select results_eq($$ select planned_for, carry_count from public.tasks where id = '40000000-0000-4000-a000-0000000000b1' $$,
                  $$ values ('2026-10-27'::date, 1) $$, 'B rolls in their own zone');
select results_eq($$ select status::text, planned_for, carry_count from public.tasks where id in ('40000000-0000-4000-a000-000000000002', '40000000-0000-4000-a000-000000000003') order by id $$,
                  $$ values ('done', '2026-10-25'::date, 0), ('dropped', '2026-10-25'::date, 0) $$, 'done and dropped tasks are not rolled');
select results_eq($$ select planned_for, carry_count, undo_planned_for from public.tasks where id = '40000000-0000-4000-a000-000000000004' $$,
                  $$ values ('2026-10-30'::date, 0, null::date) $$, 'future task not rolled; pending undo cleared');
select is((select last_rollover_on from public.profiles where user_id = '00000000-0000-4000-a000-00000000000a'), '2026-10-27'::date, 'last_rollover_on recorded');

-- Reruns on the same local day do nothing.
select is(private.rollover_tasks('2026-10-27 06:00Z'), 0, 'rerun at the same instant is a no-op');
select is(private.rollover_tasks('2026-10-27 14:59Z'), 0, 'Oct 27 23:59 Tokyo / 09:59 Chicago: same local day for both');
select results_eq('select planned_for, carry_count from t_a', $$ values ('2026-10-27'::date, 1) $$, 'carry_count counted once per local day');

-- Per-user zones: at 2026-10-27 15:00Z Tokyo is Oct 28 00:00, Chicago is still Oct 27.
select is(private.rollover_tasks('2026-10-27 15:00Z'), 1, 'only the user whose local day changed rolls');
select results_eq($$ select planned_for, carry_count from public.tasks where id = '40000000-0000-4000-a000-0000000000b1' $$,
                  $$ values ('2026-10-28'::date, 2) $$, 'B rolled at Tokyo midnight');
select results_eq('select planned_for, carry_count from t_a', $$ values ('2026-10-27'::date, 1) $$, 'A untouched before Chicago midnight');

-- Move east: A flies Chicago -> Tokyo. At 2026-10-27 16:00Z it is Oct 28 01:00 in Tokyo.
update public.profiles set timezone = 'Asia/Tokyo' where user_id = '00000000-0000-4000-a000-00000000000a';
select is(private.rollover_tasks('2026-10-27 16:00Z'), 1, 'moving east: the new local day rolls, not skipped');
select results_eq('select planned_for, carry_count from t_a', $$ values ('2026-10-28'::date, 2) $$, 'east move counted exactly once');

-- Move west: A flies back to Chicago. At 2026-10-28 03:00Z it is Oct 27 22:00 in Chicago,
-- a local date before the last rollover (Oct 28).
update public.profiles set timezone = 'America/Chicago' where user_id = '00000000-0000-4000-a000-00000000000a';
select is(private.rollover_tasks('2026-10-28 03:00Z'), 0, 'moving west: an earlier local date never rolls');
select is(private.user_today('00000000-0000-4000-a000-00000000000a', '2026-10-28 03:00Z'), '2026-10-28'::date,
          'today never goes back before the last rollover, so rolled tasks stay on Today');
-- Oct 28 01:00 Chicago: same local date as the last rollover (made in Tokyo), so no double count.
select is(private.rollover_tasks('2026-10-28 06:00Z'), 0, 'moving west: the already-rolled date is not counted again');
select results_eq('select planned_for, carry_count from t_a', $$ values ('2026-10-28'::date, 2) $$, 'west move: no double count');
-- Oct 29 01:00 Chicago: a new local day.
select is(private.rollover_tasks('2026-10-29 06:00Z'), 2, 'next local day rolls again');
select results_eq('select planned_for, carry_count from t_a', $$ values ('2026-10-29'::date, 3) $$, 'carry_count 3 after three local days');

-- Extreme jump east across the date line: UTC-11 -> UTC+14 skips a calendar date; counted once.
update public.profiles set timezone = 'Pacific/Kiritimati' where user_id = '00000000-0000-4000-a000-00000000000a';
select is(private.rollover_tasks('2026-10-29 12:00Z'), 1, 'date-line jump rolls once');
select results_eq('select planned_for, carry_count from t_a', $$ values ('2026-10-30'::date, 4) $$, 'jump: planned for the new local today');

-- Future task becomes due once its date passes.
select is(private.rollover_tasks('2026-10-30 12:00Z'), 2, 'Oct 31 in Kiritimati');
select results_eq($$ select planned_for, carry_count from public.tasks where id = '40000000-0000-4000-a000-000000000004' $$,
                  $$ values ('2026-10-31'::date, 1) $$, 'deferred task rolls after its day passes');

-- Never deletes.
select is((select count(*)::int from public.tasks where id::text like '40000000-%'), 5, 'rollover never deletes tasks');

select * from finish();
rollback;
