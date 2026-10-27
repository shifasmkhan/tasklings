-- US-05: today_tasks, complete_task, undo_task, defer_task, drop_task.
-- Every RPC is also called by user B on user A's task and must fail without changing it.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-4000-a000-00000000000a', 'user-a@example.test'),
  ('00000000-0000-4000-a000-00000000000b', 'user-b@example.test');
-- Opposite ends of the clock so "today" and "tomorrow" differ by user whenever possible.
update public.profiles set timezone = 'Pacific/Kiritimati' where user_id = '00000000-0000-4000-a000-00000000000a';
update public.profiles set timezone = 'Pacific/Pago_Pago' where user_id = '00000000-0000-4000-a000-00000000000b';

create temp table t_today as
  select private.user_today('00000000-0000-4000-a000-00000000000a') as a_today,
         private.user_today('00000000-0000-4000-a000-00000000000b') as b_today;
grant select on t_today to authenticated;

-- A's tasks (as owner, explicit planned_for).
insert into public.tasks (id, user_id, title, kind, effort_min, planned_for, sort_order) values
  ('30000000-0000-4000-a000-000000000001', '00000000-0000-4000-a000-00000000000a', 'Plan synthetic trip',   'project', 120, (select a_today - 2 from t_today), 0),
  ('30000000-0000-4000-a000-000000000002', '00000000-0000-4000-a000-00000000000a', 'Reply to synthetic note', 'quick', 5, (select a_today from t_today), 1),
  ('30000000-0000-4000-a000-000000000003', '00000000-0000-4000-a000-00000000000a', 'Post synthetic parcel', 'errand',  20, (select a_today from t_today), 0),
  ('30000000-0000-4000-a000-000000000004', '00000000-0000-4000-a000-00000000000a', 'Water synthetic plants', 'quick',  5, (select a_today from t_today), 0),
  ('30000000-0000-4000-a000-000000000005', '00000000-0000-4000-a000-00000000000a', 'Future synthetic task', 'quick',   5, (select a_today + 3 from t_today), 0);
insert into public.tasks (id, user_id, title, kind, effort_min, planned_for, status, completed_at) values
  ('30000000-0000-4000-a000-000000000006', '00000000-0000-4000-a000-00000000000a', 'Done synthetic task', 'quick', 5, (select a_today from t_today), 'done', now());
insert into public.tasks (id, user_id, title, kind, effort_min, planned_for) values
  ('30000000-0000-4000-a000-0000000000b1', '00000000-0000-4000-a000-00000000000b', 'B synthetic task', 'quick', 5, (select b_today from t_today));

-- ---------------------------------------------------------------------------
-- Function properties
-- ---------------------------------------------------------------------------
select ok(not p.prosecdef, p.proname || ' is SECURITY INVOKER')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('today_tasks', 'complete_task', 'undo_task', 'defer_task', 'drop_task')
order by p.proname;
select ok(p.proconfig @> array['search_path=""'], p.proname || ' pins search_path')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('today_tasks', 'complete_task', 'undo_task', 'defer_task', 'drop_task')
order by p.proname;
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('public', 'private') and p.prosecdef),
          array['handle_new_user', 'reserve_extraction'],
          'the only SECURITY DEFINER functions are the auth trigger and reserve_extraction');
select function_privs_are('public', 'complete_task', array['uuid'], 'anon', array[]::text[], 'anon cannot execute complete_task');

-- ---------------------------------------------------------------------------
-- Unauthenticated (authenticated role, no sub claim)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select * from public.today_tasks() $$, 'PT401', 'unauthenticated', 'today_tasks needs a user');
select throws_ok($$ select public.complete_task('30000000-0000-4000-a000-000000000002') $$, 'PT401', 'unauthenticated', 'complete_task needs a user');
reset role;

-- ---------------------------------------------------------------------------
-- User B on A's task: every RPC fails with task_not_found and A's task is unchanged.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select results_eq($$ select id from public.today_tasks() $$,
                  $$ values ('30000000-0000-4000-a000-0000000000b1'::uuid) $$, 'B today_tasks returns only B tasks');
select throws_ok($$ select public.complete_task('30000000-0000-4000-a000-000000000002') $$, 'PT404', 'task_not_found', 'B cannot complete A task');
select throws_ok($$ select public.undo_task('30000000-0000-4000-a000-000000000006') $$, 'PT404', 'task_not_found', 'B cannot undo A task');
select throws_ok($$ select public.defer_task('30000000-0000-4000-a000-000000000002') $$, 'PT404', 'task_not_found', 'B cannot defer A task');
select throws_ok($$ select public.drop_task('30000000-0000-4000-a000-000000000002', 'obsolete') $$, 'PT404', 'task_not_found', 'B cannot drop A task');
select throws_ok($$ select public.drop_task('30000000-0000-4000-a000-000000000002') $$, 'PT404', 'task_not_found', 'B cannot drop A task without reason');
select throws_ok($$ select public.complete_task('39999999-0000-4000-a000-000000000000') $$, 'PT404', 'task_not_found', 'unknown id looks the same as another user''s id');
reset role;
select results_eq(
  $$ select status::text, planned_for, completed_at is null from public.tasks where id = '30000000-0000-4000-a000-000000000002' $$,
  $$ select 'open', a_today, true from t_today $$, 'A task 2 unchanged after B calls');
