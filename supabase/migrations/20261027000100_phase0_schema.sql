-- US-04 / US-05 / US-09: Phase 0 data model, row-level security and privileges.
-- Shapes follow the PRD data model exactly. Contract additions live in a separate
-- migration (20261027000200) so they can be reviewed on their own.
--
-- Privilege model (applies to every table below):
--   * Supabase's default privileges grant ALL on new public tables and functions to anon and
--     authenticated. We revoke that and grant back only what the contracts need, column by column.
--   * RLS is enabled on every table; authenticated gets per-user policies keyed on auth.uid().
--   * anon gets nothing anywhere.
--   * Tables are owned by postgres (migration role); scheduled jobs run as the owner.

create schema if not exists private;
revoke all on schema private from public;
-- private holds helper functions used inside RPCs. It is not exposed through PostgREST.
grant usage on schema private to authenticated, service_role;
-- New functions in private are not executable by anyone until granted explicitly.
alter default privileges in schema private revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.capture_source as enum ('voice', 'text', 'siri', 'widget');
create type public.capture_status as enum ('uploaded', 'transcribing', 'parsing', 'done', 'failed');
-- Declaration order is the Today grouping order: Quick wins, Errands, Bigger things.
create type public.task_kind as enum ('quick', 'errand', 'project');
create type public.task_status as enum ('open', 'done', 'dropped');
create type public.dropped_reason as enum ('not_needed', 'done_elsewhere', 'obsolete');
create type public.enrichment_type as enum ('phone', 'url', 'address', 'hours', 'note');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function private.is_valid_timezone(tz text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select tz is not null and exists (select 1 from pg_catalog.pg_timezone_names where name = tz);
$$;

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 100),
  -- IANA name. Defaults to UTC until the app sends the device zone on first launch.
  timezone text not null default 'UTC',
  brief_time time not null default '08:00',
  checkin_time time not null default '20:30',
  created_at timestamptz not null default now()
);

create function private.validate_profile_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not private.is_valid_timezone(new.timezone) then
    raise exception using
      errcode = 'PT400',
      message = 'invalid_argument',
      hint = 'invalid_argument',
      detail = 'timezone must be an IANA time zone name';
  end if;
  return new;
end;
$$;

create trigger profiles_validate_timezone
  before insert or update of timezone on public.profiles
  for each row execute function private.validate_profile_timezone();

-- A profile is created for every new auth user. SECURITY DEFINER is required because the
-- trigger runs as the Auth service role; it touches only the new row and pins search_path.
create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), 100)
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke all on function private.handle_new_user() from public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------
-- apple_credentials: service-only home of profiles.apple_refresh_token.
-- Kept out of profiles so no grant, view, realtime publication or `select *` on profiles can
-- ever expose it. No privileges for anon/authenticated and RLS with no policies (two locks).
-- Only delete-account (service role) reads it. The value is ciphertext: it is encrypted by the
-- writer before insert and the key never lives in the database.
-- ---------------------------------------------------------------------------
create table public.apple_credentials (
  user_id uuid primary key references public.profiles (user_id) on delete cascade,
  apple_refresh_token text not null,
  updated_at timestamptz not null default now()
);

create trigger apple_credentials_updated_at
  before update on public.apple_credentials
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- captures
-- ---------------------------------------------------------------------------
create table public.captures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (user_id) on delete cascade,
  source public.capture_source not null,
  audio_path text,
  transcript text check (transcript is null or char_length(transcript) <= 20000),
  status public.capture_status not null default 'uploaded',
  error text check (error is null or char_length(error) <= 200),
  created_at timestamptz not null default now(),
  -- Target for composite FKs so a child row can never point at another user's capture.
  unique (id, user_id)
);
create index captures_user_created_idx on public.captures (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (user_id) on delete cascade,
  capture_id uuid,
  title text not null check (char_length(btrim(title)) between 1 and 60),
  notes text check (notes is null or char_length(notes) <= 4000),
  kind public.task_kind not null,
  effort_min int not null check (effort_min between 1 and 480),
  effort_min_initial int not null check (effort_min_initial between 1 and 480),
  due_date date,
  status public.task_status not null default 'open',
  first_planned_for date not null,
  planned_for date not null,
  carry_count int not null default 0 check (carry_count >= 0),
  completed_at timestamptz,
  dropped_reason public.dropped_reason,
  script text check (script is null or char_length(script) <= 4000),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  -- Composite FK: the capture must belong to the same user (FK checks bypass RLS).
  foreign key (capture_id, user_id) references public.captures (id, user_id)
    on delete set null (capture_id),
  constraint tasks_done_has_completed_at check ((status = 'done') = (completed_at is not null)),
  constraint tasks_reason_only_when_dropped check (dropped_reason is null or status = 'dropped')
);
-- Today query: status = 'open' and planned_for <= today order by kind, sort_order.
create index tasks_today_idx on public.tasks (user_id, planned_for, kind, sort_order) where status = 'open';
create index tasks_capture_idx on public.tasks (capture_id) where capture_id is not null;

