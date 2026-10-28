-- US-09: undo_capture(capture_id) and the guarded DELETE on tasks.
-- Synthetic users and data only. Runs in one transaction and rolls back.
-- Inside one transaction now() does not move, so the fixtures are back-dated: tasks are created
-- 10 seconds ago with updated_at = created_at (as an insert leaves them), and any later edit sets
-- updated_at to now(), which is different. Captures get their finish time by disabling the
-- status_changed_at trigger for the set-up statements only.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-4000-a000-00000000000a', 'user-a@example.test'),
  ('00000000-0000-4000-a000-00000000000b', 'user-b@example.test');

alter table public.captures disable trigger captures_touch_status_changed_at;
insert into public.captures (id, user_id, source, transcript, status, status_changed_at) values
  ('c0000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-00000000000a', 'voice', 'Synthetic note one',   'done',    now() - interval '2 seconds'),
  ('c0000000-0000-4000-a000-000000000002', '00000000-0000-4000-a000-00000000000a', 'text',  'Synthetic note two',   'done',    now() - interval '2 seconds'),
  ('c0000000-0000-4000-a000-000000000003', '00000000-0000-4000-a000-00000000000a', 'voice', 'Synthetic note three', 'done',    now() - interval '31 seconds'),
  ('c0000000-0000-4000-a000-000000000004', '00000000-0000-4000-a000-00000000000a', 'voice', 'Synthetic note four',  'done',    now() - interval '2 seconds'),
  ('c0000000-0000-4000-a000-000000000005', '00000000-0000-4000-a000-00000000000a', 'voice', 'Synthetic note five',  'done',    now() - interval '2 seconds'),
  ('c0000000-0000-4000-a000-000000000006', '00000000-0000-4000-a000-00000000000a', 'voice', 'Synthetic note six',   'parsing', now() - interval '2 seconds'),
  ('c0000000-0000-4000-a000-000000000007', '00000000-0000-4000-a000-00000000000a', 'voice', 'Synthetic note seven', 'done',    now() - interval '29 seconds'),
  ('c0000000-0000-4000-a000-000000000008', '00000000-0000-4000-a000-00000000000a', 'voice', 'Synthetic note eight', 'done',    now() - interval '2 seconds'),
  ('c0000000-0000-4000-a000-000000000009', '00000000-0000-4000-a000-00000000000a', 'voice', 'Synthetic note nine',  'done',    now() - interval '2 seconds'),
  ('c0000000-0000-4000-a000-0000000000b1', '00000000-0000-4000-a000-00000000000b', 'voice', 'Synthetic note B',     'done',    now() - interval '2 seconds');
alter table public.captures enable trigger captures_touch_status_changed_at;

-- Two tasks per capture, except where noted. Back-dated: created_at = updated_at = 10 s ago.
insert into public.tasks (id, user_id, capture_id, title, kind, effort_min, created_at, updated_at)
select ('d0000000-0000-4000-a000-00000000' || lpad(n::text, 2, '0') || lpad(m::text, 2, '0'))::uuid,
       '00000000-0000-4000-a000-00000000000a',
       ('c0000000-0000-4000-a000-00000000000' || n)::uuid,
       'Synthetic task ' || n || '-' || m, 'quick', 5,
       now() - interval '10 seconds', now() - interval '10 seconds'
from generate_series(1, 9) n, generate_series(1, 2) m
where n <> 9;
-- Capture 9 has three tasks.
insert into public.tasks (id, user_id, capture_id, title, kind, effort_min, created_at, updated_at)
select ('d0000000-0000-4000-a000-00000000' || '09' || lpad(m::text, 2, '0'))::uuid,
       '00000000-0000-4000-a000-00000000000a', 'c0000000-0000-4000-a000-000000000009',
       'Synthetic task 9-' || m, 'quick', 5, now() - interval '10 seconds', now() - interval '10 seconds'
from generate_series(1, 3) m;
insert into public.tasks (id, user_id, capture_id, title, kind, effort_min, created_at, updated_at) values
  ('d0000000-0000-4000-a000-0000000000b1', '00000000-0000-4000-a000-00000000000b', 'c0000000-0000-4000-a000-0000000000b1',
   'Synthetic B task', 'quick', 5, now() - interval '10 seconds', now() - interval '10 seconds');
