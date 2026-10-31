-- Rehearsal for supabase/migrations/20261031120000_homeowner_from_property_links.sql
-- against a DISPOSABLE local stack only (it seeds rows and re-runs the
-- migration and its rollback). Never point it at a hosted project.
--
--   supabase init --workdir /tmp/stack && cp -R supabase/migrations /tmp/stack/supabase/
--   supabase start --workdir /tmp/stack --exclude studio,postgres-meta,realtime,edge-runtime
--   psql "$DB_URL" -v ON_ERROR_STOP=1 \
--     -v FWD_FORWARD="$PWD/supabase/migrations/20261031120000_homeowner_from_property_links.sql" \
--     -v FWD_ROLLBACK="$PWD/supabase/rollbacks/20261031120000_homeowner_from_property_links.sql" \
--     -f scripts/rehearse-homeowner-from-property-links.sql
--
-- Prints "ALL SCENARIOS OK" on success. Scenarios:
--   A  first DealMachine person becomes homeowner; a second never replaces them
--   B  a do_not_contact person is skipped; the next contactable one is chosen; lead not DNC-locked
--   C  an existing homeowner is never rewired
--   D  a DNC-locked lead is left alone and the import still succeeds
--   E  backfill: the person who texted in wins over an earlier link
--   F  backfill: with no messages the first link wins
--   G  backfill: an opted_out lead stays empty
--   rollback clears only backfilled rows and keeps a homeowner changed since
\set ON_ERROR_STOP on
\set org '00000000-0000-0000-0000-000000000bbb'

-- ---------------------------------------------------------------------------
-- Part 1: import-time behaviour (functions as installed by the migration)
-- ---------------------------------------------------------------------------
begin;
insert into public.properties (id, org_id, address, state, source) values
  ('a0000000-0000-0000-0000-00000000000a', :'org', '1 A St', 'MO', 'dealmachine'),
  ('a0000000-0000-0000-0000-00000000000b', :'org', '2 B St', 'MO', 'dealmachine'),
  ('a0000000-0000-0000-0000-00000000000c', :'org', '3 C St', 'MO', 'dealmachine'),
  ('a0000000-0000-0000-0000-00000000000d', :'org', '4 D St', 'MO', 'dealmachine');

-- A: first DealMachine person becomes homeowner; the second does not replace them.
select public.upsert_dealmachine_property_contact('a0000000-0000-0000-0000-00000000000a', :'org', 'dm-a1', 1::smallint, '{}'::jsonb,
  '{"first_name":"Charles","last_name":"Fugate","phone_1":"+14175550001","phone_1_type":"mobile"}'::jsonb) as a1 \gset
select public.upsert_dealmachine_property_contact('a0000000-0000-0000-0000-00000000000a', :'org', 'dm-a2', 1::smallint, '{}'::jsonb,
  '{"first_name":"Linda","last_name":"Fugate","phone_1":"+14175550002","phone_1_type":"mobile"}'::jsonb) as a2 \gset
do $$ begin
  if (select homeowner_contact_id from public.properties where id='a0000000-0000-0000-0000-00000000000a') <> (select id from public.contacts where phone_1='+14175550001') then
    raise exception 'A: expected first linked person as homeowner';
  end if;
end $$;

-- B: a do-not-contact first person is skipped; the second, contactable one is chosen; lead is not DNC-locked.
select public.upsert_dealmachine_property_contact('a0000000-0000-0000-0000-00000000000b', :'org', 'dm-b1', 1::smallint, '{}'::jsonb,
  '{"first_name":"Dee","last_name":"Enncee","phone_1":"+14175550011","phone_1_type":"mobile","do_not_contact":true}'::jsonb) as b1 \gset
do $$ begin
  if (select homeowner_contact_id from public.properties where id='a0000000-0000-0000-0000-00000000000b') is not null then
    raise exception 'B: a do-not-contact person must not become homeowner';
  end if;
end $$;
select public.upsert_assigns_property_contact('a0000000-0000-0000-0000-00000000000b', :'org', 'assigns:2:deadbeef', 2::smallint, '{}'::jsonb,
  '{"contact_type":"person","first_name":"Okay","last_name":"Person","phone_1":"+14175550012","phone_1_type":"mobile"}'::jsonb) as b2 \gset
