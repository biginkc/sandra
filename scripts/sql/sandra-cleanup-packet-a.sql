-- Sandra production cleanup packet A.
--
-- Safety contract: execute only through run-sandra-cleanup-packet.mjs.
-- The runner pins the production endpoint and supplies the reviewed commit arm.

begin isolation level repeatable read;
set local role postgres;
set local search_path = public, extensions, pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local idle_in_transaction_session_timeout = '60s';

do $$
declare
  v_count bigint;
  v_hash text;
begin
  select count(*), encode(digest(coalesce(string_agg(to_jsonb(m)::text, E'\n' order by org_id, user_id), ''), 'sha256'), 'hex')
  into v_count, v_hash
  from public.memberships m;
  if v_count <> 9 or v_hash <> '2685f7bf1a4b27077ced69006454df9d5f005b663c10ae7adc3ddaff9e92d3fd' then
    raise exception 'Sandra production identity fingerprint drift: count %, hash %', v_count, v_hash;
  end if;
end $$;

create temp table packet_a_results (
  operation text primary key,
  affected_rows bigint not null
) on commit drop;

create temp table packet_a_synthetic_properties on commit drop as
select p.id, p.homeowner_contact_id
from public.properties p
where p.org_id = '00000000-0000-0000-0000-000000000bbb'::uuid
  and p.market = 'Synthetic Test'
  and p.source = 'driving_for_dollars'
  and p.deleted_at = timestamptz '2026-06-17T18:21:18.714396Z'
  and p.created_at >= timestamptz '2026-05-15T04:02:54Z'
  and p.created_at < timestamptz '2026-05-15T04:02:56Z';

create temp table packet_a_synthetic_contacts on commit drop as
select distinct homeowner_contact_id as id
from packet_a_synthetic_properties
where homeowner_contact_id is not null;

create temp table packet_a_explicit_qa_properties (id uuid primary key) on commit drop;
insert into packet_a_explicit_qa_properties (id) values
  ('35fdf22f-7d43-4de3-8f14-dd3f19e25d63'),
  ('c0e278db-15f6-4639-aced-283de7d06c58'),
  ('e14c75d1-d444-4022-ace8-91a40bdd591d');

create temp table packet_a_explicit_qa_contacts (id uuid primary key) on commit drop;
insert into packet_a_explicit_qa_contacts (id) values
  ('65c13690-2640-4c13-8ff3-dd4db9e93aad');

-- Three exact current smoke records have no enrollments. The smoke sequence with
-- completed enrollments/messages (8847daf2-...) is deliberately excluded.
create temp table packet_a_sequences (id uuid primary key) on commit drop;
insert into packet_a_sequences (id) values
  ('47e4aa8f-274f-438b-b5db-bd21c6958dd8'),
  ('9693dc11-4a68-4785-ac65-ecdc785d342c'),
  ('fccef243-c4c9-441a-8bba-563496a91b5e');

create temp table packet_a_properties_union (id uuid primary key) on commit drop;
insert into packet_a_properties_union (id)
select id from packet_a_synthetic_properties
union all
select id from packet_a_explicit_qa_properties;

create temp table packet_a_synthetic_contacts_union (id uuid primary key) on commit drop;
insert into packet_a_synthetic_contacts_union (id)
select id from packet_a_synthetic_contacts
union all
select id from packet_a_explicit_qa_contacts;

do $$
declare
  v_count bigint;
  v_hash text;
