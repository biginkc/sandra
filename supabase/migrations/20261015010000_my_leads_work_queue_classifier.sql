-- My Leads unified work queue, Phase A1: the classifier (no UI, no flag, no existing function touched).
--
-- Implements design v7 sections 1.1 (placement decision table), 2/2.1 (reasons and Broken
-- inventory), 3.1 (healthy automation), 5 (handled-reply rule) and 6 (pagination contract) as new
-- read-only functions over the existing queue projection:
--   public.my_leads_add_business_days     Mon-Fri business-day arithmetic in America/Chicago
--   public.my_leads_work_classified       internal: one placement row per queue lead (takes p_at)
--   public.fn_my_leads_work_page          page ids + row facts + total + tab/chip/stage counts +
--                                         revision + next_change_at from ONE statement (authenticated)
--   public.fn_my_leads_work_facts         current facts for given ids (authenticated)
--   public.fn_my_leads_badge_v2           distinct leads in Due / New reply / Broken (authenticated)
-- NO data step. Nothing here writes a row. Public wrappers are org-scoped through
-- my_leads_require_read_scope (owner may read any rep, everyone else only themselves).
-- Reads: my_leads_queue_rows, my_leads_touch_facts, my_leads_strip_overrides and the source tables.
begin;

-- 3 business days = Mon-Fri in America/Chicago, wall-clock preserved (a Friday 4 PM text comes
-- back Wednesday 4 PM). Calendar-day arithmetic is done on the local timestamp, so DST weekends
-- never shorten or lengthen the window.
create or replace function public.my_leads_add_business_days(p_ts timestamptz, p_days integer)
returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  v_local timestamp;
  v_done integer := 0;
begin
  if p_ts is null then return null; end if;
  v_local := p_ts at time zone 'America/Chicago';
  while v_done < p_days loop
    v_local := v_local + interval '1 day';
    if extract(isodow from v_local) < 6 then v_done := v_done + 1; end if;
  end loop;
  return v_local at time zone 'America/Chicago';
end;
$$;
revoke all on function public.my_leads_add_business_days(timestamptz, integer) from public, anon, authenticated, service_role;

