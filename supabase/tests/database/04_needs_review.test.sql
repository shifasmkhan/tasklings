-- US-03 / US-04: tasks.needs_review is set only by the server and cleared by user edits.
-- Synthetic users and data only. Runs in one transaction and rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-4000-a000-00000000000a', 'user-a@example.test'),
  ('00000000-0000-4000-a000-00000000000b', 'user-b@example.test');

-- Fallback-path rows, written as the table owner (stands in for the server's fallback writer).
insert into public.tasks (id, user_id, title, kind, effort_min, needs_review) values
  ('20000000-0000-4000-a000-0000000000a1', '00000000-0000-4000-a000-00000000000a', 'Synthetic fallback one', 'quick', 5, true),
  ('20000000-0000-4000-a000-0000000000a2', '00000000-0000-4000-a000-00000000000a', 'Synthetic fallback two', 'quick', 5, true),
  ('20000000-0000-4000-a000-0000000000a3', '00000000-0000-4000-a000-00000000000a', 'Synthetic fallback three', 'quick', 5, true),
  ('20000000-0000-4000-a000-0000000000a4', '00000000-0000-4000-a000-00000000000a', 'Synthetic fallback four', 'quick', 5, true),
  ('20000000-0000-4000-a000-0000000000a5', '00000000-0000-4000-a000-00000000000a', 'Synthetic fallback five', 'quick', 5, true),
  ('20000000-0000-4000-a000-0000000000a6', '00000000-0000-4000-a000-00000000000a', 'Synthetic fallback six', 'quick', 5, true);

select is((select needs_review from public.tasks where id = '20000000-0000-4000-a000-0000000000a1'), true,
          'the server-side writer can set needs_review');
select is((select data_type from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks' and column_name = 'needs_review'),
          'boolean', 'needs_review is boolean');
select is((select is_nullable from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks' and column_name = 'needs_review'),
          'NO', 'needs_review is not null');
select is((select column_default from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks' and column_name = 'needs_review'),
          'false', 'needs_review defaults to false');

-- Privileges: no client insert or update grant.
select ok(not has_column_privilege('authenticated', 'public.tasks', 'needs_review', 'INSERT'),
          'authenticated may not insert tasks.needs_review');
select ok(not has_column_privilege('authenticated', 'public.tasks', 'needs_review', 'UPDATE'),
          'authenticated may not update tasks.needs_review');
select ok(has_column_privilege('authenticated', 'public.tasks', 'needs_review', 'SELECT'),
          'authenticated may read tasks.needs_review');
select ok(not has_column_privilege('anon', 'public.tasks', 'needs_review', 'SELECT'),
          'anon may not read tasks.needs_review');

-- ---------------------------------------------------------------------------
-- User A: cannot set it, can still do normal inserts (default false).
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);

select throws_ok(
  $$ insert into public.tasks (title, kind, effort_min, needs_review) values ('Self flagged', 'quick', 5, true) $$,
  '42501', null, 'A cannot insert a task with needs_review');
select throws_ok(
  $$ update public.tasks set needs_review = true where id = '20000000-0000-4000-a000-0000000000a1' $$,
  '42501', null, 'A cannot set needs_review to true');
select throws_ok(
  $$ update public.tasks set needs_review = false where id = '20000000-0000-4000-a000-0000000000a1' $$,
  '42501', null, 'A cannot clear needs_review directly either');
select lives_ok(
  $$ insert into public.tasks (title, kind, effort_min) values ('Plain client task', 'quick', 5) $$,
  'A can still insert a normal task');
select is((select needs_review from public.tasks where title = 'Plain client task'), false,
          'a client-inserted task has needs_review = false');
select is((select needs_review from public.tasks where id = '20000000-0000-4000-a000-0000000000a1'), true,
          'a rejected change left needs_review as it was');

-- Editing any one of the five content columns clears it.
update public.tasks set title = 'Edited title' where id = '20000000-0000-4000-a000-0000000000a1';
select is((select needs_review from public.tasks where id = '20000000-0000-4000-a000-0000000000a1'), false, 'editing title clears needs_review');
update public.tasks set kind = 'errand' where id = '20000000-0000-4000-a000-0000000000a2';
select is((select needs_review from public.tasks where id = '20000000-0000-4000-a000-0000000000a2'), false, 'editing kind clears needs_review');
update public.tasks set effort_min = 12 where id = '20000000-0000-4000-a000-0000000000a3';
select is((select needs_review from public.tasks where id = '20000000-0000-4000-a000-0000000000a3'), false, 'editing effort_min clears needs_review');
update public.tasks set due_date = '2026-11-02' where id = '20000000-0000-4000-a000-0000000000a4';
select is((select needs_review from public.tasks where id = '20000000-0000-4000-a000-0000000000a4'), false, 'editing due_date clears needs_review');
update public.tasks set notes = 'synthetic note' where id = '20000000-0000-4000-a000-0000000000a5';
select is((select needs_review from public.tasks where id = '20000000-0000-4000-a000-0000000000a5'), false, 'editing notes clears needs_review');

-- An edit that changes nothing, and RPC state changes, do not clear it.
update public.tasks set title = title, notes = notes where id = '20000000-0000-4000-a000-0000000000a6';
select is((select needs_review from public.tasks where id = '20000000-0000-4000-a000-0000000000a6'), true,
          'an update that changes no content column keeps needs_review');
select lives_ok($$ select public.defer_task('20000000-0000-4000-a000-0000000000a6') $$, 'A can defer a flagged task');
select is((select needs_review from public.tasks where id = '20000000-0000-4000-a000-0000000000a6'), true,
          'deferring keeps needs_review');
reset role;

-- ---------------------------------------------------------------------------
-- User B against A's flagged task.
-- ---------------------------------------------------------------------------
update public.tasks set needs_review = true where id = '20000000-0000-4000-a000-0000000000a1';

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select is((select count(*)::int from public.tasks where needs_review), 0, 'B cannot see A flagged tasks');
select throws_ok(
  $$ update public.tasks set needs_review = false where id = '20000000-0000-4000-a000-0000000000a1' $$,
  '42501', null, 'B cannot write needs_review on A task');
select results_eq(
  $$ with u as (update public.tasks set title = 'Hijacked' where id = '20000000-0000-4000-a000-0000000000a1' returning 1) select count(*)::int from u $$,
  $$ values (0) $$, 'B cannot edit A flagged task, so cannot clear its flag');
select throws_ok(
  $$ insert into public.tasks (user_id, title, kind, effort_min, needs_review)
     values ('00000000-0000-4000-a000-00000000000a', 'Plant', 'quick', 5, true) $$,
  '42501', null, 'B cannot insert a flagged task as A');
reset role;

select is((select needs_review from public.tasks where id = '20000000-0000-4000-a000-0000000000a1'), true,
          'A flagged task is unchanged after B attempts');

select * from finish();
rollback;