-- A task of A's that belongs to no capture: undo_capture must never touch it.
insert into public.tasks (id, user_id, title, kind, effort_min, created_at, updated_at) values
  ('d0000000-0000-4000-a000-0000000000f1', '00000000-0000-4000-a000-00000000000a',
   'Synthetic loose task', 'quick', 5, now() - interval '10 seconds', now() - interval '10 seconds');

-- ---------------------------------------------------------------------------
-- Function and privilege properties
-- ---------------------------------------------------------------------------
select ok(not p.prosecdef, 'undo_capture is SECURITY INVOKER')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'undo_capture';
select ok(p.proconfig @> array['search_path=""'], 'undo_capture pins search_path')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'undo_capture';
select function_privs_are('public', 'undo_capture', array['uuid'], 'anon', array[]::text[], 'anon cannot execute undo_capture');
select function_privs_are('public', 'undo_capture', array['uuid'], 'authenticated', array['EXECUTE'], 'authenticated can execute undo_capture');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'private') and p.prosecdef),
          array['handle_new_user', 'reserve_extraction'],
          'undo_capture added no SECURITY DEFINER function');
select is((select count(*)::int from pg_trigger where tgrelid = 'public.tasks'::regclass and tgname = 'tasks_guard_delete'),
          1, 'the delete guard trigger exists');

-- ---------------------------------------------------------------------------
-- Unauthenticated, null argument
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.undo_capture('c0000000-0000-4000-a000-000000000001') $$, 'PT401', 'unauthenticated',
                 'undo_capture needs a user');
reset role;

-- ---------------------------------------------------------------------------
-- User B on A's capture: undo_expired, nothing deleted. Same answer as for an unknown id.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select throws_ok($$ select public.undo_capture('c0000000-0000-4000-a000-000000000001') $$, 'PT409', 'undo_expired',
                 'B cannot undo A capture');
select throws_ok($$ select public.undo_capture('c0000000-0000-4000-a000-0000000000ff') $$, 'PT409', 'undo_expired',
                 'an unknown capture id looks the same as another user''s');
-- B's direct DELETE of A's task sees no row (RLS) and removes nothing.
select results_eq($$ with d as (delete from public.tasks where id = 'd0000000-0000-4000-a000-000000000101' returning 1) select count(*)::int from d $$,
          $$ values (0) $$, 'B direct DELETE of A task removes nothing');
reset role;
select is((select count(*)::int from public.tasks where capture_id = 'c0000000-0000-4000-a000-000000000001'), 2,
          'A tasks are intact after B attempts');

-- ---------------------------------------------------------------------------
-- User A
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);

select throws_ok($$ select public.undo_capture(null) $$, 'PT400', 'invalid_argument', 'null capture_id rejected');

-- Owner, within 30 s, tasks untouched: removes exactly that capture's tasks.
select is(public.undo_capture('c0000000-0000-4000-a000-000000000001'), 2, 'owner undo returns the number of tasks removed');
select is((select count(*)::int from public.tasks where capture_id = 'c0000000-0000-4000-a000-000000000001'), 0,
          'the capture tasks are gone');
select is((select count(*)::int from public.captures where id = 'c0000000-0000-4000-a000-000000000001'), 1,
          'the capture row is left as it is');
select is((select count(*)::int from public.tasks where id = 'd0000000-0000-4000-a000-0000000000f1'), 1,
          'a task with no capture is untouched');
select is((select count(*)::int from public.tasks where capture_id = 'c0000000-0000-4000-a000-000000000002'), 2,
          'another capture of A is untouched');
select is(public.undo_capture('c0000000-0000-4000-a000-000000000001'), 0, 'a repeated undo finds no tasks and returns 0');

-- Boundary: finished 29 s ago still works.
select is(public.undo_capture('c0000000-0000-4000-a000-000000000007'), 2, 'undo works 29 seconds after the capture finished');

