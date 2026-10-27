-- US-03: extraction cost and abuse controls (security review S-05) and the stuck-capture sweeper.
-- private.extraction_usage and private.extraction_limits have no client grants;
-- public.reserve_extraction() is the only door. Limits live in the database, not in arguments.
-- Synthetic users only. Runs in one transaction and rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-4000-a000-00000000000a', 'user-a@example.test'),
  ('00000000-0000-4000-a000-00000000000b', 'user-b@example.test');

-- ---------------------------------------------------------------------------
-- The table: RLS on, no grants for any API role.
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'private.extraction_usage'::regclass),
          'extraction_usage has RLS enabled');
select is((select count(*)::int from pg_policies where schemaname = 'private' and tablename = 'extraction_usage'),
          0, 'extraction_usage has no policies');
select ok(not has_table_privilege(r, t, 'SELECT,INSERT,UPDATE,DELETE'), r || ' has no privileges on ' || t)
from unnest(array['anon', 'authenticated', 'service_role']) as r,
     unnest(array['private.extraction_usage', 'private.extraction_limits']) as t;
select ok((select relrowsecurity from pg_class where oid = 'private.extraction_limits'::regclass),
          'extraction_limits has RLS enabled');
select is((select count(*)::int from pg_policies where schemaname = 'private' and tablename = 'extraction_limits'),
          0, 'extraction_limits has no policies');
select results_eq($$ select user_daily_cap, global_daily_cap from private.extraction_limits $$,
                  $$ values (50, 500) $$, 'the migration seeds 50 per user and 500 global');
select throws_ok($$ insert into private.extraction_limits (singleton, user_daily_cap, global_daily_cap) values (false, 1, 1) $$,
                 '23514', null, 'the limits table holds a single row (singleton must be true)');
select throws_ok($$ insert into private.extraction_limits (user_daily_cap, global_daily_cap) values (1, 1) $$,
                 '23505', null, 'a second limits row is refused');
select ok(not has_column_privilege('authenticated', 'private.extraction_usage', 'calls', 'SELECT'),
          'authenticated cannot read calls');
select ok(not has_column_privilege('authenticated', 'private.extraction_usage', 'calls', 'UPDATE'),
          'authenticated cannot write calls');

-- ---------------------------------------------------------------------------
-- The function: DEFINER, pinned search_path, authenticated only.
-- ---------------------------------------------------------------------------
select ok((select p.prosecdef from pg_proc p where p.oid = 'public.reserve_extraction()'::regprocedure),
          'reserve_extraction is SECURITY DEFINER');
select ok((select p.proconfig @> array['search_path=""'] from pg_proc p
           where p.oid = 'public.reserve_extraction()'::regprocedure),
          'reserve_extraction pins search_path');
select function_privs_are('public', 'reserve_extraction', array[]::text[], 'anon', array[]::text[],
                          'anon cannot execute reserve_extraction');
select function_privs_are('public', 'reserve_extraction', array[]::text[], 'authenticated',
                          array['EXECUTE'], 'authenticated can execute reserve_extraction');
select function_privs_are('private', 'purge_extraction_usage', array['timestamp with time zone'], 'authenticated',
                          array[]::text[], 'clients cannot execute the purge job');
select function_privs_are('private', 'fail_stuck_captures', array['timestamp with time zone'], 'authenticated',
                          array[]::text[], 'clients cannot execute the sweeper');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'reserve_extraction'), 1,
          'there is exactly one reserve_extraction and it has no overload that takes limits');
select is((select pronargs::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'reserve_extraction'), 0, 'reserve_extraction takes no arguments');

-- ---------------------------------------------------------------------------
-- Unauthenticated callers.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.reserve_extraction() $$, 'PT401', 'unauthenticated',
                 'reserve_extraction needs a user');
reset role;

set local role anon;
select throws_ok($$ select public.reserve_extraction() $$, '42501', null, 'anon cannot call it');
reset role;

-- ---------------------------------------------------------------------------
-- User A: per-user cap.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);

select throws_ok($$ select * from private.extraction_usage $$, '42501', null, 'A cannot read the counters');
select throws_ok($$ insert into private.extraction_usage (user_id, day, calls) values (auth.uid(), current_date, 1) $$,
                 '42501', null, 'A cannot insert counters');
