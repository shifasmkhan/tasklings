-- Realtime publishes only public.captures. The app never subscribes to tasks (CaptureArrivals
-- watches the capture's status and then reads its tasks), and realtime does not apply row-level
-- security to DELETE events, so publishing tasks would let any signed-in subscriber see the
-- primary key of a task deleted by another user's undo_capture. Removing it closes that for good.
do $do$
begin
  if exists (select 1 from pg_catalog.pg_publication_tables
             where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks') then
    alter publication supabase_realtime drop table public.tasks;
  end if;
end;
$do$;
