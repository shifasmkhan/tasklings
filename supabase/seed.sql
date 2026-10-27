-- Local seed: synthetic data only. No real people, addresses or numbers.
-- Two users so cross-user behaviour can be tried by hand. Runs on `supabase db reset`.

insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('5eed0000-0000-4000-a000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'sample-a@example.test', '{"provider":"apple","providers":["apple"]}', '{"full_name":"Sample User A"}', now(), now()),
  ('5eed0000-0000-4000-a000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'sample-b@example.test', '{"provider":"apple","providers":["apple"]}', '{"full_name":"Sample User B"}', now(), now());

update public.profiles set timezone = 'America/Chicago' where user_id = '5eed0000-0000-4000-a000-00000000000a';
update public.profiles set timezone = 'Europe/Lisbon' where user_id = '5eed0000-0000-4000-a000-00000000000b';

insert into public.captures (id, user_id, source, transcript, status) values
  ('5eed0000-0000-4000-a000-0000000c0001', '5eed0000-0000-4000-a000-00000000000a', 'voice',
   'Sample transcript: buy sample milk, post the sample parcel, plan the sample trip.', 'done');

-- planned_for is relative to the user's today so the Today screen always has content.
insert into public.tasks (user_id, capture_id, title, kind, effort_min, planned_for, carry_count, sort_order) values
  ('5eed0000-0000-4000-a000-00000000000a', '5eed0000-0000-4000-a000-0000000c0001', 'Buy sample milk', 'errand', 15,
   private.user_today('5eed0000-0000-4000-a000-00000000000a'), 0, 0),
  ('5eed0000-0000-4000-a000-00000000000a', '5eed0000-0000-4000-a000-0000000c0001', 'Post the sample parcel', 'errand', 20,
   private.user_today('5eed0000-0000-4000-a000-00000000000a'), 0, 1),
  ('5eed0000-0000-4000-a000-00000000000a', '5eed0000-0000-4000-a000-0000000c0001', 'Plan the sample trip', 'project', 90,
   private.user_today('5eed0000-0000-4000-a000-00000000000a') - 6, 6, 0),
  ('5eed0000-0000-4000-a000-00000000000a', null, 'Reply to the sample message', 'quick', 5,
   private.user_today('5eed0000-0000-4000-a000-00000000000a') - 1, 1, 0),
  ('5eed0000-0000-4000-a000-00000000000a', null, 'Water the sample plants', 'quick', 5,
   private.user_today('5eed0000-0000-4000-a000-00000000000a') + 1, 0, 1),
  ('5eed0000-0000-4000-a000-00000000000b', null, 'Book a sample haircut', 'errand', 10,
   private.user_today('5eed0000-0000-4000-a000-00000000000b'), 0, 0);
