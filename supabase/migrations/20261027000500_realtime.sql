-- US-04: "tasks arrive by realtime". Realtime postgres_changes enforce the subscriber's RLS
-- select policy, so a user only receives their own task rows. Captures and profiles are not
-- published.
do $do$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_catalog.pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks') then
    alter publication supabase_realtime add table public.tasks;
  end if;
end;
$do$;
