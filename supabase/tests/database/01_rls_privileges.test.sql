-- US-04 / US-09: RLS on every table, cross-user isolation, and column privileges.
-- Synthetic users and data only. Runs in one transaction and rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Synthetic users A and B (profiles are created by the auth trigger).
insert into auth.users (id, email) values
  ('00000000-0000-4000-a000-00000000000a', 'user-a@example.test'),
  ('00000000-0000-4000-a000-00000000000b', 'user-b@example.test');

select is((select count(*)::int from public.profiles
           where user_id in ('00000000-0000-4000-a000-00000000000a', '00000000-0000-4000-a000-00000000000b')),
          2, 'auth trigger creates a profile per user');

-- A's rows, created as the owner.
insert into public.captures (id, user_id, source, transcript, status) values
  ('10000000-0000-4000-a000-00000000000a', '00000000-0000-4000-a000-00000000000a', 'voice', 'synthetic transcript', 'done');
insert into public.tasks (id, user_id, capture_id, title, kind, effort_min, planned_for) values
  ('20000000-0000-4000-a000-00000000000a', '00000000-0000-4000-a000-00000000000a',
   '10000000-0000-4000-a000-00000000000a', 'Buy synthetic milk', 'errand', 15, current_date);
insert into public.task_steps (task_id, user_id, title) values
  ('20000000-0000-4000-a000-00000000000a', '00000000-0000-4000-a000-00000000000a', 'Find the shop');
insert into public.task_enrichments (task_id, user_id, type, value) values
  ('20000000-0000-4000-a000-00000000000a', '00000000-0000-4000-a000-00000000000a', 'note', 'synthetic note');
insert into public.device_tokens (user_id, apns_token) values
  ('00000000-0000-4000-a000-00000000000a', repeat('ab', 32));
insert into public.apple_credentials (user_id, apple_refresh_token) values
  ('00000000-0000-4000-a000-00000000000a', 'synthetic-ciphertext');

-- ---------------------------------------------------------------------------
-- Structure: RLS everywhere, nothing for anon, apple token unreadable by clients.
-- ---------------------------------------------------------------------------
select ok(c.relrowsecurity, 'RLS enabled on public.' || c.relname)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;

select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
          0, 'no public table without RLS');

select ok(not has_table_privilege('anon', 'public.' || c.relname, 'SELECT,INSERT,UPDATE,DELETE'),
          'anon has no privileges on public.' || c.relname)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;

select ok(not has_table_privilege('authenticated', 'public.apple_credentials', 'SELECT,INSERT,UPDATE,DELETE'),
          'authenticated has no privileges on apple_credentials');
select ok(not has_column_privilege('authenticated', 'public.apple_credentials', 'apple_refresh_token', 'SELECT'),
          'authenticated cannot select apple_refresh_token');
select ok(not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'profiles' and column_name = 'apple_refresh_token'),
          'profiles has no apple_refresh_token column');

-- Task columns clients may and may not update directly.
select ok(has_column_privilege('authenticated', 'public.tasks', col, 'UPDATE'), 'authenticated may update tasks.' || col)
from unnest(array['title', 'kind', 'effort_min', 'due_date', 'notes']) as col;
select ok(not has_column_privilege('authenticated', 'public.tasks', col, 'UPDATE'), 'authenticated may not update tasks.' || col)
from unnest(array['id', 'user_id', 'capture_id', 'effort_min_initial', 'first_planned_for', 'carry_count',
                  'script', 'sort_order', 'created_at', 'updated_at']) as col;
select ok(not has_column_privilege('authenticated', 'public.tasks', col, 'INSERT'), 'authenticated may not insert tasks.' || col)
from unnest(array['id', 'effort_min_initial', 'planned_for', 'first_planned_for', 'carry_count', 'status',
                  'completed_at', 'undo_planned_for']) as col;
select ok(not has_table_privilege('authenticated', 'public.tasks', 'DELETE'), 'tasks are never deleted by clients');

-- ---------------------------------------------------------------------------
-- Anonymous callers get nothing.
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok('select * from public.tasks', '42501', null, 'anon cannot read tasks');
select throws_ok('select * from public.today_tasks()', '42501', null, 'anon cannot call today_tasks');
reset role;

-- ---------------------------------------------------------------------------
-- User B against user A's rows: every read is empty, every write affects nothing or fails.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);

select is((select count(*)::int from public.profiles where user_id = '00000000-0000-4000-a000-00000000000a'), 0, 'B cannot see A profile');
select is((select count(*)::int from public.captures), 0, 'B cannot see A captures');
select is((select count(*)::int from public.tasks), 0, 'B cannot see A tasks');
select is((select count(*)::int from public.task_steps), 0, 'B cannot see A task_steps');
select is((select count(*)::int from public.task_enrichments), 0, 'B cannot see A task_enrichments');
select is((select count(*)::int from public.device_tokens), 0, 'B cannot see A device_tokens');
select throws_ok('select * from public.apple_credentials', '42501', null, 'B cannot read apple_credentials');

