-- Realtime publishes captures (the app watches its own capture's status) and not tasks (realtime
-- would leak the primary key of deleted tasks across users: no RLS on DELETE events).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select ok(exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime'),
          'the supabase_realtime publication exists');
select ok(exists (select 1 from pg_catalog.pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'captures'),
          'captures is in supabase_realtime');
select ok(not exists (select 1 from pg_catalog.pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks'),
          'tasks is not in supabase_realtime');
select is((select array_agg(tablename::text order by tablename) from pg_catalog.pg_publication_tables
           where pubname = 'supabase_realtime' and schemaname = 'public'),
          array['captures'], 'captures is the only public table in supabase_realtime');

select * from finish();
rollback;