select throws_ok($$ update private.extraction_usage set calls = 0 $$, '42501', null, 'A cannot reset counters');
select throws_ok($$ delete from private.extraction_usage $$, '42501', null, 'A cannot delete counters');

select throws_ok($$ select * from private.extraction_limits $$, '42501', null, 'A cannot read the limits');
select throws_ok($$ update private.extraction_limits set user_daily_cap = 100000 $$, '42501', null, 'A cannot change the limits');
select throws_ok($$ insert into private.extraction_limits (user_daily_cap, global_daily_cap) values (1, 1) $$,
                 '42501', null, 'A cannot insert limits');
select throws_ok($$ select public.reserve_extraction(200, 100000) $$, '42883', null,
                 'A cannot pass limits: the function takes no arguments');
reset role;

-- The owner sets small limits for the test (production default: 50 and 500).
update private.extraction_limits set user_daily_cap = 2, global_daily_cap = 100;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
select is(public.reserve_extraction(), 'ok', 'A first call is ok');
select is(public.reserve_extraction(), 'ok', 'A second call is ok');
select is(public.reserve_extraction(), 'user_cap', 'A third call hits the stored per-user limit');
select is(public.reserve_extraction(), 'user_cap', 'and a direct caller can never exceed it');
reset role;

select is((select calls from private.extraction_usage where user_id = '00000000-0000-4000-a000-00000000000a'
           and day = (now() at time zone 'utc')::date), 2, 'a refused call does not increment');

-- ---------------------------------------------------------------------------
-- User B: own counter, and the global cap (A has used 2).
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select is(public.reserve_extraction(), 'ok', 'B is not affected by A cap');
reset role;
update private.extraction_limits set user_daily_cap = 5, global_daily_cap = 3;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select is(public.reserve_extraction(), 'global_cap', 'global cap trips at the stored sum across users (2 + 1 = 3)');
reset role;
update private.extraction_limits set global_daily_cap = 4;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select is(public.reserve_extraction(), 'ok', 'a higher stored global limit lets the next call through');
reset role;

select is((select calls from private.extraction_usage where user_id = '00000000-0000-4000-a000-00000000000a'
           and day = (now() at time zone 'utc')::date), 2, 'B calls never changed A counter');
select is((select calls from private.extraction_usage where user_id = '00000000-0000-4000-a000-00000000000b'
           and day = (now() at time zone 'utc')::date), 2, 'the global_cap call did not increment B');
select is((select count(*)::int from private.extraction_usage), 2, 'one row per user per day');

-- ---------------------------------------------------------------------------
-- Housekeeping.
-- ---------------------------------------------------------------------------
insert into private.extraction_usage (user_id, day, calls) values
  ('00000000-0000-4000-a000-00000000000a', (now() at time zone 'utc')::date - 10, 4),
  ('00000000-0000-4000-a000-00000000000b', (now() at time zone 'utc')::date - 7, 4);
select is(private.purge_extraction_usage(), 1, 'purge removes rows older than 7 days');
select is((select count(*)::int from private.extraction_usage), 3, 'purge keeps recent rows');

-- Missing configuration fails closed.
delete from private.extraction_limits;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
select is(public.reserve_extraction(), 'global_cap', 'with no limits row the function refuses');
reset role;
insert into private.extraction_limits (user_daily_cap, global_daily_cap) values (50, 500);

-- ---------------------------------------------------------------------------
-- Stuck-capture sweeper, status_changed_at, and retrying a failed capture.
-- ---------------------------------------------------------------------------
insert into public.captures (id, user_id, source, transcript, status) values
  ('10000000-0000-4000-a000-0000000000c1', '00000000-0000-4000-a000-00000000000a', 'voice', 'synthetic one', 'parsing'),
  ('10000000-0000-4000-a000-0000000000c2', '00000000-0000-4000-a000-00000000000a', 'voice', 'synthetic two', 'parsing'),
  ('10000000-0000-4000-a000-0000000000c3', '00000000-0000-4000-a000-00000000000a', 'voice', 'synthetic three', 'done'),
  ('10000000-0000-4000-a000-0000000000c4', '00000000-0000-4000-a000-00000000000a', 'voice', 'synthetic four', 'failed');