begin
  select count(*), encode(digest(string_agg(id::text, ',' order by id), 'sha256'), 'hex')
    into v_count, v_hash
  from packet_a_synthetic_properties;
  if v_count <> 1326 or v_hash <> 'f4df908833443acb2fb2207b0e76dd586871035cfc747a82a21c3984ce0439e5' then
    raise exception 'Synthetic property manifest drift: count %, hash %', v_count, v_hash;
  end if;

  select count(*), encode(digest(string_agg(id::text, ',' order by id), 'sha256'), 'hex')
    into v_count, v_hash
  from packet_a_synthetic_contacts;
  if v_count <> 1326 or v_hash <> '08f96467e1834e11649b9328df21bf82f9f0c0cb71fb580ba5990b60f5ace1fe' then
    raise exception 'Synthetic contact manifest drift: count %, hash %', v_count, v_hash;
  end if;

  if exists (
    select 1
    from public.contacts c
    join packet_a_synthetic_contacts x using (id)
    where c.notes not like 'jitter-test-r1-apify-full-rotation;%'
       or c.phone_1 is not null or c.phone_2 is not null or c.phone_3 is not null
       or c.email is not null or c.do_not_contact or c.sms_opted_out or c.email_opted_out
  ) then
    raise exception 'Synthetic contact safety/provenance invariant failed';
  end if;

  if exists (
    select 1
    from public.properties p
    join packet_a_synthetic_properties x using (id)
    where p.notes not like 'jitter-test-r1-apify-full-rotation;%'
       or p.deleted_at is null or p.is_dnc_locked
       or p.assigned_user_id is not null
  ) then
    raise exception 'Synthetic property safety/provenance invariant failed';
  end if;

  select count(*) into v_count
  from public.lead_events e
  join packet_a_synthetic_properties x on x.id = e.property_id
  where e.event_type = 'lead_created'
    and e.actor_type = 'system'
    and e.source_type = 'properties.created';
  if v_count <> 1326 then
    raise exception 'Synthetic lead-event count drift: %', v_count;
  end if;

  select count(*), encode(digest(string_agg(e.id::text, ',' order by e.id), 'sha256'), 'hex')
    into v_count, v_hash
  from public.lead_events e
  join packet_a_synthetic_properties x on x.id = e.property_id;
  if v_count <> 1326 or v_hash <> '87dba28bf4e2041a20300e4535df16411edaccf51414629490a9a92d543a67a5' then
    raise exception 'Synthetic lead-event manifest drift: count %, hash %', v_count, v_hash;
  end if;

  if exists (
    select 1
    from public.lead_events e
    join packet_a_synthetic_properties x on x.id = e.property_id
    where e.event_type <> 'lead_created'
       or e.actor_type <> 'system'
       or e.source_type <> 'properties.created'
  ) then
    raise exception 'Synthetic lead-event provenance changed';
  end if;

  -- Any operational or compliance reference rejects the packet.
  if exists (select 1 from public.messages r join packet_a_synthetic_properties x on x.id=r.property_id)
    or exists (select 1 from public.message_threads r join packet_a_synthetic_properties x on x.id=r.property_id)
    or exists (select 1 from public.call_activities r join packet_a_synthetic_properties x on x.id=r.property_id)
    or exists (select 1 from public.tasks r join packet_a_synthetic_properties x on x.id=r.related_property_id)
    or exists (select 1 from public.sequence_enrollments r join packet_a_synthetic_properties x on x.id=r.property_id)
    or exists (select 1 from public.dialer_batch_items r join packet_a_synthetic_properties x on x.id=r.property_id)
    or exists (select 1 from public.campaign_recipients r join packet_a_synthetic_properties x on x.id=r.property_id)
    or exists (select 1 from public.property_tags r join packet_a_synthetic_properties x on x.id=r.property_id)
    or exists (select 1 from public.property_lists r join packet_a_synthetic_properties x on x.id=r.property_id)
    or exists (select 1 from public.consent_events r join packet_a_synthetic_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.sms_phone_suppressions r join packet_a_synthetic_contacts x on x.id=r.first_contact_id)
    or exists (select 1 from public.jobs j join public.job_items r on r.job_id=j.id join packet_a_synthetic_properties x on x.id=r.property_id)
    or exists (select 1 from public.agent_details r join packet_a_synthetic_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.ai_response_claims r join packet_a_synthetic_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.csv_import_consent_outcomes r join packet_a_synthetic_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.homeowner_details r join packet_a_synthetic_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.job_items r join packet_a_synthetic_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.sms_inbound_intents r join packet_a_synthetic_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.ai_disposition_reviews r join packet_a_synthetic_properties x on x.id=r.property_id)
    or exists (select 1 from public.ai_response_claims r join packet_a_synthetic_properties x on x.id=r.property_id)
    or exists (select 1 from public.cass_property_lookup_outcomes r join packet_a_synthetic_properties x on x.id=r.property_id)
    or exists (select 1 from public.closer_practice_outcomes r join packet_a_synthetic_properties x on x.id=r.property_id)
    or exists (select 1 from public.coach_call_index r join packet_a_synthetic_properties x on x.id=r.property_id)
    or exists (select 1 from public.csv_import_row_outcomes r join packet_a_synthetic_properties x on x.id=r.property_id)
    or exists (select 1 from public.esign_requests r join packet_a_synthetic_properties x on x.id=r.property_id)
    or exists (select 1 from public.lead_files r join packet_a_synthetic_properties x on x.id=r.property_id)
    or exists (select 1 from public.lead_notes r join packet_a_synthetic_properties x on x.id=r.property_id)
    or exists (select 1 from public.property_merges r join packet_a_synthetic_properties x on x.id=r.keeper_id)
    or exists (select 1 from public.property_merges r join packet_a_synthetic_properties x on x.id=r.loser_id)
    or exists (select 1 from public.sms_inbound_intents r join packet_a_synthetic_properties x on x.id=r.property_id)
  then
    raise exception 'Synthetic cohort gained an operational/compliance reference';
  end if;

  select count(*), encode(digest(string_agg(p.id::text, ',' order by p.id), 'sha256'), 'hex')
    into v_count, v_hash
  from public.properties p join packet_a_explicit_qa_properties x using(id);
  if v_count <> 3 or v_hash <> '990f2227a53d4da9cda9798e0f24417e4b9d9807d3f84cb269a6fff915a58708' then
    raise exception 'Explicit QA property manifest drift: count %, hash %', v_count, v_hash;
  end if;
  if exists (
    select 1
    from public.properties p
    join packet_a_explicit_qa_properties x using(id)
    where p.org_id <> '00000000-0000-0000-0000-000000000bbb'::uuid
       or p.deleted_at is not null
       or p.is_dnc_locked
       or p.created_at < timestamptz '2026-09-01T20:06:28Z'
       or p.created_at >= timestamptz '2026-09-02T16:42:39Z'
       or (p.id='35fdf22f-7d43-4de3-8f14-dd3f19e25d63' and p.address <> '123 test for QA')
       or (p.id='c0e278db-15f6-4639-aced-283de7d06c58' and p.address <> '123 QA TEST 2')
       or (p.id='e14c75d1-d444-4022-ace8-91a40bdd591d' and p.address <> '001 Test Lead QA')
  ) then
    raise exception 'Explicit QA identity, scope, or lifecycle changed';
  end if;
  select count(*), encode(digest(string_agg(e.id::text, ',' order by e.id), 'sha256'), 'hex')
    into v_count, v_hash
  from public.lead_events e join packet_a_explicit_qa_properties x on x.id=e.property_id;
  if v_count <> 4 or v_hash <> '96b34815aee49014e4d67dafe1b92455f4576468b054b70352375b1c29c86b77' then
    raise exception 'Explicit QA lead-event manifest drift: count %, hash %', v_count, v_hash;
  end if;
  select count(*), encode(digest(string_agg(t.id::text, ',' order by t.id), 'sha256'), 'hex')
    into v_count, v_hash
  from public.tasks t join packet_a_explicit_qa_properties x on x.id=t.related_property_id;
  if v_count <> 1 or v_hash <> 'db74795b891a652656dca3207f5481a1655b3c7d7a708f0ccdd6da408929bd0b' then
    raise exception 'Explicit QA task manifest drift: count %, hash %', v_count, v_hash;
  end if;
  if exists (select 1 from public.messages r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.message_threads r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.call_activities r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.sequence_enrollments r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.dialer_batch_items r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.campaign_recipients r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.property_tags r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.property_lists r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.ai_disposition_reviews r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.ai_response_claims r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.cass_property_lookup_outcomes r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.closer_practice_outcomes r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.coach_call_index r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.csv_import_row_outcomes r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.esign_requests r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.job_items r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.lead_files r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.lead_notes r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.property_merges r join packet_a_explicit_qa_properties x on x.id=r.keeper_id)
    or exists (select 1 from public.property_merges r join packet_a_explicit_qa_properties x on x.id=r.loser_id)
    or exists (select 1 from public.sms_inbound_intents r join packet_a_explicit_qa_properties x on x.id=r.property_id)
    or exists (select 1 from public.agent_details r join packet_a_explicit_qa_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.ai_response_claims r join packet_a_explicit_qa_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.call_activities r join packet_a_explicit_qa_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.campaign_recipients r join packet_a_explicit_qa_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.closer_practice_outcomes r join packet_a_explicit_qa_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.consent_events r join packet_a_explicit_qa_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.csv_import_consent_outcomes r join packet_a_explicit_qa_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.dialer_batch_items r join packet_a_explicit_qa_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.homeowner_details r join packet_a_explicit_qa_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.job_items r join packet_a_explicit_qa_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.message_threads r join packet_a_explicit_qa_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.messages r join packet_a_explicit_qa_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.sequence_enrollments r join packet_a_explicit_qa_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.sms_inbound_intents r join packet_a_explicit_qa_contacts x on x.id=r.contact_id)
    or exists (select 1 from public.sms_phone_suppressions r join packet_a_explicit_qa_contacts x on x.id=r.first_contact_id)
    or exists (select 1 from public.tasks r join packet_a_explicit_qa_contacts x on x.id=r.contact_id)
  then
    raise exception 'Explicit QA property gained an operational/provider reference';
  end if;

  if (select count(*) from public.sequences s join packet_a_sequences x using(id)) <> 3
    or exists (select 1 from public.sequence_enrollments e join packet_a_sequences x on x.id=e.sequence_id)
    or exists (select 1 from public.csv_import_job_provenance p join packet_a_sequences x on x.id=p.sequence_id)
    or (select count(*) from public.sequence_steps st join packet_a_sequences x on x.id=st.sequence_id) <> 3
  then
    raise exception 'Sequence artifact manifest/dependency drift';
  end if;

  select count(*), encode(digest(string_agg(st.id::text, ',' order by st.id), 'sha256'), 'hex')
    into v_count, v_hash
  from public.sequence_steps st join packet_a_sequences x on x.id=st.sequence_id;
  if v_count <> 3 or v_hash <> 'a8ed590295909e53b1563739184467cd4ddb4c6c2e0affca7ec143804ca57b4e' then
    raise exception 'Sequence-step manifest drift: count %, hash %', v_count, v_hash;
  end if;

  select encode(
    digest(string_agg(to_jsonb(s)::text, chr(30) order by s.id), 'sha256'),
    'hex'
  ) into v_hash
  from public.sequences s
  join packet_a_sequences x using (id);
  if v_hash <> 'fd99eb349c7ed1786f93ae3b4ce80ea5721d1772bb0fac6468bb840131750226'
    or exists (
      select 1
      from public.sequences s
      join packet_a_sequences x using (id)
      where s.org_id <> '00000000-0000-0000-0000-000000000bbb'::uuid
         or not s.active
         or s.archived_at is not null
         or s.name not like 'SMOKE TEST — safe to delete %'
         or s.description <> 'One-off prod smoke; script deletes this when it exits'
    )
  then
    raise exception 'Deletable smoke sequence identity/provenance digest drift';
  end if;

  if (select count(*) from public.sequence_enrollments where sequence_id='8847daf2-3a65-44f3-821e-b491a6c6a877') <> 3
    or (select count(*) from public.sequence_enrollments where sequence_id='8847daf2-3a65-44f3-821e-b491a6c6a877' and status='completed') <> 3
  then
    raise exception 'Retained smoke sequence history drift';
  end if;

  select encode(digest(to_jsonb(s)::text, 'sha256'), 'hex') into v_hash
  from public.sequences s
  where s.id='8847daf2-3a65-44f3-821e-b491a6c6a877'::uuid;
  if v_hash <> '3d0488ce27e858d1b3f685fcc63c3c50b966f486efb34f4ee33a57f3f6bfbd45'
    or exists (
      select 1 from public.sequences s
      where s.id='8847daf2-3a65-44f3-821e-b491a6c6a877'::uuid
        and (
          s.org_id <> '00000000-0000-0000-0000-000000000bbb'::uuid
          or not s.active
          or s.archived_at is not null
          or s.name not like 'SMOKE TEST — safe to delete %'
          or s.description <> 'One-off prod smoke; script deletes this when it exits'
        )
    )
  then
    raise exception 'Retained smoke sequence identity/provenance digest drift';
  end if;
