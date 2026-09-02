-- Sandra production cleanup packet A.
--
-- Safety contract:
--   1. Run with `rollback` (the default final statement) for rehearsal.
--   2. The target project must be independently verified as
--      copflsklaefwzipsrjqz before execution.
--   3. Compare every expected count and SHA-256 with the sealed manifest.
--   4. Only after exact-head Fable approval may the final `rollback` be
--      replaced with `commit` for one authorized execution.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local idle_in_transaction_session_timeout = '60s';

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
    or exists (select 1 from public.sms_inbound_intents r join packet_a_synthetic_properties x on x.id=r.property_id)
  then
    raise exception 'Synthetic cohort gained an operational/compliance reference';
  end if;

  if (select count(*) from public.properties p join packet_a_explicit_qa_properties x using(id)) <> 3 then
    raise exception 'Explicit QA property manifest drift';
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
  if (select count(*) from public.lead_events e join packet_a_explicit_qa_properties x on x.id=e.property_id) <> 4 then
    raise exception 'Explicit QA lead-event count drift';
  end if;
  if (select count(*) from public.tasks t join packet_a_explicit_qa_properties x on x.id=t.related_property_id) <> 1 then
    raise exception 'Explicit QA task count drift';
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

  if (select count(*) from public.sequence_enrollments where sequence_id='8847daf2-3a65-44f3-821e-b491a6c6a877') <> 3
    or (select count(*) from public.sequence_enrollments where sequence_id='8847daf2-3a65-44f3-821e-b491a6c6a877' and status='completed') <> 3
  then
    raise exception 'Retained smoke sequence history drift';
  end if;
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