select ok((select status_changed_at >= now() - interval '1 minute' from public.captures
           where id = '10000000-0000-4000-a000-0000000000c1'), 'status_changed_at is set on insert');
-- The trigger keeps status_changed_at when the status does not change, so back-date the rows with
-- the trigger switched off (c1: parsing, c3: done, both 10 minutes old; c2 stays fresh).
update public.captures set status_changed_at = now() - interval '10 minutes'
 where id in ('10000000-0000-4000-a000-0000000000c1', '10000000-0000-4000-a000-0000000000c2');
select ok((select status_changed_at >= now() - interval '1 minute' from public.captures
           where id = '10000000-0000-4000-a000-0000000000c1'), 'status_changed_at does not move without a status change');
alter table public.captures disable trigger captures_touch_status_changed_at;
update public.captures set status_changed_at = now() - interval '10 minutes'
 where id in ('10000000-0000-4000-a000-0000000000c1', '10000000-0000-4000-a000-0000000000c3');
alter table public.captures enable trigger captures_touch_status_changed_at;

select is(private.fail_stuck_captures(), 1, 'the sweeper fails exactly the one capture stuck over 5 minutes');
select results_eq($$ select status::text, error from public.captures where id = '10000000-0000-4000-a000-0000000000c1' $$,
                  $$ values ('failed', 'extraction_timeout') $$, 'the stuck capture is failed with extraction_timeout');
select is((select status::text from public.captures where id = '10000000-0000-4000-a000-0000000000c2'), 'parsing',
          'a fresh parsing capture is left alone');
select is((select status::text from public.captures where id = '10000000-0000-4000-a000-0000000000c3'), 'done',
          'a done capture is left alone');
select is(private.fail_stuck_captures(), 0, 'the sweeper is idempotent');
select is(private.fail_stuck_captures(now() + interval '6 minutes'), 1,
          'a capture becomes stuck once it is more than 5 minutes old');
update public.captures set status = 'failed', error = 'extraction_timeout' where id = '10000000-0000-4000-a000-0000000000c2';

-- Clients cannot write status_changed_at; the owner of a failed capture can retry it.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
select ok(not has_column_privilege('authenticated', 'public.captures', 'status_changed_at', 'UPDATE'),
          'clients cannot update status_changed_at');
select ok(not has_column_privilege('authenticated', 'public.captures', 'status_changed_at', 'INSERT'),
          'clients cannot insert status_changed_at');
select results_eq($$ with u as (update public.captures set status = 'parsing', error = null, transcript = 'synthetic retry'
                                 where id = '10000000-0000-4000-a000-0000000000c1' and status = 'failed' returning id)
                     select count(*)::int from u $$, $$ values (1) $$, 'A can flip their own failed capture back to parsing');
select results_eq($$ with u as (update public.captures set status = 'parsing', error = null
                                 where id = '10000000-0000-4000-a000-0000000000c1' and status = 'failed' returning id)
                     select count(*)::int from u $$, $$ values (0) $$, 'a second concurrent retry gets no row');
reset role;
select ok((select status_changed_at >= now() - interval '1 minute' from public.captures
           where id = '10000000-0000-4000-a000-0000000000c1'), 'a retry resets status_changed_at, so the sweeper leaves it alone');
select is(private.fail_stuck_captures(), 0, 'the retried capture is not swept');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select results_eq($$ with u as (update public.captures set status = 'parsing', error = null
                                 where id = '10000000-0000-4000-a000-0000000000c4' and status = 'failed' returning id)
                     select count(*)::int from u $$, $$ values (0) $$, 'B cannot retry A failed capture');
reset role;
select is((select status::text from public.captures where id = '10000000-0000-4000-a000-0000000000c4'), 'failed',
          'A failed capture is unchanged after B attempts');

-- Deleting a user removes their counters.
delete from auth.users where id = '00000000-0000-4000-a000-00000000000b';
select is((select count(*)::int from private.extraction_usage where user_id = '00000000-0000-4000-a000-00000000000b'),
          0, 'counters are deleted with the user');

select * from finish();
rollback;