end $$;

-- Catalog-derived final dependency gate. Every current foreign key to a row
-- being removed is checked in the same transaction. Only the child rows that
-- this reviewed packet itself deletes are allowed; any new table or reference
-- added after review fails closed, including ON DELETE CASCADE relationships.
do $$
declare
  dependency record;
  v_count bigint;
  v_expected bigint;
  v_target_table text;
begin
  for dependency in
    select
      child_ns.nspname as child_schema,
      child.relname as child_table,
      parent.relname as parent_table,
      child_att.attname as child_column
    from pg_constraint constraint_row
    join pg_class child on child.oid=constraint_row.conrelid
    join pg_namespace child_ns on child_ns.oid=child.relnamespace
    join pg_class parent on parent.oid=constraint_row.confrelid
    join pg_namespace parent_ns on parent_ns.oid=parent.relnamespace
    join lateral unnest(constraint_row.conkey, constraint_row.confkey)
      with ordinality as columns(child_num, parent_num, ordinal) on true
    join pg_attribute child_att on child_att.attrelid=child.oid and child_att.attnum=columns.child_num
    join pg_attribute parent_att on parent_att.attrelid=parent.oid and parent_att.attnum=columns.parent_num
    where constraint_row.contype='f'
      and child_ns.nspname='public'
      and parent_ns.nspname='public'
      and parent.relname=any(array['contacts','properties','sequences'])
      and parent_att.attname='id'
  loop
    v_target_table := case dependency.parent_table
      when 'contacts' then 'packet_a_synthetic_contacts_union'
      when 'properties' then 'packet_a_properties_union'
      when 'sequences' then 'packet_a_sequences'
    end;

    -- Build the two union target tables lazily below before this block.
    execute format(
      'select count(*) from %I.%I child where child.%I in (select id from %I)',
      dependency.child_schema,
      dependency.child_table,
      dependency.child_column,
      v_target_table
    ) into v_count;

    v_expected := case
      when dependency.child_table='properties' and dependency.child_column='homeowner_contact_id' and dependency.parent_table='contacts' then 1327
      when dependency.child_table='lead_events' and dependency.child_column='property_id' and dependency.parent_table='properties' then 1330
      when dependency.child_table='tasks' and dependency.child_column='related_property_id' and dependency.parent_table='properties' then 1
      when dependency.child_table='sequence_steps' and dependency.child_column='sequence_id' and dependency.parent_table='sequences' then 3
      else 0
    end;
    if v_count <> v_expected then
      raise exception 'Foreign-key dependency drift %.% -> %: expected %, got %',
        dependency.child_table, dependency.child_column, dependency.parent_table,
        v_expected, v_count;
    end if;
  end loop;