-- Too late: finished 31 s ago.
select throws_ok($$ select public.undo_capture('c0000000-0000-4000-a000-000000000003') $$, 'PT409', 'undo_expired',
                 'undo fails 31 seconds after the capture finished');
select is((select count(*)::int from public.tasks where capture_id = 'c0000000-0000-4000-a000-000000000003'), 2,
          'nothing was deleted by the expired undo');

-- A capture that is not done (still parsing) cannot be undone.
select throws_ok($$ select public.undo_capture('c0000000-0000-4000-a000-000000000006') $$, 'PT409', 'undo_expired',
                 'a capture that is not done cannot be undone');

-- Edited task: one title edit blocks the whole undo.
select lives_ok($$ update public.tasks set title = 'Synthetic edited title' where id = 'd0000000-0000-4000-a000-000000000401' $$,
                'A edits one task of capture 4');
select throws_ok($$ select public.undo_capture('c0000000-0000-4000-a000-000000000004') $$, 'PT409', 'undo_expired',
                 'undo fails when one task was edited');
select is((select count(*)::int from public.tasks where capture_id = 'c0000000-0000-4000-a000-000000000004'), 2,
          'no task of the edited capture was deleted');

-- Completed task blocks it, and so does a completed-then-undone one (its state changed once).
select lives_ok($$ select public.complete_task('d0000000-0000-4000-a000-000000000501') $$, 'A completes one task of capture 5');
select throws_ok($$ select public.undo_capture('c0000000-0000-4000-a000-000000000005') $$, 'PT409', 'undo_expired',
                 'undo fails when one task is done');
select lives_ok($$ select public.undo_task('d0000000-0000-4000-a000-000000000501') $$, 'A reopens it');
select throws_ok($$ select public.undo_capture('c0000000-0000-4000-a000-000000000005') $$, 'PT409', 'undo_expired',
                 'undo still fails after the task was completed and reopened');

-- Deferred and dropped tasks block it too.
select lives_ok($$ select public.defer_task('d0000000-0000-4000-a000-000000000801') $$, 'A defers one task of capture 8');
select throws_ok($$ select public.undo_capture('c0000000-0000-4000-a000-000000000008') $$, 'PT409', 'undo_expired',
                 'undo fails when one task was deferred');
select lives_ok($$ select public.drop_task('d0000000-0000-4000-a000-000000000901') $$, 'A drops one task of capture 9');
select throws_ok($$ select public.undo_capture('c0000000-0000-4000-a000-000000000009') $$, 'PT409', 'undo_expired',
                 'undo fails when one task was dropped');

-- ---------------------------------------------------------------------------
-- No general client DELETE on tasks, before or after an RPC in the same transaction.
-- ---------------------------------------------------------------------------
select throws_ok($$ delete from public.tasks where id = 'd0000000-0000-4000-a000-000000000201' $$, 'PT403', 'protected_column',
                 'a direct client DELETE on tasks fails');
select throws_ok($$ delete from public.tasks where user_id = '00000000-0000-4000-a000-00000000000a' $$, 'PT403', 'protected_column',
                 'a bulk client DELETE on tasks fails');
select is(public.undo_capture('c0000000-0000-4000-a000-000000000002'), 2, 'undo of capture 2 works');
select throws_ok($$ delete from public.tasks where id = 'd0000000-0000-4000-a000-000000000301' $$, 'PT403', 'protected_column',
                 'a direct client DELETE still fails after undo_capture in the same transaction');
select is((select count(*)::int from public.tasks where capture_id = 'c0000000-0000-4000-a000-000000000003'), 2,
          'the tasks of the other capture survived the direct DELETE attempts');
reset role;

-- B's data was never touched.
select is((select count(*)::int from public.tasks where user_id = '00000000-0000-4000-a000-00000000000b'), 1, 'B task intact');

-- The cascade from deleting a user is not blocked by the guard (runs as the table owner).
delete from auth.users where id = '00000000-0000-4000-a000-00000000000b';
select is((select count(*)::int from public.tasks where user_id = '00000000-0000-4000-a000-00000000000b'), 0,
          'deleting a user still cascades to the tasks');

select * from finish();
rollback;
