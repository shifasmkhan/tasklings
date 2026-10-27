-- US-03: extraction cost and abuse counters (security review S-05).
-- private.extraction_usage has no client grants; public.reserve_extraction is the only door.
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
select ok(not has_table_privilege(r, 'private.extraction_usage', 'SELECT,INSERT,UPDATE,DELETE'),
          r || ' has no privileges on extraction_usage')
from unnest(array['anon', 'authenticated', 'service_role']) as r;
select ok(not has_column_privilege('authenticated', 'private.extraction_usage', 'calls', 'SELECT'),
          'authenticated cannot read calls');
select ok(not has_column_privilege('authenticated', 'private.extraction_usage', 'calls', 'UPDATE'),
          'authenticated cannot write calls');

-- ---------------------------------------------------------------------------
-- The function: DEFINER, pinned search_path, authenticated only.
-- ---------------------------------------------------------------------------
select ok((select p.prosecdef from pg_proc p where p.oid = 'public.reserve_extraction(integer,integer)'::regprocedure),
          'reserve_extraction is SECURITY DEFINER');
select ok((select p.proconfig @> array['search_path=""'] from pg_proc p
           where p.oid = 'public.reserve_extraction(integer,integer)'::regprocedure),
          'reserve_extraction pins search_path');
select function_privs_are('public', 'reserve_extraction', array['integer', 'integer'], 'anon', array[]::text[],
                          'anon cannot execute reserve_extraction');
select function_privs_are('public', 'reserve_extraction', array['integer', 'integer'], 'authenticated',
                          array['EXECUTE'], 'authenticated can execute reserve_extraction');
select function_privs_are('private', 'purge_extraction_usage', array['timestamp with time zone'], 'authenticated',
                          array[]::text[], 'clients cannot execute the purge job');

-- ---------------------------------------------------------------------------
-- Unauthenticated callers.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$ select public.reserve_extraction(5, 100) $$, 'PT401', 'unauthenticated',
                 'reserve_extraction needs a user');
reset role;

set local role anon;
select throws_ok($$ select public.reserve_extraction(5, 100) $$, '42501', null, 'anon cannot call it');
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

select throws_ok($$ select public.reserve_extraction(0, 100) $$, 'PT400', 'invalid_argument', 'user limit below 1 is refused');
select throws_ok($$ select public.reserve_extraction(201, 100) $$, 'PT400', 'invalid_argument', 'user limit above the ceiling is refused');
select throws_ok($$ select public.reserve_extraction(5, 0) $$, 'PT400', 'invalid_argument', 'global limit below 1 is refused');
select throws_ok($$ select public.reserve_extraction(5, 100001) $$, 'PT400', 'invalid_argument', 'global limit above the ceiling is refused');
select throws_ok($$ select public.reserve_extraction(null, 100) $$, 'PT400', 'invalid_argument', 'null limit is refused');

select is(public.reserve_extraction(2, 100), 'ok', 'A first call is ok');
select is(public.reserve_extraction(2, 100), 'ok', 'A second call is ok');
select is(public.reserve_extraction(2, 100), 'user_cap', 'A third call hits the per-user cap');
select is(public.reserve_extraction(2, 100), 'user_cap', 'and stays capped');
reset role;

select is((select calls from private.extraction_usage where user_id = '00000000-0000-4000-a000-00000000000a'
           and day = (now() at time zone 'utc')::date), 2, 'a refused call does not increment');

-- ---------------------------------------------------------------------------
-- User B: own counter, and the global cap (A has used 2).
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select is(public.reserve_extraction(2, 100), 'ok', 'B is not affected by A cap');
select is(public.reserve_extraction(5, 3), 'global_cap', 'global cap trips at the sum across users (2 + 1 = 3)');
select is(public.reserve_extraction(5, 4), 'ok', 'a higher global limit lets the next call through');
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

-- Deleting a user removes their counters.
delete from auth.users where id = '00000000-0000-4000-a000-00000000000b';
select is((select count(*)::int from private.extraction_usage where user_id = '00000000-0000-4000-a000-00000000000b'),
          0, 'counters are deleted with the user');

select * from finish();
rollback;