end $$;

with deleted as (
  delete from public.lead_events e
  using packet_a_synthetic_properties x
  where e.property_id = x.id
  returning 1
)
insert into packet_a_results select 'synthetic_lead_events_deleted', count(*) from deleted;

with deleted as (
  delete from public.lead_events e
  using packet_a_explicit_qa_properties x
  where e.property_id = x.id
  returning 1
)
insert into packet_a_results select 'explicit_qa_lead_events_deleted', count(*) from deleted;

with deleted as (
  delete from public.tasks t
  using packet_a_explicit_qa_properties x
  where t.related_property_id = x.id
  returning 1
)
insert into packet_a_results select 'explicit_qa_tasks_deleted', count(*) from deleted;

with deleted as (
  delete from public.properties p
  using packet_a_synthetic_properties x
  where p.id = x.id
  returning 1
)
insert into packet_a_results select 'synthetic_properties_deleted', count(*) from deleted;

with deleted as (
  delete from public.properties p
  using packet_a_explicit_qa_properties x
  where p.id = x.id
  returning 1
)
insert into packet_a_results select 'explicit_qa_properties_deleted', count(*) from deleted;

with deleted as (
  delete from public.contacts c
  using packet_a_synthetic_contacts x
  where c.id = x.id
  returning 1
)
insert into packet_a_results select 'synthetic_contacts_deleted', count(*) from deleted;