do $$ begin
  if (select homeowner_contact_id from public.properties where id='a0000000-0000-0000-0000-00000000000b') <> (select id from public.contacts where phone_1='+14175550012') then
    raise exception 'B: expected the contactable second person as homeowner';
  end if;
  if (select is_dnc_locked from public.properties where id='a0000000-0000-0000-0000-00000000000b') then
    raise exception 'B: lead must not be DNC-locked';
  end if;
end $$;

-- C: an existing homeowner is never rewired by an import.
insert into public.contacts (id, org_id, first_name, last_name, phone_1, phone_1_type) values
  ('c0000000-0000-0000-0000-00000000000c', :'org', 'Already', 'Owner', '+14175550021', 'mobile');
update public.properties set homeowner_contact_id = 'c0000000-0000-0000-0000-00000000000c' where id='a0000000-0000-0000-0000-00000000000c';
select public.upsert_dealmachine_property_contact('a0000000-0000-0000-0000-00000000000c', :'org', 'dm-c1', 1::smallint, '{}'::jsonb,
  '{"first_name":"New","last_name":"Guy","phone_1":"+14175550022","phone_1_type":"mobile"}'::jsonb) as c1 \gset
do $$ begin
  if (select homeowner_contact_id from public.properties where id='a0000000-0000-0000-0000-00000000000c') <> 'c0000000-0000-0000-0000-00000000000c' then
    raise exception 'C: existing homeowner was rewired';
  end if;
end $$;

-- D: a DNC-locked lead is read-only; the import must still succeed and leave it alone.
update public.properties set outreach_dispo = 'dnc' where id='a0000000-0000-0000-0000-00000000000d';
do $$ begin
  if not (select is_dnc_locked from public.properties where id='a0000000-0000-0000-0000-00000000000d') then
    raise exception 'D: setup expected the dnc disposition to lock the lead';
  end if;
end $$;
select public.upsert_dealmachine_property_contact('a0000000-0000-0000-0000-00000000000d', :'org', 'dm-d1', 1::smallint, '{}'::jsonb,
  '{"first_name":"Locked","last_name":"Lead","phone_1":"+14175550031","phone_1_type":"mobile"}'::jsonb) as d1 \gset
do $$ begin
  if (select homeowner_contact_id from public.properties where id='a0000000-0000-0000-0000-00000000000d') is not null then
    raise exception 'D: locked lead must stay untouched';
  end if;
end $$;
commit;
\echo PART 1 OK

-- ---------------------------------------------------------------------------
-- Part 2: backfill. Seed pre-migration shape (links, no homeowner), then run
-- rollback + forward so the forward's backfill runs over seeded rows.
-- ---------------------------------------------------------------------------
begin;
insert into public.properties (id, org_id, address, state, source) values
  ('b0000000-0000-0000-0000-00000000000e', :'org', '5 E St', 'MO', 'assigns'),
  ('b0000000-0000-0000-0000-00000000000f', :'org', '6 F St', 'MO', 'assigns'),
  ('b0000000-0000-0000-0000-000000000010', :'org', '7 G St', 'MO', 'assigns');
insert into public.contacts (id, org_id, first_name, last_name, phone_1, phone_1_type) values
  ('c0000000-0000-0000-0000-0000000000e1', :'org', 'E', 'One', '+14175550041', 'mobile'),
  ('c0000000-0000-0000-0000-0000000000e2', :'org', 'E', 'Two', '+14175550042', 'mobile'),
  ('c0000000-0000-0000-0000-0000000000f1', :'org', 'F', 'One', '+14175550051', 'mobile'),
  ('c0000000-0000-0000-0000-000000000101', :'org', 'G', 'One', '+14175550061', 'mobile');