create trigger tasks_updated_at
  before update on public.tasks
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- task_steps / task_enrichments
-- ---------------------------------------------------------------------------
create table public.task_steps (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  user_id uuid not null default auth.uid() references public.profiles (user_id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  done boolean not null default false,
  sort_order int not null default 0,
  foreign key (task_id, user_id) references public.tasks (id, user_id) on delete cascade
);
create index task_steps_task_idx on public.task_steps (task_id, sort_order);

create table public.task_enrichments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  user_id uuid not null default auth.uid() references public.profiles (user_id) on delete cascade,
  type public.enrichment_type not null,
  value text not null check (char_length(value) <= 2000),
  source_url text check (source_url is null or source_url ~ '^https://'),
  created_at timestamptz not null default now(),
  foreign key (task_id, user_id) references public.tasks (id, user_id) on delete cascade
);
create index task_enrichments_task_idx on public.task_enrichments (task_id);

-- ---------------------------------------------------------------------------
-- device_tokens
-- ---------------------------------------------------------------------------
create table public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (user_id) on delete cascade,
  apns_token text not null check (apns_token ~ '^[0-9a-f]{64,200}$'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, apns_token)
);

-- ---------------------------------------------------------------------------
-- Row-level security: every table, per-user policies for authenticated only.
-- (select auth.uid()) is evaluated once per statement instead of per row.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.apple_credentials enable row level security;
alter table public.captures enable row level security;
alter table public.tasks enable row level security;
alter table public.task_steps enable row level security;
alter table public.task_enrichments enable row level security;
alter table public.device_tokens enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated using (user_id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- apple_credentials: intentionally no policies.

create policy captures_select_own on public.captures
  for select to authenticated using (user_id = (select auth.uid()));
create policy captures_insert_own on public.captures
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy captures_update_own on public.captures
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy tasks_select_own on public.tasks
  for select to authenticated using (user_id = (select auth.uid()));
create policy tasks_insert_own on public.tasks
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy tasks_update_own on public.tasks
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy task_steps_select_own on public.task_steps
  for select to authenticated using (user_id = (select auth.uid()));

create policy task_enrichments_select_own on public.task_enrichments
  for select to authenticated using (user_id = (select auth.uid()));

create policy device_tokens_select_own on public.device_tokens
  for select to authenticated using (user_id = (select auth.uid()));
create policy device_tokens_insert_own on public.device_tokens
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy device_tokens_update_own on public.device_tokens
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy device_tokens_delete_own on public.device_tokens
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Privileges. Start from nothing, then grant per column.
-- ---------------------------------------------------------------------------
revoke all on public.profiles, public.apple_credentials, public.captures, public.tasks,
  public.task_steps, public.task_enrichments, public.device_tokens
  from public, anon, authenticated;

-- profiles: readable; the app edits only preferences. No insert (trigger) or delete (delete-account).
grant select (user_id, display_name, timezone, brief_time, checkin_time, created_at)
  on public.profiles to authenticated;
grant update (display_name, timezone, brief_time, checkin_time) on public.profiles to authenticated;

-- captures: process-capture runs with the caller's JWT, so it creates and advances captures.
grant select on public.captures to authenticated;
grant insert (id, user_id, source, audio_path, transcript, status) on public.captures to authenticated;
grant update (audio_path, transcript, status, error) on public.captures to authenticated;

-- tasks: insert by process-capture (caller's JWT). planned_for, first_planned_for and
-- effort_min_initial are set by the database on insert (see 20261027000300), so they are not
-- insertable. Update grants and the protected-column guard are in 20261027000300.
grant select on public.tasks to authenticated;
grant insert (user_id, capture_id, title, notes, kind, effort_min, due_date, script, sort_order)
  on public.tasks to authenticated;

-- task_steps / task_enrichments: read-only for clients in Phase 0 (no write contract yet).
grant select on public.task_steps, public.task_enrichments to authenticated;

-- device_tokens: register-device upserts (insert + update of the conflict columns).
grant select, delete on public.device_tokens to authenticated;
grant insert (user_id, apns_token) on public.device_tokens to authenticated;
grant update (apns_token, last_seen_at) on public.device_tokens to authenticated;

-- apple_credentials: service role only.
grant select, insert, update, delete on public.apple_credentials to service_role;

-- Helpers are not callable by clients unless granted explicitly.
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_valid_timezone(text) to authenticated;