-- This is the sole homeowner contact used only by an explicit QA property.
-- The shared Mel contact on the other two QA properties is intentionally kept.
with deleted as (
  delete from public.contacts c
  where c.id = '65c13690-2640-4c13-8ff3-dd4db9e93aad'
    and not exists (select 1 from public.properties p where p.homeowner_contact_id=c.id or p.agent_contact_id=c.id)
    and not exists (select 1 from public.messages m where m.contact_id=c.id)
    and not exists (select 1 from public.call_activities a where a.contact_id=c.id)
    and not exists (select 1 from public.tasks t where t.contact_id=c.id)
    and not exists (select 1 from public.consent_events e where e.contact_id=c.id)
    and not exists (select 1 from public.sms_phone_suppressions s where s.first_contact_id=c.id)
  returning 1
)
insert into packet_a_results select 'explicit_qa_contacts_deleted', count(*) from deleted;

with deleted as (
  delete from public.sequence_steps st
  using packet_a_sequences x
  where st.sequence_id = x.id
  returning 1
)
insert into packet_a_results select 'unused_sequence_steps_deleted', count(*) from deleted;

with deleted as (
  delete from public.sequences s
  using packet_a_sequences x
  where s.id = x.id
  returning 1
)
insert into packet_a_results select 'unused_sequences_deleted', count(*) from deleted;