-- The classifier. One row per lead in the member's queue (same scope as my_leads_queue_rows).
-- Internal: takes p_at so tests can pin time; the public wrappers pass statement_timestamp().
create or replace function public.my_leads_work_classified(p_org uuid, p_member uuid, p_at timestamptz)
returns table(
  property_id uuid, stage text, place text, place_rank smallint, reason text, sort_rank smallint, row_no text,
  reason_at timestamptz, sort_key double precision, last_touch_epoch double precision,
  last_touch_at timestamptz, attempts_count integer, assigned_at timestamptz,
  labels text[], has_phone boolean, contact_dnc boolean, in_badge boolean,
  facts jsonb, search_text text, next_change_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with q as materialized (
    select r.property_id, r.stage, r.next_warning_at, r.search_text, r.row_data
    from public.my_leads_queue_rows(p_org, p_member, p_at) r),
  base as materialized (
    select q.property_id, q.stage, q.next_warning_at, q.search_text, q.row_data,
      pr.homeowner_contact_id as contact_id, coalesce(c.do_not_contact, false) as dnc,
      array_remove(array[nullif(btrim(c.phone_1), ''), nullif(btrim(c.phone_2), ''), nullif(btrim(c.phone_3), '')], null) as phones,
      (q.row_data ->> 'assignedAt')::timestamptz as assigned_at,
      coalesce((q.row_data ->> 'attemptsCount')::integer, 0) as attempts_count,
      coalesce((q.row_data -> 'warningReasons') ? 'first_call_overdue', false) as first_call_overdue,
      (q.row_data ->> 'stageEnteredAt')::timestamptz as stage_entered_at
    from q
    join public.properties pr on pr.id = q.property_id and pr.org_id = p_org
    left join public.contacts c on c.id = pr.homeowner_contact_id and c.org_id = p_org),
  tf as materialized (select * from public.my_leads_touch_facts(p_org, p_member, p_at)),
  -- Every sms message attributable to a queue lead: by property_id, or property_id null and the
  -- homeowner contact (the attribution rule of the touch facts and the SMS history read).
  mx as materialized (
    select b.property_id as lead_id, m.id, m.created_at, m.direction, m.status, m.campaign_id, m.scheduled_for,
      m.metadata, m.sent_at, m.delivered_at, m.failed_at, (m.property_id is null) as contact_only
    from base b
    join public.messages m on m.org_id = p_org and m.channel = 'sms' and m.property_id = b.property_id and m.created_at <= p_at
    union all
    select b.property_id, m.id, m.created_at, m.direction, m.status, m.campaign_id, m.scheduled_for,
      m.metadata, m.sent_at, m.delivered_at, m.failed_at, true
    from base b
    join public.messages m on m.org_id = p_org and m.channel = 'sms' and m.property_id is null
      and m.contact_id = b.contact_id and b.contact_id is not null and m.created_at <= p_at),
  -- The org's ledger receipts for queue leads, read once (matched to messages by message_id below).
  lg as materialized (
    select distinct on (l.message_id) l.message_id, l.state, l.updated_at
    from public.rep_sms_delivery_ledger l
    where l.org_id = p_org and l.message_id is not null and l.property_id in (select property_id from base)
    order by l.message_id, l.updated_at desc),
  mf as materialized (
    select x.*,
      case when x.stamp ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then x.stamp::uuid end as stamp_id,
      case
        when x.direction <> 'outbound' then null
        when x.is_drip then 'drip'
        when x.campaign_id is not null then 'campaign'
        when x.gen = 'norma_precall' then 'norma_precall'
        when x.approved then 'human'
        when x.gen = 'ai_responder_v1' or x.reply_source = 'approved_template' then 'ai'
        when x.gen is null then 'human'
        else 'other'
      end as cls,
      -- accepted: the provider accepted it. Acceptance is durable: sent/delivered, a ledger accepted/delivered/delivery_failed
      -- receipt, or a recorded sent_at (the status events keep sent_at when a text later flips to failed), so a later delivery
      -- failure never un-answers the inbound it answered (it raises Broken instead). Nothing queued/pending/reserved/sending counts.
      (x.status in ('sent', 'delivered') or x.ledger_state in ('accepted', 'delivered', 'delivery_failed') or x.sent_at is not null) as acc,
      -- effective send time of an outbound text: when it actually went out (sent_at, then delivered_at), falling back to
      -- created_at for rows that never recorded one. Never a ledger updated_at or any failure time (the ledger has no
      -- accepted_at/delivered_at column, and its updated_at moves on delivery_failed settlement).
      -- A scheduled/campaign text created days before it was sent is measured from the send.
      case when x.direction = 'outbound' then coalesce(x.sent_at, x.delivered_at, x.created_at) else x.created_at end as eff_at
    from (
      select mx.*, mx.metadata ->> 'inbound_message_id' as stamp, mx.metadata ->> 'generated_by' as gen,
        mx.metadata ->> 'reply_source' as reply_source,
        (mx.metadata ->> 'approved_by_user_id') is not null as approved,
        mx.direction = 'outbound' and exists (select 1 from public.sequence_step_runs r where r.message_id = mx.id) as is_drip,
        lg.state as ledger_state
      from mx left join lg on lg.message_id = mx.id and mx.direction = 'outbound') x),
  -- User events used by the handled-reply rule and by failure supersession. An attempt logged
  -- through the workflow (log_acquisition_attempt) is deliberately NOT here: attempts count only
  -- through acquisition_attempts.outcome (reached / voicemail), so a no-answer call never clears.
  ev as materialized (
    select e.property_id as lead_id, e.event_type, e.created_at, e.source_id,
      (e.event_type = 'dispo_set'
        or (e.event_type = 'my_leads_workflow' and e.payload ->> 'operation' in ('ready_acquisition_offer', 'log_acquisition_offer',
          'record_acquisition_contract', 'decline_acquisition_offer', 'handoff_acquisition_lead'))
        or e.event_type in ('appointment_booked', 'task_created')) as handles
    from public.lead_events e
    where e.org_id = p_org and e.actor_type = 'user'
      and e.event_type in ('dispo_set', 'my_leads_workflow', 'appointment_booked', 'task_created', 'rep_sms_failure_dismissed')
      and e.property_id in (select property_id from base)),
  inb_t as (
    select distinct on (lead_id) lead_id, created_at as ts, id as mid, contact_only, 'text'::text as kind
    from mf where direction = 'inbound' order by lead_id, created_at desc, id desc),
  inb_c as (
    select distinct on (b.property_id) b.property_id as lead_id, coalesce(c.started_at, c.ended_at) as ts,
      null::uuid as mid, false as contact_only, 'call'::text as kind
    from base b
    join public.call_activities c on c.org_id = p_org and c.property_id = b.property_id and c.direction = 'inbound'
      and c.ended_at is not null and coalesce(c.talk_duration_seconds, 0) = 0 and coalesce(c.started_at, c.ended_at) <= p_at
    order by b.property_id, coalesce(c.started_at, c.ended_at) desc),
  inb as (
    select distinct on (lead_id) lead_id, ts, mid, contact_only, kind
    from (select * from inb_t union all select * from inb_c) u
    order by lead_id, ts desc, mid desc nulls last),
  hd as (
    select i.*, (
      exists (select 1 from mf r
              where r.lead_id = i.lead_id and r.direction = 'outbound' and r.campaign_id is null and not r.is_drip
                and r.cls in ('human', 'ai') and r.acc
                and (r.eff_at, r.id) > (i.ts, coalesce(i.mid, '00000000-0000-0000-0000-000000000000'::uuid))
                -- a text whose reply-to stamp was captured but could not be established handles nothing (PR #872)
                and coalesce(r.metadata ->> 'inbound_stamp_unresolved', '') <> 'true'
                -- reply-to stamp: a text stamped with an inbound older than this one does not answer it
                and (i.kind = 'call' or not exists (
                  select 1 from mf s where s.lead_id = r.lead_id and s.id = r.stamp_id and s.direction = 'inbound'
                    and (s.created_at, s.id) < (i.ts, i.mid))))
      or exists (select 1 from public.acquisition_attempts a
                 where a.org_id = p_org and a.property_id = i.lead_id and a.outcome in ('reached', 'voicemail') and a.recorded_at > i.ts)
      or exists (select 1 from ev where ev.lead_id = i.lead_id and ev.handles and ev.created_at > i.ts)
      or exists (select 1 from public.sequence_enrollments se
                 where se.org_id = p_org and se.property_id = i.lead_id and se.enrolled_by_user_id is not null and se.enrolled_at > i.ts)
    ) as handled
    from inb i),
  -- Last seller-facing outbound that the provider accepted.
  lo as (
    select distinct on (lead_id) lead_id, eff_at as ts, id, cls
    from mf where direction = 'outbound' and acc order by lead_id, eff_at desc, id desc),
  lo_final as (
    select lo.lead_id, e2.completed_at
    from lo
    join public.sequence_step_runs r on r.message_id = lo.id
    join public.sequence_enrollments e2 on e2.id = r.enrollment_id and e2.status = 'completed'
    join public.sequence_steps s on s.id = r.step_id
    where lo.cls = 'drip'
      and s.step_index = (select max(s2.step_index) from public.sequence_steps s2 where s2.sequence_id = e2.sequence_id)),
  en as materialized (
    select b.property_id as lead_id, e.id as enr_id, e.status as enr_status, e.pause_reason, e.next_run_at, e.completed_at as enr_completed_at,
      e.updated_at as enr_updated_at, e.current_step_index, e.first_send_not_before, seq.name as seq_name,
      (select count(*)::integer from public.sequence_steps st where st.sequence_id = e.sequence_id) as steps_total,
      (select min(r.attempt_started_at) from public.sequence_step_runs r
       where r.enrollment_id = e.id and r.claim_active and r.attempt_outcome = 'unknown') as claim_at,
      (select max(coalesce(r.run_at, r.created_at)) from public.sequence_step_runs r where r.enrollment_id = e.id and r.message_id is not null) as last_sent_at
    from base b
    left join lateral (
      select e.* from public.sequence_enrollments e
      where e.org_id = p_org and e.property_id = b.property_id
      order by (e.status in ('active', 'paused')) desc, e.enrolled_at desc, e.id desc limit 1) e on true
    left join public.sequences seq on seq.id = e.sequence_id and seq.org_id = p_org),
  po as (
    select distinct on (o.property_id) o.property_id as lead_id, (o.outcome = 'pending') as pending, o.follow_up_at,
      o.follow_up_calendar_chain_id as chain, o.sent_at as offer_sent_at
    from public.acquisition_offers o
    where o.org_id = p_org and o.property_id in (select property_id from base)
    order by o.property_id, o.sent_at desc, o.id),
  ap as materialized (
    select b.property_id as lead_id, greatest(t.due_at, coalesce(t.snoozed_until, t.due_at)) as eff, t.mode, t.status, t.source_key,
      (po.pending and po.chain is not null and po.chain = t.calendar_chain_id) as is_offer
    from base b
    join public.tasks t on t.org_id = p_org and t.related_property_id = b.property_id and t.next_step_kind = 'appointment'
      and t.status in ('open', 'snoozed')
    left join po on po.lead_id = b.property_id),
  apx as (
    select lead_id,
      min(eff) as any_min,
      min(eff) filter (where not is_offer and eff <= p_at + interval '15 minutes' and eff >= ((p_at at time zone 'America/Chicago') - interval '7 days') at time zone 'America/Chicago') as due_min,
      min(eff) filter (where not is_offer and eff < ((p_at at time zone 'America/Chicago') - interval '7 days') at time zone 'America/Chicago') as missed_min,
      min(eff) filter (where not is_offer and eff > p_at + interval '15 minutes') as future_min,
      min(eff) filter (where is_offer) as chain_eff,
      min(eff - interval '15 minutes') filter (where eff - interval '15 minutes' > p_at) as next_boundary,
      -- a callback is a missed callback once it is MORE than 7 Chicago days old, so the change lands 1 ms after the cutoff
      min(((eff at time zone 'America/Chicago') + interval '7 days') at time zone 'America/Chicago' + interval '1 millisecond')
        filter (where not is_offer and ((eff at time zone 'America/Chicago') + interval '7 days') at time zone 'America/Chicago' + interval '1 millisecond' > p_at) as next_missed
    from ap group by lead_id),
  nt as (
    select distinct t.related_property_id as lead_id
    from public.tasks t
    where t.org_id = p_org and t.status in ('open', 'snoozed') and t.source_key like 'norma\_call:%' escape '\'
      and t.related_property_id in (select property_id from base)),
  nr as (
    select r.property_id as lead_id,
      bool_or(r.status in ('requested', 'dispatching', 'dispatched', 'dispatch_unknown')) as calling,
      min(r.updated_at) filter (where r.status = 'needs_review') as review_at
    from public.norma_call_requests r
    where r.org_id = p_org and r.property_id in (select property_id from base) group by r.property_id),
  camp as (
    select lead_id,
      min(scheduled_for) filter (where status = 'queued' and scheduled_for is not null and not is_drip and scheduled_for >= p_at - interval '30 minutes') as healthy_at,
      min(scheduled_for) filter (where status = 'queued' and scheduled_for is not null and not is_drip and scheduled_for < p_at - interval '30 minutes') as overdue_at,
      min(created_at) filter (where status = 'queued' and scheduled_for is null and campaign_id is null and not is_drip and direction = 'outbound') as manual_at
    from mf where direction = 'outbound' group by lead_id),
  -- Broken conditions. failure = true rows are definitive failures and are superseded by later rep work.
  bk0 as (
    select e.lead_id, 'drip_paused'::text as kind, 'fix_drip'::text as action, e.enr_updated_at as at, e.enr_id as ref_id, false as failure
    from en e
    where e.enr_status = 'paused' and e.pause_reason in ('provider_failed', 'reconciliation_required', 'template_missing', 'step_misconfigured',
      'no_phone', 'no_approved_sender', 'no approved sender for first-touch sequence send', 'consent_unavailable')
    union all
    select e.lead_id, 'drip_stuck', 'fix_drip', coalesce(e.claim_at, e.next_run_at, e.enr_updated_at), e.enr_id, false
    from en e
    where (e.enr_status = 'active' and (e.claim_at < p_at - interval '15 minutes' or e.next_run_at < p_at - interval '60 minutes'))
       or (e.enr_status = 'paused' and e.pause_reason = 'call_in_progress' and e.enr_updated_at < p_at - interval '30 minutes')
    union all
    select b.property_id, case o.state
        when 'delivery_failed' then 'followup_text_not_delivered' when 'blocked' then 'followup_text_blocked'
        when 'unknown' then 'followup_text_status_unknown' when 'claimed' then 'followup_text_status_unknown'
        when 'sending' then 'followup_text_status_unknown' else 'followup_text_not_sent' end,
      case o.state when 'delivery_failed' then 'resend' when 'blocked' then 'review'
        when 'unknown' then 'check_status' when 'claimed' then 'check_status' when 'sending' then 'check_status' else 'send_text' end,
      o.updated_at, o.id, o.state in ('failed_not_dispatched', 'delivery_failed', 'blocked')
    from base b
    join public.rep_sms_obligations o on o.org_id = p_org and o.property_id = b.property_id
    where o.state in ('required', 'draft', 'failed_not_dispatched', 'delivery_failed', 'blocked', 'unknown')
       or (o.state in ('claimed', 'sending') and o.lease_expires_at < p_at)
    union all
    select b.property_id, case when l.state in ('failed_not_dispatched', 'delivery_failed') then 'text_not_delivered'
        when l.state = 'blocked' then 'text_blocked' else 'text_status_unknown' end,
      case when l.state in ('failed_not_dispatched', 'delivery_failed') then 'resend' when l.state = 'blocked' then 'review' else 'check_status' end,
      l.updated_at, l.id, l.state in ('failed_not_dispatched', 'delivery_failed', 'blocked')
    from base b
    join public.rep_sms_delivery_ledger l on l.org_id = p_org and l.property_id = b.property_id
    where l.state in ('failed_not_dispatched', 'delivery_failed', 'blocked', 'unknown')
       or (l.state in ('reserved', 'sending') and l.updated_at < p_at - interval '15 minutes')
    union all
    select m.lead_id,
      case when m.status = 'failed' and m.metadata ->> 'providerOutcome' is distinct from 'provider_unknown' then 'text_not_sent' else 'text_status_unknown' end,
      case when m.status = 'failed' and m.metadata ->> 'providerOutcome' is distinct from 'provider_unknown' then 'resend' else 'check_status' end,
      coalesce(m.failed_at, m.created_at), m.id,
      m.status = 'failed' and m.metadata ->> 'providerOutcome' is distinct from 'provider_unknown'
    from mf m
    where m.cls = 'human' and m.created_at > p_at - interval '7 days'
      and m.ledger_state is null   -- a ledger receipt is authoritative for its message
      and (m.status = 'failed' or (m.status = 'pending' and m.created_at < p_at - interval '15 minutes'))
    union all
    select c.lead_id, 'scheduled_text_overdue', 'open_campaign', c.overdue_at, null::uuid, false from camp c where c.overdue_at is not null
    union all
    select b.property_id, 'ai_reply_failed', 'review', dl.created_at, dl.id, false
    from base b join public.ai_reply_dead_letters dl on dl.org_id = p_org and dl.property_id = b.property_id and dl.resolved_at is null
    union all
    select n.lead_id, 'norma_needs_review', 'review', n.review_at, null::uuid, false from nr n where n.review_at is not null),
  -- A pending AI draft is a label only (never Broken): stale once its reply is handled another way.
  dr as (
    select distinct on (d.property_id) d.property_id as lead_id, d.id as draft_id from public.ai_reply_drafts d
    where d.org_id = p_org and d.status = 'pending' and d.property_id in (select property_id from base)
    order by d.property_id, d.created_at desc, d.id),
  bko as (
    select b0.* from bk0 b0
    where not exists (select 1 from ev where ev.lead_id = b0.lead_id and ev.event_type = 'rep_sms_failure_dismissed' and ev.source_id = b0.ref_id)
      and (not b0.failure or not (
        exists (select 1 from mf r where r.lead_id = b0.lead_id and r.direction = 'outbound' and r.cls = 'human' and r.acc and r.eff_at > b0.at)
        or exists (select 1 from ev where ev.lead_id = b0.lead_id and ev.handles and ev.created_at > b0.at)
        or exists (select 1 from public.sequence_enrollments se
                   where se.org_id = p_org and se.property_id = b0.lead_id and se.enrolled_by_user_id is not null and se.enrolled_at > b0.at)))),
  bka as (
    select lead_id, count(*)::integer as n,
      (array_agg(kind order by at, kind))[1] as first_kind, (array_agg(action order by at, kind))[1] as first_action,
      min(at) as first_at,
      jsonb_agg(jsonb_build_object('kind', kind, 'action', action, 'at', at, 'refId', ref_id) order by at, kind) as items
    from bko group by lead_id),
  -- Clock-only boundaries (section 6 next_change_at): every instant at which placement can change with no write.
  -- Thresholds that are strict ("older than N minutes") carry +1 ms so a refresh AT the boundary really sees the change.
  tm as (
    select lead_id, t from (
      select b.property_id as lead_id, b.next_warning_at as t from base b
      union all select ov.property_id, ov.pinned_until from public.my_leads_strip_overrides ov
        where ov.org_id = p_org and ov.member_id = p_member and ov.pinned_at is not null
      union all select lead_id, next_boundary from apx
      union all select lead_id, next_missed from apx
      union all select lead_id, follow_up_at - interval '15 minutes' from po where pending and chain is null
      union all select lead_id, ts from (select lo.lead_id, public.my_leads_add_business_days(lo.ts, 3) as ts from lo
                                        where lo.cls in ('human', 'ai', 'campaign')) d
      union all select lead_id, next_run_at + interval '60 minutes 1 millisecond' from en where enr_status = 'active'
      union all select lead_id, enr_updated_at + interval '30 minutes 1 millisecond' from en where enr_status = 'paused' and pause_reason = 'call_in_progress'
      union all select lead_id, claim_at + interval '15 minutes 1 millisecond' from en
      union all select lead_id, healthy_at + interval '30 minutes 1 millisecond' from camp
      union all select m.lead_id, m.created_at + interval '15 minutes 1 millisecond' from mf m where m.status = 'pending' and m.cls = 'human'
      union all select m.lead_id, m.created_at + interval '7 days' from mf m where m.status in ('failed', 'pending') and m.cls = 'human'
      union all select b.property_id, l.updated_at + interval '15 minutes 1 millisecond' from base b
        join public.rep_sms_delivery_ledger l on l.org_id = p_org and l.property_id = b.property_id and l.state in ('reserved', 'sending')
      union all select b.property_id, o.lease_expires_at + interval '1 millisecond' from base b
        join public.rep_sms_obligations o on o.org_id = p_org and o.property_id = b.property_id and o.state in ('claimed', 'sending')
    ) x where t > p_at),
  tmn as (select lead_id, min(t) as next_at from tm group by lead_id),
  fl as (
    select b.*, tf.last_touch_at, tf.last_call_at,
      (ov.pinned_at is not null and (ov.pinned_until is null or ov.pinned_until > p_at)
        and (tf.last_call_at is null or tf.last_call_at <= ov.pinned_at)) as pinned, ov.pinned_at,
      i.ts as in_ts, i.mid as in_mid, i.contact_only as in_contact_only, i.kind as in_kind, i.handled as in_handled,
      coalesce(i.handled is false, false) as unhandled,
      lo.ts as lo_ts, lo.cls as lo_cls, lo.id as lo_id, lof.completed_at as lof_completed_at, (lof.lead_id is not null) as lo_final,
      (i.ts is not null and lo.ts is not null and i.ts > lo.ts) as inbound_after_lo,
      public.my_leads_add_business_days(lo.ts, 3) as lo_deadline,
      e.enr_id, e.enr_status, e.pause_reason, e.next_run_at, e.enr_completed_at, e.current_step_index, e.seq_name, e.steps_total,
      e.last_sent_at, e.first_send_not_before, e.enr_updated_at,
      (e.enr_status = 'active' and e.next_run_at is not null and e.next_run_at >= p_at - interval '60 minutes' and not coalesce(e.claim_at < p_at - interval '15 minutes', false))
        or (e.enr_status = 'paused' and e.pause_reason = 'call_in_progress' and e.enr_updated_at >= p_at - interval '30 minutes') as drip_healthy,
      coalesce(po.pending, false) as offer_pending, po.chain is not null as offer_has_chain, po.follow_up_at as offer_follow_up_at, po.offer_sent_at,
      apx.any_min, apx.due_min, apx.missed_min, apx.future_min, apx.chain_eff,
      camp.healthy_at as camp_healthy_at, camp.manual_at,
      coalesce(bka.n, 0) as broken_n, (dr.lead_id is not null) as draft_waiting, dr.draft_id, bka.first_kind, bka.first_action, bka.first_at as broken_at, bka.items as broken_items,
      coalesce(nr.calling, false) as norma_calling, (nt.lead_id is not null) as norma_task,
      tmn.next_at
    from base b
    left join tf on tf.property_id = b.property_id
    left join public.my_leads_strip_overrides ov on ov.org_id = p_org and ov.member_id = p_member and ov.property_id = b.property_id
    left join hd i on i.lead_id = b.property_id
    left join lo on lo.lead_id = b.property_id
    left join lo_final lof on lof.lead_id = b.property_id
    left join en e on e.lead_id = b.property_id
    left join po on po.lead_id = b.property_id
    left join apx on apx.lead_id = b.property_id
    left join camp on camp.lead_id = b.property_id
    left join bka on bka.lead_id = b.property_id
    left join dr on dr.lead_id = b.property_id
    left join nr on nr.lead_id = b.property_id
    left join nt on nt.lead_id = b.property_id
    left join tmn on tmn.lead_id = b.property_id),
  fe as (
    select fl.*,
      case when fl.offer_pending and fl.stage = 'offer_sent'
        then coalesce(fl.chain_eff, case when not fl.offer_has_chain then fl.offer_follow_up_at end) end as offer_eff,
      (fl.lo_cls in ('human', 'ai', 'campaign') and not fl.inbound_after_lo) as texted_ok,
      (fl.drip_healthy or fl.camp_healthy_at is not null) as automation_ok
    from fl),
  pl as (
    select fe.*,
      case
        when fe.stage = 'under_contract' and fe.any_min is null then '1'
        when fe.pinned then '2'
        when fe.stage = 'not_contacted' and fe.attempts_count = 0 then '3'
        when fe.due_min is not null then '4'
        when fe.unhandled then '5'
        when fe.broken_n > 0 then '6'
        when fe.manual_at is not null then '6a'
        when fe.stage = 'needs_offer' and not fe.offer_pending then '7'
        when fe.stage = 'offer_sent' and fe.offer_pending
          and ((fe.offer_has_chain and fe.chain_eff is null) or fe.offer_eff <= p_at + interval '15 minutes') then '8'
        when fe.missed_min is not null then '9'
        when fe.automation_ok then '10'
        when fe.future_min is not null then '11'
        when fe.offer_eff > p_at + interval '15 minutes' then '12'
        when fe.texted_ok and p_at < fe.lo_deadline then '13'
        when (fe.texted_ok and p_at >= fe.lo_deadline) or (fe.lo_final and not fe.inbound_after_lo) then '14'
        else '15'
      end as row_no
    from fe),
  cl as (
    select pl.*,
      case pl.row_no
        when '1' then 'neither'
        when '10' then 'their_move' when '11' then 'their_move' when '12' then 'their_move' when '13' then 'their_move'
        else 'your_move' end as place,
      case pl.row_no
        when '1' then 'under_contract' when '2' then 'call_today' when '3' then 'new_lead'
        when '4' then 'due' when '9' then 'due' when '5' then 'new_reply' when '6' then 'broken'
        when '6a' then 'nothing_planned' when '7' then 'offer' when '8' then 'offer'
        when '10' then 'in_drip'
        when '11' then case when pl.offer_eff > p_at + interval '15 minutes' and pl.offer_eff < pl.future_min then 'offer_out' else 'callback_booked' end
        when '12' then 'offer_out' when '13' then 'texted_last' when '14' then 'gone_quiet'
        else 'nothing_planned' end as reason
    from pl),
  fin as (
    select cl.*,
      array_remove(array[
        case when cl.norma_calling then 'norma_calling' end,
        case when cl.norma_task then 'norma_task' end,
        case when cl.dnc then 'do_not_contact' end,
        case when cl.manual_at is not null then 'text_waiting' end,
        case when cl.in_contact_only and cl.in_ts is not null then 'check_texts' end,
        case when cl.broken_n > 0 and cl.row_no <> '6' then 'broken' end,
        case when cl.draft_waiting then 'ai_draft_waiting' end
      ], null) || case when cardinality(cl.phones) = 0 then array['no_phone'] else array[]::text[] end as labels,
      case cl.place when 'your_move' then 0 when 'their_move' then 1 else 2 end::smallint as place_rank,
      case when cl.place <> 'your_move' then 0
        else case cl.reason when 'new_lead' then 1 when 'call_today' then 2 when 'due' then 3 when 'new_reply' then 4
          when 'broken' then 5 when 'offer' then 6 when 'gone_quiet' then 7 else 8 end end::smallint as sort_rank,
      case cl.row_no
        when '2' then cl.pinned_at when '3' then cl.assigned_at when '4' then cl.due_min when '9' then cl.missed_min
        when '5' then cl.in_ts when '6' then cl.broken_at when '6a' then cl.manual_at
        when '7' then cl.stage_entered_at
        when '8' then coalesce(cl.offer_eff, cl.offer_sent_at, cl.stage_entered_at)
        when '10' then coalesce(cl.next_run_at, cl.camp_healthy_at,
          case when cl.pause_reason = 'call_in_progress' then cl.enr_updated_at + interval '30 minutes' end, cl.first_send_not_before)
        when '11' then case when cl.reason = 'offer_out' then cl.offer_eff else cl.future_min end
        when '12' then cl.offer_eff when '13' then cl.lo_ts
        when '14' then coalesce(cl.lof_completed_at, cl.lo_ts) end as reason_at
    from cl)
  select f.property_id, f.stage, f.place, f.place_rank, f.reason, f.sort_rank, f.row_no, f.reason_at,
    case f.row_no
      when '2' then -extract(epoch from f.pinned_at)
      when '5' then -extract(epoch from f.in_ts)
      when '13' then extract(epoch from f.lo_deadline)
      when '14' then coalesce(extract(epoch from f.last_touch_at), -1e12)
      when '15' then coalesce(extract(epoch from f.last_touch_at), -1e12)
      when '6a' then coalesce(extract(epoch from f.last_touch_at), -1e12)
      when '1' then coalesce(extract(epoch from f.last_touch_at), -1e12)
      else coalesce(extract(epoch from f.reason_at), 0)
    end::double precision as sort_key,
    coalesce(extract(epoch from f.last_touch_at), -1e12)::double precision as last_touch_epoch,
    f.last_touch_at, f.attempts_count, f.assigned_at,
    f.labels,
    cardinality(f.phones) > 0 as has_phone, f.dnc as contact_dnc,
    (f.row_no in ('4', '9', '5', '6')) as in_badge,
    jsonb_build_object(
      'propertyId', f.property_id, 'stage', f.stage, 'place', f.place, 'reason', f.reason, 'rowNo', f.row_no,
      'reasonAt', f.reason_at,
      'headline', case f.row_no
        when '1' then jsonb_build_object('signedAt', null)
        when '2' then jsonb_build_object('pinnedAt', f.pinned_at)
        when '3' then jsonb_build_object('assignedAt', f.assigned_at, 'firstCallOverdue', f.first_call_overdue)
        when '4' then jsonb_build_object('at', f.due_min, 'soon', f.due_min > p_at)
        when '9' then jsonb_build_object('at', f.missed_min, 'overdueDays', floor(extract(epoch from (p_at - f.missed_min)) / 86400))
        when '5' then jsonb_build_object('at', f.in_ts, 'kind', f.in_kind)
        when '6' then jsonb_build_object('kind', f.first_kind, 'action', f.first_action, 'at', f.broken_at)
        when '6a' then jsonb_build_object('variant', 'text_waiting', 'at', f.manual_at)
        when '7' then jsonb_build_object('kind', 'ready', 'since', f.stage_entered_at)
        when '8' then jsonb_build_object('kind', case when f.offer_has_chain and f.chain_eff is null then 'follow_up_missing' else 'follow_up_due' end, 'at', f.offer_eff)
        when '10' then jsonb_build_object('nextRunAt', f.next_run_at, 'scheduledAt', f.camp_healthy_at, 'callInProgress', f.pause_reason = 'call_in_progress',
          'resumeBy', case when f.pause_reason = 'call_in_progress' then f.enr_updated_at + interval '30 minutes' end)
        when '11' then jsonb_build_object('kind', f.reason, 'at', case when f.reason = 'offer_out' then f.offer_eff else f.future_min end)
        when '12' then jsonb_build_object('at', f.offer_eff)
        when '13' then jsonb_build_object('at', f.lo_ts, 'by', f.lo_cls, 'until', f.lo_deadline)
        when '14' then jsonb_build_object('kind', case when f.texted_ok then 'texted_silent' else 'drip_finished' end,
          'at', coalesce(f.lof_completed_at, f.lo_ts), 'since', f.lo_ts)
        else jsonb_build_object('variant', case when f.in_contact_only and f.in_ts is not null then 'check_texts' end)
      end,
      'drip', case when f.enr_id is null then null else jsonb_build_object(
        'enrollmentId', f.enr_id, 'status', f.enr_status, 'pauseReason', f.pause_reason, 'name', f.seq_name,
        'step', f.current_step_index + 1, 'stepsTotal', f.steps_total, 'nextRunAt', f.next_run_at,
        'completedAt', f.enr_completed_at, 'lastSentAt', f.last_sent_at, 'healthy', coalesce(f.drip_healthy, false)) end,
      'nextStep', case when f.due_min is not null or f.missed_min is not null or f.future_min is not null or f.chain_eff is not null then
        jsonb_build_object('callbackAt', coalesce(f.due_min, f.future_min, f.missed_min), 'offerFollowUpAt', f.chain_eff) end,
      'lastTouchAt', f.last_touch_at, 'attemptsCount', f.attempts_count, 'assignedAt', f.assigned_at,
      'latestInbound', case when f.in_ts is null then null else jsonb_build_object(
        'at', f.in_ts, 'kind', f.in_kind, 'messageId', f.in_mid, 'handled', f.in_handled, 'contactOnly', f.in_contact_only) end,
      'hasPhone', cardinality(f.phones) > 0, 'contactDnc', f.dnc,
      'broken', coalesce(f.broken_items, '[]'::jsonb), 'aiDraftId', f.draft_id,
      'labels', to_jsonb(f.labels),
      'row', f.row_data) as facts,
    f.search_text, f.next_at
  from fin f;
$$;
revoke all on function public.my_leads_work_classified(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;

-- The page read. Rows, total, counts, revision and next_change_at all come from ONE statement, so
-- they always agree. Search is bounded to 200 characters, pages to 1-50 rows.
--   p_tab   needs_attention | waiting | all
--   p_chip  null / 'all' or a reason (new_lead, call_today, due, new_reply, broken, offer, gone_quiet,
--           nothing_planned for needs_attention; in_drip, texted_last, offer_out, callback_booked for waiting)
--   Counts: tabCounts and chipCounts apply the stage and search filters, stageCounts apply the tab, chip and
--   search filters, so every number matches the list a click would show.
--   revision: md5 of the ordered id list of the filtered set. p_at null = statement time.
-- p_org_id is the first argument (design v7 lists only the member): the org-scope wrapper needs it.
create or replace function public.fn_my_leads_work_page(
  p_org_id uuid, p_member_id uuid, p_tab text, p_chip text, p_stage text, p_search text,
  p_page integer, p_size integer, p_at timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_at timestamptz := coalesce(p_at, statement_timestamp());
  v_q text;
  v_digits text;
  v_result jsonb;
begin
  perform public.my_leads_require_read_scope(p_org_id, p_member_id);
  if p_tab is null or p_tab not in ('needs_attention', 'waiting', 'all')
     or p_page is null or p_page < 1 or p_size is null or p_size < 1 or p_size > 50
     or (p_search is not null and char_length(p_search) > 200)
     or (p_stage is not null and p_stage not in ('not_contacted', 'contacted', 'needs_offer', 'offer_sent', 'under_contract'))
     or (p_chip is not null and p_chip not in ('all', 'new_lead', 'call_today', 'due', 'new_reply', 'broken', 'offer', 'gone_quiet',
        'nothing_planned', 'in_drip', 'texted_last', 'offer_out', 'callback_booked', 'under_contract')) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_q := nullif(btrim(p_search), '');
  v_digits := case when v_q is not null and char_length(regexp_replace(v_q, '[^0-9]', '', 'g')) >= 3
    then regexp_replace(v_q, '[^0-9]', '', 'g') end;
  if v_q is not null then
    v_q := '%' || replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  with c as materialized (
    select * from public.my_leads_work_classified(p_org_id, p_member_id, v_at)),
  s as (   -- search applied
    select c.* from c
    where v_q is null or lower(c.search_text) like v_q escape '\'
       or (v_digits is not null and regexp_replace(c.search_text, '[^0-9]', '', 'g') like '%' || v_digits || '%')),
  f as (select s.* from s where p_stage is null or s.stage = p_stage),   -- stage applied
  t as (   -- tab applied
    select f.* from f
    where p_tab = 'all' or (p_tab = 'needs_attention' and f.place = 'your_move') or (p_tab = 'waiting' and f.place = 'their_move')),
  k as (select t.* from t where p_chip is null or p_chip = 'all' or t.reason = p_chip),   -- chip applied
  o as (
    select k.*, row_number() over (order by k.place_rank, k.sort_rank, k.sort_key, k.last_touch_epoch, k.property_id) as rn
    from k),
  meta as (
    select count(*)::integer as total,
      least(p_page, greatest(1, ceil(count(*)::numeric / p_size)::integer)) as page
    from k)
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(o.facts order by o.rn) from o, meta
                      where o.rn > (meta.page - 1) * p_size and o.rn <= meta.page * p_size), '[]'::jsonb),
    'ids', coalesce((select jsonb_agg(o.property_id order by o.rn) from o, meta
                     where o.rn > (meta.page - 1) * p_size and o.rn <= meta.page * p_size), '[]'::jsonb),
    'total', (select total from meta),
    'page', (select page from meta),
    'pageSize', p_size,
    'tabCounts', jsonb_build_object(
      'needs_attention', (select count(*) from f where f.place = 'your_move'),
      'waiting', (select count(*) from f where f.place = 'their_move'),
      'all', (select count(*) from f)),
    'chipCounts', coalesce((select jsonb_object_agg(g.reason, g.n) from (select t.reason, count(*) as n from t group by t.reason) g), '{}'::jsonb),
    'stageCounts', coalesce((select jsonb_object_agg(g.stage, g.n) from (
        select s.stage, count(*) as n from s
        where (p_tab = 'all' or (p_tab = 'needs_attention' and s.place = 'your_move') or (p_tab = 'waiting' and s.place = 'their_move'))
          and (p_chip is null or p_chip = 'all' or s.reason = p_chip)
        group by s.stage) g), '{}'::jsonb),
    'revision', md5(coalesce((select string_agg(o.property_id::text, ',' order by o.rn) from o), '')),
    'nextChangeAt', (select min(c.next_change_at) from c),
    'snapshotAt', v_at)
  into v_result;
  return v_result;
end;
$$;
revoke all on function public.fn_my_leads_work_page(uuid, uuid, text, text, text, text, integer, integer, timestamptz) from public, anon;
grant execute on function public.fn_my_leads_work_page(uuid, uuid, text, text, text, text, integer, integer, timestamptz) to authenticated;

-- Current facts for given ids (retained rows after a refresh, or the one row an action touched).
-- An id that is no longer in the member's queue comes back in "missing".
create or replace function public.fn_my_leads_work_facts(p_org_id uuid, p_member_id uuid, p_ids uuid[], p_at timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_at timestamptz := coalesce(p_at, statement_timestamp());
  v_result jsonb;
begin
  perform public.my_leads_require_read_scope(p_org_id, p_member_id);
  if p_ids is null or cardinality(p_ids) > 50 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  with c as materialized (
    select * from public.my_leads_work_classified(p_org_id, p_member_id, v_at)),
  w as (select c.* from c where c.property_id = any(p_ids))
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(w.facts order by w.property_id) from w), '[]'::jsonb),
    'missing', coalesce((select jsonb_agg(x) from unnest(p_ids) x where x not in (select w.property_id from w)), '[]'::jsonb),
    'snapshotAt', v_at)
  into v_result;
  return v_result;