select results_eq(
  $$ select status::text from public.tasks where id = '30000000-0000-4000-a000-000000000006' $$,
  $$ values ('done') $$, 'A task 6 still done after B undo');

-- ---------------------------------------------------------------------------
-- User A
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);

select results_eq(
  $$ select id from public.today_tasks() $$,
  $$ values ('30000000-0000-4000-a000-000000000004'::uuid), ('30000000-0000-4000-a000-000000000002'::uuid),
            ('30000000-0000-4000-a000-000000000003'::uuid), ('30000000-0000-4000-a000-000000000001'::uuid) $$,
  'today_tasks: open, planned today or earlier, ordered by kind then sort_order; excludes done and future');

-- complete / undo
select results_eq($$ select status::text, completed_at is not null from public.complete_task('30000000-0000-4000-a000-000000000002') $$,
                  $$ values ('done', true) $$, 'complete_task marks done with completed_at');
select throws_ok($$ select public.complete_task('30000000-0000-4000-a000-000000000002') $$, 'PT409', 'invalid_state', 'cannot complete twice');
select throws_ok($$ select public.defer_task('30000000-0000-4000-a000-000000000002') $$, 'PT409', 'invalid_state', 'cannot defer a done task');
select results_eq($$ select status::text, completed_at is null from public.undo_task('30000000-0000-4000-a000-000000000002') $$,
                  $$ values ('open', true) $$, 'undo_task reopens a completed task');
select throws_ok($$ select public.undo_task('30000000-0000-4000-a000-000000000002') $$, 'PT409', 'nothing_to_undo', 'nothing left to undo');

-- defer / undo restores planned_for
select results_eq($$ select planned_for from public.defer_task('30000000-0000-4000-a000-000000000001') $$,
                  $$ select a_today + 1 from t_today $$, 'defer_task plans for tomorrow in the profile time zone');
-- UTC+14 and UTC-11 are 25 hours apart, so the two users' local dates always differ.
select isnt((select a_today from t_today), (select b_today from t_today), 'A and B have different local todays');
select is((select count(*)::int from public.today_tasks() where id = '30000000-0000-4000-a000-000000000001'), 0, 'deferred task leaves Today');
select results_eq($$ select planned_for, undo_planned_for from public.undo_task('30000000-0000-4000-a000-000000000001') $$,
                  $$ select a_today - 2, null::date from t_today $$, 'undo after defer restores the previous planned_for');
select results_eq($$ select carry_count from public.tasks where id = '30000000-0000-4000-a000-000000000001' $$,
                  $$ values (0) $$, 'defer and undo do not touch carry_count');

-- drop / undo
select throws_ok($$ select public.drop_task('30000000-0000-4000-a000-000000000003', 'bored') $$, 'PT400', 'invalid_argument', 'drop_task rejects an unknown reason');
select results_eq($$ select status::text, dropped_reason::text from public.drop_task('30000000-0000-4000-a000-000000000003', 'done_elsewhere') $$,
                  $$ values ('dropped', 'done_elsewhere') $$, 'drop_task with reason');
select throws_ok($$ select public.drop_task('30000000-0000-4000-a000-000000000003') $$, 'PT409', 'invalid_state', 'cannot drop twice');
select results_eq($$ select status::text, dropped_reason from public.undo_task('30000000-0000-4000-a000-000000000003') $$,
                  $$ values ('open', null::public.dropped_reason) $$, 'undo_task reopens a dropped task');
select results_eq($$ select status::text, dropped_reason from public.drop_task('30000000-0000-4000-a000-000000000004') $$,
                  $$ values ('dropped', null::public.dropped_reason) $$, 'drop_task without reason');
select throws_ok($$ select public.complete_task(null) $$, 'PT400', 'invalid_argument', 'null id rejected');

-- After an RPC, direct state edits are still blocked (the flag does not leak).
select throws_ok($$ update public.tasks set status = 'open' where id = '30000000-0000-4000-a000-000000000004' $$,
                 'PT403', 'protected_column', 'protected columns stay locked after an RPC in the same transaction');
reset role;

select * from finish();
rollback;
