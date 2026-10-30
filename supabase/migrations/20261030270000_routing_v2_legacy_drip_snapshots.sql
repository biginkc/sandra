-- Ordered after the existing 250000/260000 routing migrations, not wall-clock time.
-- Snapshot unchanged legacy roads so v2 enrollments keep v2 send-time flag guards.
-- Never change a legacy sequence/enrollment or enable a flag. No automatic chaining.
begin;
set local lock_timeout = '5s';
set local routing_v2.allow_drip_edit = 'on';

alter table public.sequences drop constraint sequences_routing_v2_key_check;
alter table public.sequences add constraint sequences_routing_v2_key_check check (
  (routing_v2_key is null and routing_v2_version is null and routing_v2_then_key is null)
  or (routing_v2_key in ('price_too_high','said_theyd_call','vacant_land','book_appointment',
      'listed_not_selling','maybe_later','not_interested','asked_who','confirmed_owner')
    and routing_v2_version is not null and routing_v2_version >= 1
    and (routing_v2_then_key is null or routing_v2_then_key in
      ('price_too_high','said_theyd_call','vacant_land','book_appointment','listed_not_selling')))
);

do $$
declare
  r record;
  d record;
  source_id uuid;
  target_id uuid;
begin
  for r in select distinct org_id from public.ai_responder_configs loop
    for d in select * from (values
      ('maybe_later','Maybe later'), ('not_interested','Not interested'),
      ('asked_who','Asked who is texting'), ('confirmed_owner','Confirmed owner')
    ) as roads(key,name) loop
      continue when exists (select 1 from public.sequences
        where org_id=r.org_id and routing_v2_key=d.key);
      -- Same unambiguous exact-name choice as the existing nine-question engine.
      select s.id into source_id from public.sequences s
        where s.org_id=r.org_id and s.name=d.name and s.archived_at is null
          and s.routing_v2_key is null
          and (select count(*) from public.sequences x where x.org_id=r.org_id
            and x.name=d.name and x.archived_at is null and x.routing_v2_key is null)=1;
      continue when source_id is null;
      continue when exists (select 1 from public.sequences where org_id=r.org_id
        and lower(name)=lower(d.name || ' (routing v2)') and archived_at is null);
      -- Refuse missing/gapped steps, template pools, empty text, foreign templates,
      -- or non-SMS actions; never silently discard part of an approved drip.
      continue when not exists (select 1 from public.sequence_steps where sequence_id=source_id);
      continue when exists (
        select 1 from (
          select st.*, row_number() over(order by step_index)-1 as expected_index
          from public.sequence_steps st where sequence_id=source_id
        ) st left join public.sms_templates t
          on t.id=st.template_id and t.org_id=r.org_id and t.deleted_at is null
        where st.step_index<>st.expected_index or st.action_type<>'send_sms'
          or st.template_category is not null
          or (st.template_id is not null and t.id is null)
          or nullif(btrim(coalesce(st.template_body,t.content)), '') is null
      );
      insert into public.sequences
        (org_id,name,description,active,append_opt_out,routing_v2_key,routing_v2_version,routing_v2_then_key)
      select org_id,d.name || ' (routing v2)',
        'Immutable routing-v2 snapshot of existing approved drip; seeded inactive.',
        false,append_opt_out,d.key,1,null from public.sequences where id=source_id
      returning id into target_id;
      insert into public.sequence_steps
        (sequence_id,step_index,delay_after_previous_minutes,action_type,template_body,target_status,slot_window)
      select target_id,st.step_index,st.delay_after_previous_minutes,st.action_type,
        coalesce(st.template_body,t.content),st.target_status,st.slot_window
      from public.sequence_steps st left join public.sms_templates t
        on t.id=st.template_id and t.org_id=r.org_id and t.deleted_at is null
      where st.sequence_id=source_id;
    end loop;
  end loop;
end $$;
commit;