end;
$$;
revoke all on function public.fn_my_leads_work_facts(uuid, uuid, uuid[], timestamptz) from public, anon;
grant execute on function public.fn_my_leads_work_facts(uuid, uuid, uuid[], timestamptz) to authenticated;

-- Sidebar badge: distinct leads in the signed-in user's own queue (every org they work in) whose
-- placement is Due, New reply or Broken. A lead counts once.
create or replace function public.fn_my_leads_badge_v2(p_at timestamptz default null)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_at timestamptz := coalesce(p_at, statement_timestamp());
  v_uid uuid := auth.uid();
  v_org uuid;
  v_total integer := 0;
begin
  if v_uid is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  for v_org in
    select m.org_id from public.memberships m
    where m.user_id = v_uid and m.access_status = 'active' and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
      and exists (select 1 from public.acquisition_org_settings s where s.org_id = m.org_id and s.my_leads_enabled)
  loop
    begin
      perform public.my_leads_require_read_scope(v_org, v_uid);
    exception when sqlstate '42501' or sqlstate 'P0002' then
      continue;
    end;
    v_total := v_total + (select count(*) from public.my_leads_work_classified(v_org, v_uid, v_at) c where c.in_badge);
  end loop;
  return v_total;
end;
$$;
revoke all on function public.fn_my_leads_badge_v2(timestamptz) from public, anon;
grant execute on function public.fn_my_leads_badge_v2(timestamptz) to authenticated;

commit;