-- E: two links; the second one texted in -> the texter wins.
insert into public.property_contacts (property_id, contact_id, org_id, relationship, source_identity, source_position, source_attributes) values
  ('b0000000-0000-0000-0000-00000000000e', 'c0000000-0000-0000-0000-0000000000e1', :'org', 'assigns_contact', 'assigns:1:00000001', 1, '{}'),
  ('b0000000-0000-0000-0000-00000000000e', 'c0000000-0000-0000-0000-0000000000e2', :'org', 'assigns_contact', 'assigns:2:00000002', 2, '{}');
insert into public.messages (org_id, channel, direction, property_id, contact_id, from_address, to_address, body, status) values
  (:'org', 'sms', 'inbound', 'b0000000-0000-0000-0000-00000000000e', 'c0000000-0000-0000-0000-0000000000e2', '+14175550042', '+18165550000', 'yes still own it', 'received');
-- F: one link, no messages -> first link.
insert into public.property_contacts (property_id, contact_id, org_id, relationship, source_identity, source_position, source_attributes) values
  ('b0000000-0000-0000-0000-00000000000f', 'c0000000-0000-0000-0000-0000000000f1', :'org', 'assigns_contact', 'assigns:1:00000003', 1, '{}');
-- G: opted_out disposition -> left alone.
insert into public.property_contacts (property_id, contact_id, org_id, relationship, source_identity, source_position, source_attributes) values
  ('b0000000-0000-0000-0000-000000000010', 'c0000000-0000-0000-0000-000000000101', :'org', 'assigns_contact', 'assigns:1:00000004', 1, '{}');
update public.properties set outreach_dispo = 'opted_out' where id='b0000000-0000-0000-0000-000000000010';
commit;

\i :FWD_ROLLBACK
-- After rollback, nothing from part 1 changes (import-set homeowners are not in the backfill table).
do $$ begin
  if (select homeowner_contact_id from public.properties where id='a0000000-0000-0000-0000-00000000000a') is null then
    raise exception 'rollback: import-set homeowner must survive (not a backfill row)';
  end if;
  if to_regprocedure('public.fill_homeowner_from_links(uuid,uuid)') is not null then
    raise exception 'rollback: helper should be gone';
  end if;
end $$;
\echo ROLLBACK (pre-backfill) OK

\i :FWD_FORWARD
do $$ begin
  if (select homeowner_contact_id from public.properties where id='b0000000-0000-0000-0000-00000000000e') <> 'c0000000-0000-0000-0000-0000000000e2' then
    raise exception 'E: the person who texted in must win';
  end if;
  if (select homeowner_contact_id from public.properties where id='b0000000-0000-0000-0000-00000000000f') <> 'c0000000-0000-0000-0000-0000000000f1' then
    raise exception 'F: first link must be chosen';
  end if;
  if (select homeowner_contact_id from public.properties where id='b0000000-0000-0000-0000-000000000010') is not null then
    raise exception 'G: opted_out lead must stay empty';
  end if;
  if (select count(*) from public.homeowner_link_backfill) <> 2 then
    raise exception 'backfill table should hold exactly E and F, has %', (select count(*) from public.homeowner_link_backfill);
  end if;
  if (select homeowner_contact_id from public.properties where id='a0000000-0000-0000-0000-00000000000c') <> 'c0000000-0000-0000-0000-00000000000c' then
    raise exception 'C: backfill must not touch a set homeowner';
  end if;
end $$;
\echo FORWARD BACKFILL OK

-- Rollback undoes exactly E and F, keeps a homeowner changed by a person since.
update public.properties set homeowner_contact_id = 'c0000000-0000-0000-0000-0000000000e1' where id='b0000000-0000-0000-0000-00000000000e';
\i :FWD_ROLLBACK
do $$ begin
  if (select homeowner_contact_id from public.properties where id='b0000000-0000-0000-0000-00000000000f') is not null then
    raise exception 'rollback: F should be cleared';
  end if;
  if (select homeowner_contact_id from public.properties where id='b0000000-0000-0000-0000-00000000000e') <> 'c0000000-0000-0000-0000-0000000000e1' then
    raise exception 'rollback: a homeowner changed since must be kept';
  end if;
end $$;
\echo ROLLBACK (post-backfill) OK

-- Leave the stack in the migrated state.
\i :FWD_FORWARD
\echo ALL SCENARIOS OK