-- Preserve the sequence and its completed enrollment/provider history, while
-- removing it from active selection surfaces.
with updated as (
  update public.sequences
  set active=false, archived_at=coalesce(archived_at, now()), updated_at=now()
  where id='8847daf2-3a65-44f3-821e-b491a6c6a877'
    and active=true
  returning 1
)
insert into packet_a_results select 'linked_smoke_sequences_archived', count(*) from updated;

do $$
declare
  v_actual jsonb;
  v_expected constant jsonb := jsonb_build_object(
    'explicit_qa_contacts_deleted', 1,
    'explicit_qa_lead_events_deleted', 4,
    'explicit_qa_properties_deleted', 3,
    'explicit_qa_tasks_deleted', 1,
    'linked_smoke_sequences_archived', 1,
    'synthetic_contacts_deleted', 1326,
    'synthetic_lead_events_deleted', 1326,
    'synthetic_properties_deleted', 1326,
    'unused_sequence_steps_deleted', 3,
    'unused_sequences_deleted', 3
  );
begin
  select jsonb_object_agg(operation, affected_rows order by operation)
  into v_actual
  from packet_a_results;
  if v_actual <> v_expected then
    raise exception 'Packet A affected-row mismatch: %', v_actual;
  end if;
end $$;

select jsonb_build_object(
  'mode', 'ROLLBACK_REHEARSAL',
  'project_ref', 'copflsklaefwzipsrjqz',
  'result', (select jsonb_object_agg(operation, affected_rows order by operation) from packet_a_results)
) as packet_a_rehearsal;

rollback;
