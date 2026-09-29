-- PR-8 drip read-model parity. The send cutoff is message.sent_at; run_at is
-- used only when sent_at is null, including legacy step-run rows.
set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.sequence_overview_stats(p_org uuid)
returns table (
  id uuid, name text, description text, active boolean, append_opt_out boolean,
  archived_at timestamptz, created_at timestamptz, created_by uuid,
  step_count bigint, active_enrollment_count bigint,
  waiting bigint, replied bigint, finished_no_reply bigint,
  couldnt_send bigint, stopped bigint, last_sent timestamptz
)
language plpgsql security definer set search_path = '' set statement_timeout = '5s'
as $$
begin
  if p_org is null or auth.uid() is null or not exists (
    select 1 from public.memberships m where m.org_id = p_org and m.user_id = auth.uid()
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return query
  select s.id, s.name, s.description, s.active, s.append_opt_out, s.archived_at,
    s.created_at, s.created_by,
    (select count(*) from public.sequence_steps ss where ss.sequence_id = s.id),
    (select count(*) from public.sequence_enrollments e where e.sequence_id = s.id
      and e.org_id = p_org and e.status in ('active','paused')),
    (select count(*) from public.sequence_enrollments e where e.sequence_id = s.id
      and e.org_id = p_org and e.status = 'active'),
    (select count(*) from public.sequence_enrollments e where e.sequence_id = s.id
      and e.org_id = p_org and e.status = 'paused'
      and e.pause_reason in ('inbound_reply','rep_sms_human_takeover')),
    (select count(*) from public.sequence_enrollments e where e.sequence_id = s.id
      and e.org_id = p_org and e.status = 'completed'
      and not exists (select 1 from public.lead_events le where le.org_id = p_org
        and le.property_id = e.property_id and le.event_type = 'sequence_canceled'
        and le.source_id = e.id)
      and not exists (select 1 from public.messages msg where msg.org_id = p_org
        and msg.property_id = e.property_id and msg.direction = 'inbound'
        and msg.created_at > coalesce((select max(coalesce(sent.sent_at, sr.run_at)) from public.sequence_step_runs sr
          left join public.messages sent on sent.id = sr.message_id and sent.org_id = p_org
          where sr.enrollment_id = e.id and sr.message_id is not null), e.enrolled_at))),
    (select count(*) from public.sequence_enrollments e where e.sequence_id = s.id
      and e.org_id = p_org and e.status = 'paused'
      and e.pause_reason in ('provider_failed','reconciliation_required','template_missing','step_misconfigured','no_phone','no_approved_sender','no approved sender for first-touch sequence send')),
    (select count(*) from public.sequence_enrollments e where e.sequence_id = s.id
      and e.org_id = p_org and (e.status = 'opted_out' or
        (e.status = 'completed' and exists (select 1 from public.lead_events le
          where le.org_id = p_org and le.property_id = e.property_id
            and le.event_type = 'sequence_canceled' and le.source_id = e.id)))),
    (select max(coalesce(sent.sent_at, sr.run_at)) from public.sequence_enrollments e
      join public.sequence_step_runs sr on sr.enrollment_id = e.id
      left join public.messages sent on sent.id = sr.message_id and sent.org_id = p_org
      where e.sequence_id = s.id and e.org_id = p_org and sr.message_id is not null)
  from public.sequences s where s.org_id = p_org
  order by s.created_at desc, s.id desc limit 500;
end;
$$;
revoke all on function public.sequence_overview_stats(uuid) from public, anon, service_role;
grant execute on function public.sequence_overview_stats(uuid) to authenticated;


create or replace function public.sequence_needs_person(p_org uuid)
returns table (property_id uuid, sequence_id uuid, bucket text, reason text, sequence_created_by uuid)
language plpgsql security definer set search_path = '' set statement_timeout = '5s'
as $$
begin
  if p_org is null or auth.uid() is null or not exists (
    select 1 from public.memberships m where m.org_id = p_org and m.user_id = auth.uid()
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return query
  with latest_enrollments as (
    select distinct on (e.property_id) e.*
    from public.sequence_enrollments e
    where e.org_id = p_org
    order by e.property_id, e.enrolled_at desc, e.id desc
  ), candidates as (
    select e.property_id, e.sequence_id, 'finished_no_reply'::text as bucket,
      'Finished, no reply'::text as reason, 1 as priority
    from latest_enrollments e
    where e.status = 'completed'
      and not exists (select 1 from public.lead_events le where le.org_id = p_org
        and le.property_id = e.property_id and le.event_type = 'sequence_canceled'
        and le.source_id = e.id)
      and not exists (select 1 from public.messages msg where msg.org_id = p_org
        and msg.property_id = e.property_id and msg.direction = 'inbound'
        and msg.created_at > coalesce((select max(coalesce(sent.sent_at, sr.run_at)) from public.sequence_step_runs sr
          left join public.messages sent on sent.id = sr.message_id and sent.org_id = p_org
          where sr.enrollment_id = e.id and sr.message_id is not null), e.enrolled_at))
    union all
    select e.property_id, e.sequence_id, 'couldnt_send'::text, 'Couldn''t send'::text, 2
    from latest_enrollments e where e.status = 'paused'
      and e.pause_reason in ('provider_failed','reconciliation_required','template_missing','step_misconfigured','no_phone','no_approved_sender','no approved sender for first-touch sequence send')
    union all
    select p.id, null::uuid, 'needs_sequence'::text, 'Needs a sequence'::text, 3
    from public.properties p where p.org_id = p_org and p.outreach_dispo = 'needs_sequence'
      and p.deleted_at is null and p.is_dnc_locked is not true
      and exists (select 1 from public.messages inbound where inbound.org_id = p_org
        and inbound.property_id = p.id and inbound.direction = 'inbound')
      and not exists (select 1 from latest_enrollments e
        where e.property_id = p.id and e.status in ('active','paused'))
  )
  select distinct on (c.property_id) c.property_id, c.sequence_id, c.bucket, c.reason, s.created_by
  from candidates c join public.properties p on p.id = c.property_id and p.org_id = p_org
  left join public.sequences s on s.id = c.sequence_id and s.org_id = p_org
  where p.deleted_at is null and p.status <> 'dead'
  order by c.property_id, c.priority;
end;
$$;
revoke all on function public.sequence_needs_person(uuid) from public, anon, service_role;
grant execute on function public.sequence_needs_person(uuid) to authenticated;

create or replace function public.sequence_needs_person_counts(p_org uuid, p_exclude_created_by uuid default null)
returns table (finished_no_reply bigint, couldnt_send bigint, needs_sequence bigint)
language plpgsql security definer set search_path = '' set statement_timeout = '5s'
as $$
begin
  if p_org is null or auth.uid() is null or not exists (
    select 1 from public.memberships m where m.org_id = p_org and m.user_id = auth.uid()
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return query
    select count(*) filter (where n.bucket = 'finished_no_reply'),
      count(*) filter (where n.bucket = 'couldnt_send'),
      count(*) filter (where n.bucket = 'needs_sequence')
    from public.sequence_needs_person(p_org) n
    where p_exclude_created_by is null or n.sequence_created_by is distinct from p_exclude_created_by;
end;
$$;
revoke all on function public.sequence_needs_person_counts(uuid, uuid) from public, anon, service_role;
grant execute on function public.sequence_needs_person_counts(uuid, uuid) to authenticated;

create or replace function public.sequence_needs_person_page(
  p_org uuid, p_bucket text, p_offset integer, p_limit integer, p_exclude_created_by uuid default null
)
returns table (property_id uuid, sequence_id uuid, bucket text, reason text, sequence_created_by uuid)
language plpgsql security definer set search_path = '' set statement_timeout = '5s'
as $$
begin
  if p_org is null or auth.uid() is null or not exists (
    select 1 from public.memberships m where m.org_id = p_org and m.user_id = auth.uid()
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_bucket not in ('finished_no_reply', 'couldnt_send', 'needs_sequence')
    or p_bucket is null or p_offset is null or p_offset < 0
    or p_limit is null or p_limit < 1 or p_limit > 100
  then raise exception 'Invalid needs-person page' using errcode = '22023'; end if;
  return query
    select n.property_id, n.sequence_id, n.bucket, n.reason, n.sequence_created_by
    from public.sequence_needs_person(p_org) n
    where n.bucket = p_bucket
      and (p_exclude_created_by is null or n.sequence_created_by is distinct from p_exclude_created_by)
    order by n.property_id
    limit p_limit offset p_offset;
end;
$$;
revoke all on function public.sequence_needs_person_page(uuid, text, integer, integer, uuid) from public, anon, service_role;
grant execute on function public.sequence_needs_person_page(uuid, text, integer, integer, uuid) to authenticated;

create or replace function public.sequence_step_stats(p_org uuid, p_sequence uuid)
returns table (step_id uuid, sent bigint, replied bigint, waiting bigint)
language plpgsql security definer set search_path = '' set statement_timeout = '5s'
as $$
begin
  if p_org is null or p_sequence is null or auth.uid() is null or not exists (
    select 1 from public.memberships m where m.org_id = p_org and m.user_id = auth.uid()
      and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if not exists (select 1 from public.sequences s where s.id = p_sequence and s.org_id = p_org)
  then raise exception 'SEQUENCE_NOT_FOUND' using errcode = 'P0002'; end if;

  return query
  select st.id,
    count(distinct sr.enrollment_id) filter (where sr.message_id is not null and coalesce(msg.sent_at, sr.run_at) is not null)::bigint,
    count(distinct sr.enrollment_id) filter (where sr.message_id is not null and coalesce(msg.sent_at, sr.run_at) is not null and exists (
      select 1 from public.messages inbound
      where inbound.org_id = p_org and inbound.property_id = e.property_id
        and inbound.direction = 'inbound' and inbound.created_at > coalesce(msg.sent_at, sr.run_at)
        and not exists (
          select 1 from public.sequence_step_runs later_run
          join public.messages later_msg on later_msg.id = later_run.message_id
          where later_run.enrollment_id = e.id and coalesce(later_msg.sent_at, later_run.run_at) is not null
            and coalesce(later_msg.sent_at, later_run.run_at) > coalesce(msg.sent_at, sr.run_at) and coalesce(later_msg.sent_at, later_run.run_at) <= inbound.created_at
        )
    ))::bigint,
    count(distinct e.id) filter (where e.status = 'active'
      and e.current_step_index = st.step_index + 1 and sr.message_id is not null
      and coalesce(msg.sent_at, sr.run_at) is not null)::bigint
  from public.sequence_steps st
  left join public.sequence_enrollments e on e.sequence_id = p_sequence and e.org_id = p_org
  left join public.sequence_step_runs sr on sr.enrollment_id = e.id and sr.step_id = st.id
  left join public.messages msg on msg.id = sr.message_id and msg.org_id = p_org
  where st.sequence_id = p_sequence
  group by st.id, st.step_index
  order by st.step_index;
end;
$$;
revoke all on function public.sequence_step_stats(uuid, uuid) from public, anon, service_role;
grant execute on function public.sequence_step_stats(uuid, uuid) to authenticated;


CREATE OR REPLACE FUNCTION public.sms_inbox_thread_page_snapshot(p_cutoff timestamp with time zone, p_filter text DEFAULT 'all'::text, p_assignee_id uuid DEFAULT NULL::uuid, p_include_thread_id uuid DEFAULT NULL::uuid, p_hide_noise boolean DEFAULT true, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0, p_search text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
  with search_input as (
    select case when length(btrim(p_search)) >= 3
      then left(btrim(p_search), 100) else null end as q
  ), search_bounds as (
    select q,
      replace(replace(replace(lower(q), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') as q_like,
      regexp_replace(q, '[^0-9]', '', 'g') as digits,
      public.search_prefix_tsquery(q) as tsq
    from search_input
  ), bounds as (
    select
      greatest(
        coalesce(p_cutoff, statement_timestamp() - interval '365 days'),
        statement_timestamp() - interval '365 days'
      ) as cutoff,
      least(greatest(coalesce(p_limit, 200), 1), 500) as page_limit,
      greatest(coalesce(p_offset, 0), 0) as requested_offset,
      case
        when p_filter in ('all', 'mine', 'unassigned', 'unread', 'escalated', 'dispo', 'needs_outcome', 'drip_replied', 'in_drip')
          then p_filter
        else 'all'
      end as active_filter
  ),
  visible_orgs as materialized (
    select membership.org_id
    from public.memberships membership
    where auth.role() = 'authenticated'
      and membership.user_id = auth.uid()
      and membership.access_status = 'active'
      and membership.deletion_prepared_at is null
      and (
        membership.access_expires_at is null
        or membership.access_expires_at > statement_timestamp()
      )
  ),
  pending_reviews as materialized (
    select
      review.id,
      review.org_id,
      review.property_id,
      review.conversation_id,
      review.source_inbound_message_id,
      review.disposition,
      review.ai_reason,
      review.status,
      review.created_at
    from public.ai_disposition_reviews review
    where review.status = 'pending'
      and (
        auth.role() = 'service_role'
        or review.org_id in (select visible.org_id from visible_orgs visible)
      )
  ),
  recent_eligible as not materialized (
    select
      m.id,
      m.org_id,
      m.conversation_id,
      m.contact_id,
      m.property_id,
      m.direction,
      m.read_at,
      m.created_at,
      m.from_address,
      m.to_address,
      row_number() over (
        partition by m.org_id, m.conversation_id
        order by m.created_at desc, m.id desc
      ) as latest_rank
    from public.messages m
    where m.channel = 'sms'
      and m.contact_id is not null
      and m.conversation_id is not null
      and m.status not in ('queued', 'paused')
      and m.created_at >= (select cutoff from bounds)
      and (
        auth.role() = 'service_role'
        or m.org_id in (select visible.org_id from visible_orgs visible)
      )
  ),
  recent_grouped as materialized (
    select
      e.org_id,
      e.conversation_id,
      (array_agg(e.id) filter (where e.latest_rank = 1))[1] as last_message_id,
      (array_agg(e.contact_id) filter (where e.latest_rank = 1))[1] as contact_id,
      coalesce(
        (array_agg(e.property_id order by e.created_at desc, e.id desc)
          filter (where e.property_id is not null))[1],
        (
          select review.property_id
          from pending_reviews review
          where review.org_id = e.org_id
            and review.conversation_id = e.conversation_id
          order by review.created_at desc, review.id desc
          limit 1
        )
      ) as property_id,
      count(*) filter (
        where e.direction = 'inbound' and e.read_at is null
      )::integer as unread_count,
      bool_or(e.direction = 'inbound') as has_inbound,
      true as has_recent,
      max(e.direction) filter (where e.latest_rank = 1) as last_message_direction,
      max(e.created_at) filter (where e.latest_rank = 1) as last_message_at,
      max(e.from_address) filter (where e.latest_rank = 1) as latest_from,
      max(e.to_address) filter (where e.latest_rank = 1) as latest_to
    from recent_eligible e
    group by e.org_id, e.conversation_id
  ),
  old_review_conversations as materialized (
    select review.*
    from pending_reviews review
    where not exists (
      select 1
      from recent_grouped recent
      where recent.org_id = review.org_id
        and recent.conversation_id = review.conversation_id
    )
  ),
  old_review_eligible as materialized (
    select
      m.id,
      m.org_id,
      m.conversation_id,
      m.contact_id,
      m.property_id,
      review.property_id as review_property_id,
      m.direction,
      m.read_at,
      m.created_at,
      m.from_address,
      m.to_address,
      row_number() over (
        partition by m.org_id, m.conversation_id
        order by m.created_at desc, m.id desc
      ) as latest_rank
    from old_review_conversations review
    join public.messages m
      on m.org_id = review.org_id
      and m.conversation_id = review.conversation_id
    where m.channel = 'sms'
      and m.contact_id is not null
      and m.status not in ('queued', 'paused')
  ),
  old_review_grouped as materialized (
    select
      e.org_id,
      e.conversation_id,
      (array_agg(e.id order by e.created_at desc, e.id desc))[1] as last_message_id,
      (array_agg(e.contact_id order by e.created_at desc, e.id desc))[1] as contact_id,
      (array_agg(e.review_property_id order by e.created_at desc, e.id desc))[1] as property_id,
      count(*) filter (
        where e.direction = 'inbound' and e.read_at is null
      )::integer as unread_count,
      bool_or(e.direction = 'inbound') as has_inbound,
      false as has_recent,
      max(e.direction) filter (where e.latest_rank = 1) as last_message_direction,
      max(e.created_at) filter (where e.latest_rank = 1) as last_message_at,
      max(e.from_address) filter (where e.latest_rank = 1) as latest_from,
      max(e.to_address) filter (where e.latest_rank = 1) as latest_to
    from old_review_eligible e
    group by e.org_id, e.conversation_id
  ),
  grouped as materialized (
    select recent.*
    from recent_grouped recent

    union all

    select review.*
    from old_review_grouped review
  ),
  conversation_ambiguities as (
    select case
      when auth.role() = 'authenticated'
        and (select count(*) from visible_orgs) <= 1
      then 0
      else (
        select count(*)::integer
        from (
          select m.conversation_id
          from public.messages m
          where m.channel = 'sms'
            and m.conversation_id in (
              select grouped_thread.conversation_id from grouped grouped_thread
            )
            and (
              auth.role() = 'service_role'
              or m.org_id in (select visible.org_id from visible_orgs visible)
            )
          group by m.conversation_id
          having count(distinct m.org_id) > 1
        ) collisions
      )
    end as ambiguity_count
  ),
  core as materialized (
    select
      g.*,
      coalesce(c.entity_name, nullif(concat_ws(' ', c.first_name, c.last_name), '')) as contact_name,
      c.do_not_contact,
      c.sms_opted_out,
      nullif(concat_ws(', ', p.address, p.city, p.state), '') as property_address,
      p.status as property_status,
      p.outreach_dispo,
      drip.drip_name,
      drip.drip_step,
      drip.drip_steps_total,
      coalesce(drip.drip_replied, false) as drip_replied,
      coalesce(drip.in_drip, false) as in_drip,
      p.is_dnc_locked,
      p.assigned_user_id,
      p.needs_human_attention,
      p.last_ai_escalation_reason,
      mt.ai_responder_status,
      ce.event_type as latest_consent_event,
      suppression.phone_e164 is not null as is_phone_suppressed,
      review.id as ai_disposition_review_id,
      review.status as ai_disposition_review_status,
      review.disposition as ai_disposition_review_disposition,
      review.ai_reason as ai_disposition_review_reason,
      review.created_at as ai_disposition_review_created_at,
      review.source_inbound_message_id as ai_disposition_review_source_inbound_message_id,
      case when g.last_message_direction = 'inbound' then g.latest_from else g.latest_to end as thread_customer_phone,
      case when g.last_message_direction = 'inbound' then g.latest_to else g.latest_from end as thread_business_phone
    from grouped g
    left join public.contacts c on c.id = g.contact_id and c.org_id = g.org_id
    left join public.properties p on p.id = g.property_id and p.org_id = g.org_id
    left join lateral (
      select seq.name as drip_name,
        enrollment.current_step_index + 1 as drip_step,
        (select count(*)::integer from public.sequence_steps step
         where step.sequence_id = enrollment.sequence_id) as drip_steps_total,
        enrollment.status in ('active', 'paused') as in_drip,
        reply.latest_reply is not null and not exists (
          select 1 from public.messages action where action.org_id = g.org_id
            and action.property_id = g.property_id and action.direction = 'outbound'
            and action.campaign_id is null and action.metadata->>'generated_by' is null
            and action.created_at > reply.latest_reply
            and not exists (select 1 from public.sequence_step_runs r where r.message_id = action.id)
        ) and not exists (
          select 1 from public.acquisition_attempts attempt where attempt.org_id = g.org_id
            and attempt.property_id = g.property_id and attempt.recorded_at > reply.latest_reply
        ) and not exists (
          select 1 from public.lead_events event where event.org_id = g.org_id
            and event.property_id = g.property_id and event.actor_type = 'user'
            and event.created_at > reply.latest_reply
            and (event.event_type = 'dispo_set' or (event.event_type = 'my_leads_workflow'
              and event.payload->>'operation' in ('ready_acquisition_offer', 'log_acquisition_offer',
                'record_acquisition_contract', 'decline_acquisition_offer', 'handoff_acquisition_lead',
                'log_acquisition_attempt')))
        ) as drip_replied
      from public.sequence_enrollments enrollment
      join public.sequences seq on seq.id = enrollment.sequence_id and seq.org_id = enrollment.org_id
      left join lateral (
        select max(inbound.created_at) as latest_reply
        from public.messages inbound
        join lateral (
          select prior.id, prior.direction from public.messages prior
          where prior.org_id = g.org_id and prior.property_id = g.property_id
            and (prior.created_at, prior.id) < (inbound.created_at, inbound.id)
            and (prior.direction = 'inbound' or (prior.direction = 'outbound'
              and (prior.metadata->>'generated_by' is distinct from 'ai_responder_v1'
                or exists (select 1 from public.sequence_step_runs drip_run
                  where drip_run.message_id = prior.id))))
          order by prior.created_at desc, prior.id desc limit 1
        ) prior on prior.direction = 'outbound'
        join public.sequence_step_runs run on run.message_id = prior.id
          and run.enrollment_id = enrollment.id
        where inbound.org_id = g.org_id and inbound.property_id = g.property_id
          and inbound.direction = 'inbound'
          and ((enrollment.status = 'paused' and enrollment.pause_reason in
            ('inbound_reply', 'rep_sms_human_takeover')) or enrollment.status = 'completed')
      ) reply on true
      where enrollment.property_id = g.property_id and enrollment.org_id = g.org_id
        and enrollment.status in ('active', 'paused', 'completed')
      order by case when enrollment.status in ('active', 'paused') then 0 else 1 end,
        enrollment.enrolled_at desc, enrollment.id desc
      limit 1
    ) drip on true
    left join pending_reviews review
      on review.org_id = g.org_id
      and review.conversation_id = g.conversation_id
      and review.property_id = g.property_id
    left join public.message_threads mt on mt.conversation_id = g.conversation_id and mt.org_id = g.org_id
    left join lateral (
      select consent.event_type
      from public.consent_events consent
      where consent.contact_id = g.contact_id
        and consent.org_id = g.org_id
        and consent.channel = 'sms'
        and consent.event_type in (
          'opt_in_marketing_written',
          'opt_in_informational',
          'opt_in_confirmed',
          'opt_out',
          'provider_auto_opt_out'
        )
      order by consent.occurred_at desc, consent.id desc
      limit 1
    ) ce on true
    left join lateral (
      select case
        when length(phone.digits) = 11 and left(phone.digits, 1) = '1'
          then '+' || phone.digits
        when length(phone.digits) = 10
          then '+1' || phone.digits
        else null
      end as phone_e164
      from (
        select regexp_replace(
          coalesce(case when g.last_message_direction = 'inbound' then g.latest_from else g.latest_to end, ''),
          '[^0-9]',
          '',
          'g'
        ) as digits
      ) phone
    ) normalized_phone on true
    left join public.sms_phone_suppressions suppression
      on suppression.org_id = g.org_id
      and suppression.channel = 'sms'
      and suppression.phone_e164 = normalized_phone.phone_e164
    cross join search_bounds search
    where (
      search.q is null
      or c.search_text ilike '%' || search.q_like || '%' escape E'\\'
      or (length(search.digits) >= 3 and c.phone_digits ilike '%' || search.digits || '%')
      or exists (
        select 1 from public.messages matching_message
        where matching_message.org_id = g.org_id
          and matching_message.conversation_id = g.conversation_id
          and matching_message.channel = 'sms'
          and matching_message.fts @@ search.tsq
      )
    ) -- messages_search_predicate
  ),
  ready as materialized (
    select
      c.*,
      coalesce(c.do_not_contact, false)
        or coalesce(c.sms_opted_out, false)
        or c.is_phone_suppressed
        or coalesce(c.latest_consent_event in ('opt_out', 'provider_auto_opt_out'), false) as is_opted_out,
      lower(trim(coalesce(c.contact_name, ''))) like 'canary canary-%%'
        or lower(trim(coalesce(c.property_address, ''))) like 'jitter %%'
        or lower(trim(coalesce(c.property_address, ''))) like 'jitter-%%' as is_test_traffic
    from core c
  ),
  classified as materialized (
    select
      r.*,
      r.property_id is not null
        and r.has_inbound
        and r.outreach_dispo is null
        and not r.is_opted_out
        and r.property_status in ('prospect', 'new_lead', 'contacted') as needs_outcome,
      coalesce(r.is_dnc_locked, false) or r.is_opted_out or r.is_test_traffic as is_noise
    from ready r
  ),
  counts as (
    select
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise))::integer as all_count,
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise) and c.property_status is not null and c.property_status <> 'prospect' and p_assignee_id is not null and c.assigned_user_id = p_assignee_id)::integer as mine_count,
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise) and c.property_status is not null and c.property_status <> 'prospect' and p_assignee_id is not null and c.assigned_user_id is null)::integer as unassigned_count,
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise) and c.unread_count > 0)::integer as unread_count,
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise) and c.ai_responder_status = 'escalated')::integer as escalated_count,
      count(*) filter (where c.ai_disposition_review_id is not null and not c.is_test_traffic)::integer as dispo_count,
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise) and c.needs_outcome)::integer as needs_outcome_count,
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise) and c.drip_replied)::integer as drip_replied_count,
      count(*) filter (where c.has_recent and (not p_hide_noise or not c.is_noise) and c.in_drip)::integer as in_drip_count
    from classified c
  ),
  active_unhidden as materialized (
    select c.*
    from classified c
    cross join bounds b
    where case b.active_filter
      when 'mine' then c.has_recent and c.property_status is not null and c.property_status <> 'prospect' and p_assignee_id is not null and c.assigned_user_id = p_assignee_id
      when 'unassigned' then c.has_recent and c.property_status is not null and c.property_status <> 'prospect' and p_assignee_id is not null and c.assigned_user_id is null
      when 'unread' then c.has_recent and (c.unread_count > 0 or c.conversation_id = p_include_thread_id)
      when 'escalated' then c.has_recent and c.ai_responder_status = 'escalated'
      when 'dispo' then c.ai_disposition_review_id is not null
      when 'needs_outcome' then c.has_recent and c.needs_outcome
      when 'drip_replied' then c.has_recent and c.drip_replied
      when 'in_drip' then c.has_recent and c.in_drip
      else c.has_recent
    end
  ),
  active_filtered as materialized (
    select active.*
    from active_unhidden active
    cross join bounds b
    where case b.active_filter
      -- Compliance outcomes are still actionable review work. Test fixtures
      -- never are, even when the caller asks to show ordinary hidden noise.
      when 'dispo' then not active.is_test_traffic
      else not p_hide_noise or not active.is_noise
    end
  ),
  page_meta as (
    select
      count(*)::integer as total_count,
      coalesce((select count(*) from active_unhidden), 0)::integer
        - count(*)::integer as hidden_count
    from active_filtered
  ),
  effective_page as (
    select
      b.page_limit,
      case
        when meta.total_count = 0 then 0
        else least(
          b.requested_offset,
          ((meta.total_count - 1) / b.page_limit) * b.page_limit
        )
      end as page_offset
    from bounds b cross join page_meta meta
  ),
  page_core as materialized (
    select active.*
    from active_filtered active
    order by active.last_message_at desc, active.conversation_id
    limit (select page_limit from effective_page)
    offset (select page_offset from effective_page)
  ),
  page_rows as (
    select
      page.*,
      last_message.body as last_message_body,
      thread.ai_responder_reason,
      thread.ai_responder_status_at,
      thread.ai_last_delivery_status,
      thread.ai_last_delivery_error
    from page_core page
    join public.messages last_message
      on last_message.id = page.last_message_id
      and last_message.org_id = page.org_id
      and last_message.conversation_id = page.conversation_id
    left join public.message_threads thread
      on thread.conversation_id = page.conversation_id
      and thread.org_id = page.org_id
  ),
  document as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'thread_id', row.conversation_id,
        'contact_id', row.contact_id,
        'contact_name', row.contact_name,
        'thread_customer_phone', row.thread_customer_phone,
        'thread_business_phone', row.thread_business_phone,
        'property_id', row.property_id,
        'property_address', row.property_address,
        'property_status', row.property_status,
        'outreach_dispo', row.outreach_dispo,
        'drip_name', row.drip_name,
        'drip_step', row.drip_step,
        'drip_steps_total', row.drip_steps_total,
        'drip_replied', row.drip_replied,
        'in_drip', row.in_drip,
        'is_dnc_locked', coalesce(row.is_dnc_locked, false),
        'assignee_id', row.assigned_user_id,
        'last_message_body', row.last_message_body,
        'last_message_direction', row.last_message_direction,
        'last_message_at', row.last_message_at,
        'unread_count', row.unread_count,
        'has_inbound', row.has_inbound,
        'needs_human_attention', coalesce(row.needs_human_attention, false),
        'escalation_reason', case when row.needs_human_attention then row.last_ai_escalation_reason else null end,
        'is_opted_out', row.is_opted_out,
        'is_test_traffic', row.is_test_traffic,
        'needs_outcome', row.needs_outcome,
        'ai_responder_status', row.ai_responder_status,
        'ai_responder_reason', row.ai_responder_reason,
        'ai_responder_status_at', row.ai_responder_status_at,
        'ai_last_delivery_status', row.ai_last_delivery_status,
        'ai_last_delivery_error', row.ai_last_delivery_error,
        'ai_disposition_review_id', row.ai_disposition_review_id,
        'ai_disposition_review_status', row.ai_disposition_review_status,
        'ai_disposition_review_disposition', row.ai_disposition_review_disposition,
        'ai_disposition_review_reason', row.ai_disposition_review_reason,
        'ai_disposition_review_created_at', row.ai_disposition_review_created_at,
        'ai_disposition_review_source_inbound_message_id', row.ai_disposition_review_source_inbound_message_id
      ) order by row.last_message_at desc, row.conversation_id
    ), '[]'::jsonb) as rows
    from page_rows row
  )
  select case
    when ambiguities.ambiguity_count > 0 then jsonb_build_object(
      '__error', 'cross_org_conversation_id_ambiguity',
      'count', ambiguities.ambiguity_count
    )
    else jsonb_build_object(
      'rows', document.rows,
      'counts', jsonb_build_object(
        'all', counts.all_count,
        'mine', counts.mine_count,
        'unassigned', counts.unassigned_count,
        'unread', counts.unread_count,
        'escalated', counts.escalated_count,
        'dispo', counts.dispo_count,
        'needs_outcome', counts.needs_outcome_count,
        'drip_replied', counts.drip_replied_count,
        'in_drip', counts.in_drip_count
      ),
      'total', meta.total_count,
      'hidden_count', meta.hidden_count,
      'limit', page.page_limit,
      'offset', page.page_offset
    )
  end
  from conversation_ambiguities ambiguities
  cross join counts
  cross join page_meta meta
  cross join effective_page page
  cross join document;
$function$
;

alter function public.sms_inbox_thread_page_snapshot(timestamptz, text, uuid, uuid, boolean, integer, integer, text) set statement_timeout = '5s';
revoke all on function public.sms_inbox_thread_page_snapshot(timestamptz, text, uuid, uuid, boolean, integer, integer, text) from public, anon;
grant execute on function public.sms_inbox_thread_page_snapshot(timestamptz, text, uuid, uuid, boolean, integer, integer, text) to authenticated, service_role;
notify pgrst, 'reload schema';