select results_eq(
  $$ with u as (update public.tasks set title = 'Hijacked' where id = '20000000-0000-4000-a000-00000000000a' returning 1) select count(*)::int from u $$,
  $$ values (0) $$, 'B cannot update A task');
select results_eq(
  $$ with u as (update public.profiles set display_name = 'x' where user_id = '00000000-0000-4000-a000-00000000000a' returning 1) select count(*)::int from u $$,
  $$ values (0) $$, 'B cannot update A profile');
select results_eq(
  $$ with u as (update public.captures set status = 'failed' where id = '10000000-0000-4000-a000-00000000000a' returning 1) select count(*)::int from u $$,
  $$ values (0) $$, 'B cannot update A capture');
select results_eq(
  $$ with u as (delete from public.device_tokens where user_id = '00000000-0000-4000-a000-00000000000a' returning 1) select count(*)::int from u $$,
  $$ values (0) $$, 'B cannot delete A device token');

select throws_ok(
  $$ insert into public.tasks (user_id, title, kind, effort_min) values ('00000000-0000-4000-a000-00000000000a', 'Plant task', 'quick', 5) $$,
  '42501', null, 'B cannot insert a task as A');
select throws_ok(
  $$ insert into public.captures (user_id, source) values ('00000000-0000-4000-a000-00000000000a', 'text') $$,
  '42501', null, 'B cannot insert a capture as A');
select throws_ok(
  $$ insert into public.device_tokens (user_id, apns_token) values ('00000000-0000-4000-a000-00000000000a', repeat('cd', 32)) $$,
  '42501', null, 'B cannot register a device for A');
select throws_ok(
  $$ insert into public.tasks (capture_id, title, kind, effort_min) values ('10000000-0000-4000-a000-00000000000a', 'Link to A capture', 'quick', 5) $$,
  '23503', null, 'B cannot attach a task to A capture (composite FK)');
reset role;

select is((select title from public.tasks where id = '20000000-0000-4000-a000-00000000000a'), 'Buy synthetic milk', 'A task unchanged after B attempts');

-- ---------------------------------------------------------------------------
-- User A on their own rows: edits allowed, protected columns rejected.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);

select results_eq(
  $$ with u as (update public.tasks set title = 'Buy oat milk', kind = 'quick', effort_min = 10, due_date = '2026-11-01', notes = 'synthetic'
                where id = '20000000-0000-4000-a000-00000000000a' returning 1) select count(*)::int from u $$,
  $$ values (1) $$, 'A can edit title, kind, effort_min, due_date, notes');
select is((select effort_min_initial from public.tasks where id = '20000000-0000-4000-a000-00000000000a'), 15,
          'editing effort_min leaves effort_min_initial alone');

select throws_ok($$ update public.tasks set status = 'done', completed_at = now() where id = '20000000-0000-4000-a000-00000000000a' $$,
                 'PT403', 'protected_column', 'A cannot set status directly');
select throws_ok($$ update public.tasks set planned_for = planned_for + 3 where id = '20000000-0000-4000-a000-00000000000a' $$,
                 'PT403', 'protected_column', 'A cannot set planned_for directly');
select throws_ok($$ update public.tasks set dropped_reason = 'obsolete' where id = '20000000-0000-4000-a000-00000000000a' $$,
                 'PT403', 'protected_column', 'A cannot set dropped_reason directly');
select throws_ok($$ update public.tasks set effort_min_initial = 1 where id = '20000000-0000-4000-a000-00000000000a' $$,
                 '42501', null, 'A cannot update effort_min_initial');
select throws_ok($$ update public.tasks set carry_count = 0 where id = '20000000-0000-4000-a000-00000000000a' $$,
                 '42501', null, 'A cannot update carry_count');
select throws_ok($$ update public.tasks set user_id = '00000000-0000-4000-a000-00000000000b' where id = '20000000-0000-4000-a000-00000000000a' $$,
                 '42501', null, 'A cannot update user_id');
select throws_ok($$ update public.profiles set timezone = 'Mars/Olympus_Mons' $$,
                 'PT400', 'invalid_argument', 'profile timezone must be an IANA name');
select throws_ok($$ insert into public.tasks (title, kind, effort_min, effort_min_initial) values ('Forge estimate', 'quick', 5, 1) $$,
                 '42501', null, 'A cannot supply effort_min_initial on insert');
select throws_ok($$ insert into public.tasks (title, kind, effort_min, planned_for) values ('Backdate', 'quick', 5, '2020-01-01') $$,
                 '42501', null, 'A cannot supply planned_for on insert');

insert into public.tasks (title, kind, effort_min) values ('Call the synthetic dentist', 'errand', 10);
reset role;
select results_eq(
  $$ select effort_min_initial, planned_for, first_planned_for, carry_count, status::text
     from public.tasks where title = 'Call the synthetic dentist' $$,
  $$ values (10, private.user_today('00000000-0000-4000-a000-00000000000a'), private.user_today('00000000-0000-4000-a000-00000000000a'), 0, 'open') $$,
  'insert defaults: planned for the user today, effort_min_initial = effort_min');

select * from finish();
rollback;
