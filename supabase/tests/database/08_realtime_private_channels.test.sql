-- TM-05: private realtime channels. The topic check is private.can_join_capture_topic(); the policy
-- on realtime.messages (created only where the Realtime service's schema exists) calls it.
-- Synthetic users and data only. Runs in one transaction and rolls back.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email) values
  ('00000000-0000-4000-a000-00000000000a', 'user-a@example.test'),
  ('00000000-0000-4000-a000-00000000000b', 'user-b@example.test');
insert into public.captures (id, user_id, source, transcript, status) values
  ('c0000000-0000-4000-a000-0000000000a1', '00000000-0000-4000-a000-00000000000a', 'voice', 'Synthetic note A', 'parsing'),
  ('c0000000-0000-4000-a000-0000000000b1', '00000000-0000-4000-a000-00000000000b', 'voice', 'Synthetic note B', 'parsing');

-- The function: INVOKER, pinned search_path, authenticated only.
select ok(not p.prosecdef, 'can_join_capture_topic is SECURITY INVOKER')
from pg_proc p where p.oid = 'private.can_join_capture_topic(text)'::regprocedure;
select ok(p.proconfig @> array['search_path=""'], 'can_join_capture_topic pins search_path')
from pg_proc p where p.oid = 'private.can_join_capture_topic(text)'::regprocedure;
select function_privs_are('private', 'can_join_capture_topic', array['text'], 'anon', array[]::text[],
                          'anon cannot execute can_join_capture_topic');
select function_privs_are('private', 'can_join_capture_topic', array['text'], 'authenticated', array['EXECUTE'],
                          'authenticated can execute can_join_capture_topic');

-- Owner A.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
select is(private.can_join_capture_topic('capture:c0000000-0000-4000-a000-0000000000a1'), true,
          'the owner can join the topic of their own capture');
select is(private.can_join_capture_topic('capture:c0000000-0000-4000-a000-0000000000b1'), false,
          'the owner cannot join the topic of another user''s capture');
select is(private.can_join_capture_topic('capture:c0000000-0000-4000-a000-0000000000ff'), false,
          'an unknown capture id is refused');

-- Malformed topics: all false, none raise.
select is(private.can_join_capture_topic(t), false, 'malformed topic refused: ' || coalesce(quote_literal(t), 'null'))
from unnest(array[
  null,
  '',
  'capture:',
  'capture',
  'capture:not-a-uuid',
  'capture:c0000000-0000-4000-a000-0000000000a1:extra',
  'capture:c0000000-0000-4000-a000-0000000000a1 ',
  ' capture:c0000000-0000-4000-a000-0000000000a1',
  'Capture:c0000000-0000-4000-a000-0000000000a1',
  'capture:C0000000-0000-4000-A000-0000000000A1',
  'capture:%',
  'capture:c0000000-0000-4000-a000-0000000000a%',
  'realtime:capture:c0000000-0000-4000-a000-0000000000a1',
  'capture-c0000000-0000-4000-a000-0000000000a1',
  'room-1'
]) as t;

-- Other user B.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000b","role":"authenticated"}', true);
select is(private.can_join_capture_topic('capture:c0000000-0000-4000-a000-0000000000a1'), false,
          'another user cannot join the topic of A''s capture');
select is(private.can_join_capture_topic('capture:c0000000-0000-4000-a000-0000000000b1'), true,
          'B can join B''s own capture topic');

-- No user (a token without sub).
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select is(private.can_join_capture_topic('capture:c0000000-0000-4000-a000-0000000000a1'), false,
          'a caller with no auth.uid() is refused');
reset role;

-- The policy on realtime.messages (checked from pg_policies, which exists everywhere; the policy
-- itself is created only where the Realtime schema is installed, so these two are skipped without it).
select case when to_regclass('realtime.messages') is not null and to_regprocedure('realtime.topic()') is not null
  then ok(exists (select 1 from pg_policies
                  where schemaname = 'realtime' and tablename = 'messages'
                    and policyname = 'tasklings_capture_topic_select'
                    and cmd = 'SELECT' and roles = array['authenticated']::name[]
                    and qual like '%can_join_capture_topic%realtime.topic()%'),
          'realtime.messages has a SELECT-only policy for authenticated that checks the capture topic')
  else skip('realtime schema not installed in this database', 1) end;
select case when to_regclass('realtime.messages') is not null and to_regprocedure('realtime.topic()') is not null
  then is((select count(*)::int from pg_policies
           where schemaname = 'realtime' and tablename = 'messages' and policyname like 'tasklings\_%'
             and cmd <> 'SELECT'),
          0, 'no INSERT, UPDATE or DELETE policy of ours on realtime.messages (no broadcast from clients)')
  else skip('realtime schema not installed in this database', 1) end;

select * from finish();
rollback;
