-- My Leads one-call close, P1b (1b.1): the ranked "Call next" strip.
--
-- Schema and functions only. NO data step: nothing here changes an existing row. The strip is a
-- computed view over the existing queue projection (my_leads_queue_rows); it never writes
-- acquisition_queue_states, so a lead can never move between sections because of it. The only
-- new row store is my_leads_strip_overrides ("Call today" / "Not today"), written solely through
-- fn_set_my_leads_strip_override.
--
-- Objects:
--   public.my_leads_strip_overrides            per-member pin / hide, RLS select-own, no write grant
--   public.my_leads_next_chicago_midnight      the one "midnight America/Chicago" definition
--   public.my_leads_touch_facts                last touch / last call / last inbound per queue lead
--   public.my_leads_call_next_rows             the one ranking projection (internal, takes p_at)
--   public.fn_get_my_leads_call_next           the strip read (authenticated)
--   public.fn_set_my_leads_strip_override      Call today / Not today / clear (authenticated)
--   public.fn_get_my_leads_triage              "untouched > N days, no next step" chip (authenticated)
-- Requires 20261005130000 (acquisition_offers.follow_up_calendar_chain_id) and 20261005120000
-- (tasks.next_step_kind).
begin;

create table public.my_leads_strip_overrides (
  org_id uuid not null references public.organizations(id) on delete cascade,
  member_id uuid not null references auth.users(id) on delete cascade,
  property_id uuid not null,
  pinned_at timestamptz,
  pinned_until timestamptz,   -- "Call today": pinned until called or midnight America/Chicago
  hidden_until timestamptz,   -- "Not today": hidden until midnight America/Chicago
  updated_at timestamptz not null default now(),
  primary key (org_id, member_id, property_id),
  constraint my_leads_strip_overrides_property_org_fkey
    foreign key (property_id, org_id) references public.properties(id, org_id) on delete cascade,
  constraint my_leads_strip_overrides_one_kind_check
    check (num_nonnulls(pinned_until, hidden_until) = 1 and ((pinned_until is null) = (pinned_at is null)))
);
alter table public.my_leads_strip_overrides enable row level security;
revoke all on public.my_leads_strip_overrides from public, anon, authenticated, service_role;
grant select on public.my_leads_strip_overrides to authenticated;
create policy my_leads_strip_overrides_select_own on public.my_leads_strip_overrides
  for select to authenticated
  using (member_id = (select auth.uid()) and public.hugo_has_active_org_access(org_id));
-- Writes go only through fn_set_my_leads_strip_override (no insert/update/delete grant, no write policy).

-- Next midnight in America/Chicago after p_at (the pattern the KPI function uses for its day start).
-- Calendar-day arithmetic is done on the local timestamp, so a 23- or 25-hour DST day is handled.
create or replace function public.my_leads_next_chicago_midnight(p_at timestamptz)
returns timestamptz
language sql stable set search_path = '' as $$
  select (date_trunc('day', p_at at time zone 'America/Chicago') + interval '1 day') at time zone 'America/Chicago';
$$;
revoke all on function public.my_leads_next_chicago_midnight(timestamptz) from public, anon, authenticated, service_role;

-- Touch facts over the member's queue. A touch is the latest of an attempt, an outbound text
-- (sent or delivered), a note, or an outbound call. last_call_at is attempts and outbound calls
-- only, so it alone clears a "Call today" pin. An inbound text or inbound call that ended
-- unanswered is a touch BY THE SELLER and is never part of last_touch_at. Message attribution is
-- the same rule as the SMS history read: by property_id, or property_id null and the homeowner
-- contact.
create or replace function public.my_leads_touch_facts(p_org uuid, p_member uuid, p_at timestamptz)
returns table(property_id uuid, last_touch_at timestamptz, last_call_at timestamptz, last_inbound_at timestamptz, last_inbound_kind text)
language sql stable security definer set search_path = '' as $$
  select q.property_id,
    greatest(att.ts, osms.ts, osms_c.ts, nt.ts, ocall.ts),
    greatest(att.ts, ocall.ts),
    greatest(isms.ts, isms_c.ts, icall.ts),
    case
      when greatest(isms.ts, isms_c.ts) is null then case when icall.ts is not null then 'call' end
      when icall.ts is not null and icall.ts > greatest(isms.ts, isms_c.ts) then 'call'
      else 'text'
    end
  from public.my_leads_queue_rows(p_org, p_member, p_at) q
  join public.properties pr on pr.id = q.property_id and pr.org_id = p_org
  left join lateral (
    select max(a.occurred_at) as ts from public.acquisition_attempts a
    where a.org_id = p_org and a.property_id = q.property_id and a.occurred_at <= p_at) att on true
  left join lateral (
    select max(m.created_at) as ts from public.messages m
    where m.org_id = p_org and m.channel = 'sms' and m.direction = 'outbound' and m.status in ('sent', 'delivered')
      and m.property_id = q.property_id and m.created_at <= p_at) osms on true
  left join lateral (
    select max(m.created_at) as ts from public.messages m
    where pr.homeowner_contact_id is not null
      and m.org_id = p_org and m.channel = 'sms' and m.direction = 'outbound' and m.status in ('sent', 'delivered')
      and m.property_id is null and m.contact_id = pr.homeowner_contact_id and m.created_at <= p_at) osms_c on true
  left join lateral (
    select max(n.created_at) as ts from public.lead_notes n
    where n.org_id = p_org and n.property_id = q.property_id and n.created_at <= p_at) nt on true
  left join lateral (
    select max(c.started_at) as ts from public.call_activities c
    where c.org_id = p_org and c.property_id = q.property_id and c.direction is distinct from 'inbound'
      and c.started_at is not null and c.started_at <= p_at) ocall on true
  left join lateral (
    select max(m.created_at) as ts from public.messages m
    where m.org_id = p_org and m.channel = 'sms' and m.direction = 'inbound'
      and m.property_id = q.property_id and m.created_at <= p_at) isms on true
  left join lateral (
    select max(m.created_at) as ts from public.messages m
    where pr.homeowner_contact_id is not null
      and m.org_id = p_org and m.channel = 'sms' and m.direction = 'inbound'
      and m.property_id is null and m.contact_id = pr.homeowner_contact_id and m.created_at <= p_at) isms_c on true
  -- Dormant until Phase 2 records inbound calls; the predicate ships now so Phase 2 only writes rows.
  left join lateral (
    select max(coalesce(c.started_at, c.ended_at)) as ts from public.call_activities c
    where c.org_id = p_org and c.property_id = q.property_id and c.direction = 'inbound'
      and c.ended_at is not null and coalesce(c.talk_duration_seconds, 0) = 0
      and coalesce(c.started_at, c.ended_at) <= p_at) icall on true;
$$;
revoke all on function public.my_leads_touch_facts(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;

-- The one ranking projection. Internal (takes p_at so tests can pin time); the public wrapper
-- passes statement_timestamp(). Tiers (D3):
--   0 pinned "Call today" (until called or midnight Central)
--   1 appointment due within 15 minutes or overdue (any mode, any assignee); offer follow-up
--     appointments are excluded here and ranked in tier 3
--   2 inbound text/call newer than the last touch, newest first
--   3 needs_offer with no pending offer; offer_sent whose follow-up (the chain task, falling back
--     to acquisition_offers.follow_up_at only for an offer with no chain yet) is due
--   4 hot/warm motivation with no touch in 3 days
--   5 everyone else, longest since last touch first (never touched first)
-- Ties: assignment age (oldest first), then property id. Leads with no callable phone or a DNC
-- contact are returned with excluded_reason set; leads in an active drip are absent.
create or replace function public.my_leads_call_next_rows(p_org uuid, p_member uuid, p_at timestamptz)
returns table(property_id uuid, tier smallint, reason text, reason_at timestamptz, pinned boolean, hidden boolean,
  excluded_reason text, last_touch_at timestamptz, assignment_sort timestamptz, sort_key double precision, row_data jsonb)
language sql stable security definer set search_path = '' as $$
  with q as (
    select r.property_id, r.stage, r.assignment_sort, r.row_data
    from public.my_leads_queue_rows(p_org, p_member, p_at) r),
  people as (
    select q.*, p.motivation_level, c.do_not_contact,
      array_remove(array[nullif(btrim(c.phone_1), ''), nullif(btrim(c.phone_2), ''), nullif(btrim(c.phone_3), '')], null) as phones
    from q
    join public.properties p on p.id = q.property_id and p.org_id = p_org
    left join public.contacts c on c.id = p.homeowner_contact_id and c.org_id = p_org),
  facts as (
    select pe.*, tf.last_touch_at, tf.last_call_at, tf.last_inbound_at, tf.last_inbound_kind,
      exists (select 1 from public.sequence_enrollments e
              where e.org_id = p_org and e.property_id = pe.property_id and e.status = 'active') as in_drip,
      ov.pinned_at, ov.pinned_until, ov.hidden_until
    from people pe
    left join public.my_leads_touch_facts(p_org, p_member, p_at) tf on tf.property_id = pe.property_id
    left join public.my_leads_strip_overrides ov
      on ov.org_id = p_org and ov.member_id = p_member and ov.property_id = pe.property_id),
  appts as (   -- open appointments only; 'snoozed' is ignored (D1: no snooze)
    select t.related_property_id as property_id, t.due_at,
      exists (select 1 from public.acquisition_offers o
              where o.org_id = p_org and o.property_id = t.related_property_id and o.outcome = 'pending'
                and o.follow_up_calendar_chain_id is not null
                and o.follow_up_calendar_chain_id = t.calendar_chain_id) as is_offer_follow_up
    from public.tasks t
    where t.org_id = p_org and t.next_step_kind = 'appointment' and t.status = 'open'
      and t.related_property_id is not null and t.due_at <= p_at + interval '15 minutes'),
  due as (
    select a.property_id,
      min(a.due_at) filter (where not a.is_offer_follow_up) as appt_due_at,
      min(a.due_at) filter (where a.is_offer_follow_up) as offer_task_due_at
    from appts a group by a.property_id),
  flagged as (
    select f.*,
      coalesce(f.pinned_until > p_at and (f.last_call_at is null or f.last_call_at <= f.pinned_at), false) as is_pinned,
      coalesce(f.hidden_until > p_at, false) as is_hidden,
      case when coalesce(f.do_not_contact, false) then 'contact_dnc'
           when cardinality(f.phones) = 0 then 'no_phone' end as excl
    from facts f
    where not f.in_drip),
  ranked as (
    select fl.*, d.appt_due_at, d.offer_task_due_at, po.follow_up_at as offer_follow_up_at,
      case
        when fl.is_pinned then 0
        when d.appt_due_at is not null then 1
        when fl.last_inbound_at is not null and fl.last_inbound_at > coalesce(fl.last_touch_at, '-infinity') then 2
        when fl.stage = 'needs_offer' and po.property_id is null then 3
        when fl.stage = 'offer_sent'
          and coalesce(d.offer_task_due_at, case when not po.has_chain then po.follow_up_at end) <= p_at then 3
        when fl.motivation_level in ('hot', 'warm') and coalesce(fl.last_touch_at, '-infinity') < p_at - interval '3 days' then 4
        else 5
      end::smallint as tr
    from flagged fl
    left join due d on d.property_id = fl.property_id
    left join lateral (
      select o.property_id, o.follow_up_at, (o.follow_up_calendar_chain_id is not null) as has_chain
      from public.acquisition_offers o
      where o.org_id = p_org and o.property_id = fl.property_id and o.outcome = 'pending'
      order by o.sent_at desc, o.id limit 1) po on true),
  scored as (
    select r.*,
      case r.tr
        when 0 then r.pinned_at
        when 1 then r.appt_due_at
        when 2 then r.last_inbound_at
        when 3 then coalesce(r.offer_task_due_at, r.offer_follow_up_at, (r.row_data ->> 'stageEnteredAt')::timestamptz, r.last_touch_at)
        else r.last_touch_at
      end as at_ts
    from ranked r)
  select s.property_id, s.tr,
    case s.tr
      when 0 then 'pinned_call_today'
      when 1 then case when s.appt_due_at <= p_at then 'appointment_overdue' else 'appointment_due' end
      when 2 then case s.last_inbound_kind when 'call' then 'inbound_call' else 'inbound_text' end
      when 3 then case when s.stage = 'needs_offer' then 'needs_offer' else 'offer_follow_up_overdue' end
      when 4 then case s.motivation_level when 'hot' then 'hot_going_cold' else 'warm_going_cold' end
      else 'longest_since_touch'
    end,
    s.at_ts,
    s.is_pinned, s.is_hidden, s.excl, s.last_touch_at, s.assignment_sort,
    case s.tr
      when 2 then -extract(epoch from s.at_ts)
      when 4 then coalesce(extract(epoch from s.last_touch_at), -1e12)
      when 5 then coalesce(extract(epoch from s.last_touch_at), -1e12)
      else coalesce(extract(epoch from s.at_ts), 0)
    end::double precision,
    s.row_data
  from scored s;
$$;
revoke all on function public.my_leads_call_next_rows(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;

-- The strip read. Default volatility (it calls the non-stable my_leads_require_read_scope), like
-- fn_get_my_leads_queue_row. Owners may read a rep's strip.
create or replace function public.fn_get_my_leads_call_next(p_org_id uuid, p_member_id uuid, p_limit integer default 10)
returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '5s' as $$
declare
  v_at timestamptz := statement_timestamp();
  v_result jsonb;
begin
  perform public.my_leads_require_read_scope(p_org_id, p_member_id);
  if p_limit is null or p_limit < 1 or p_limit > 25 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  with r as materialized (
    select * from public.my_leads_call_next_rows(p_org_id, p_member_id, v_at)),
  top as (
    select * from r where r.excluded_reason is null and not r.hidden
    order by r.tier, r.sort_key, r.assignment_sort, r.property_id
    limit p_limit),
  ex as (
    select * from r where r.excluded_reason is not null
    order by r.assignment_sort, r.property_id
    limit 25)
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'propertyId', t.property_id, 'tier', t.tier, 'reason', t.reason, 'reasonAt', t.reason_at,
        'pinned', t.pinned, 'lastTouchAt', t.last_touch_at, 'row', t.row_data)
        order by t.tier, t.sort_key, t.assignment_sort, t.property_id) from top t), '[]'::jsonb),
    'excluded', coalesce((select jsonb_agg(jsonb_build_object(
        'propertyId', e.property_id, 'address', e.row_data ->> 'address', 'reason', e.excluded_reason)
        order by e.assignment_sort, e.property_id) from ex e), '[]'::jsonb),
    'hiddenCount', (select count(*) from r where r.hidden and r.excluded_reason is null),
    'snapshotAt', v_at)
  into v_result;
  return v_result;
end;
$$;
revoke all on function public.fn_get_my_leads_call_next(uuid, uuid, integer) from public, anon;
grant execute on function public.fn_get_my_leads_call_next(uuid, uuid, integer) to authenticated;

-- Call today / Not today / clear. The member may change only their own overrides (an owner can
-- read a rep's strip, never change it). Midnight is computed here, never taken from the client.
create or replace function public.fn_set_my_leads_strip_override(p_org_id uuid, p_member_id uuid, p_property_id uuid, p_action text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := statement_timestamp();
  v_midnight timestamptz;
begin
  perform public.my_leads_require_read_scope(p_org_id, p_member_id);
  if auth.uid() is distinct from p_member_id then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_property_id is null or p_action is null or p_action not in ('call_today', 'not_today', 'clear') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (select 1 from public.my_leads_queue_rows_for(p_org_id, p_member_id, v_now, p_property_id) r
                 where r.property_id = p_property_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  v_midnight := public.my_leads_next_chicago_midnight(v_now);
  delete from public.my_leads_strip_overrides o
   where o.org_id = p_org_id and o.member_id = p_member_id
     and coalesce(o.pinned_until, o.hidden_until) <= v_now;
  if p_action = 'call_today' then
    insert into public.my_leads_strip_overrides(org_id, member_id, property_id, pinned_at, pinned_until, hidden_until, updated_at)
    values (p_org_id, p_member_id, p_property_id, v_now, v_midnight, null, v_now)
    on conflict (org_id, member_id, property_id) do update
      set pinned_at = excluded.pinned_at, pinned_until = excluded.pinned_until, hidden_until = null, updated_at = v_now;
  elsif p_action = 'not_today' then
    insert into public.my_leads_strip_overrides(org_id, member_id, property_id, pinned_at, pinned_until, hidden_until, updated_at)
    values (p_org_id, p_member_id, p_property_id, null, null, v_midnight, v_now)
    on conflict (org_id, member_id, property_id) do update
      set pinned_at = null, pinned_until = null, hidden_until = excluded.hidden_until, updated_at = v_now;
  else
    delete from public.my_leads_strip_overrides o
     where o.org_id = p_org_id and o.member_id = p_member_id and o.property_id = p_property_id;
  end if;
  return jsonb_build_object('ok', true, 'until', case when p_action = 'clear' then null else v_midnight end);
end;
$$;
revoke all on function public.fn_set_my_leads_strip_override(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.fn_set_my_leads_strip_override(uuid, uuid, uuid, text) to authenticated;

-- One-time triage helper: queue leads not in an active drip, with no open appointment due in the
-- future (any mode), untouched for p_days or never touched. Oldest touch first, never-touched
-- first, keyset paginated on (last_touch_at, property_id).
create or replace function public.fn_get_my_leads_triage(
  p_org_id uuid, p_member_id uuid, p_days integer default 14, p_limit integer default 25,
  p_after_touch timestamptz default null, p_after_property uuid default null)
returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '5s' as $$
declare
  v_at timestamptz := statement_timestamp();
  v_result jsonb;
begin
  perform public.my_leads_require_read_scope(p_org_id, p_member_id);
  if p_days is null or p_days < 1 or p_days > 365 or p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  with cand as materialized (
    select q.property_id, tf.last_touch_at, q.row_data
    from public.my_leads_queue_rows(p_org_id, p_member_id, v_at) q
    left join public.my_leads_touch_facts(p_org_id, p_member_id, v_at) tf on tf.property_id = q.property_id
    where (tf.last_touch_at is null or tf.last_touch_at < v_at - make_interval(days => p_days))
      and not exists (select 1 from public.sequence_enrollments e
                      where e.org_id = p_org_id and e.property_id = q.property_id and e.status = 'active')
      and not exists (select 1 from public.tasks t
                      where t.org_id = p_org_id and t.related_property_id = q.property_id
                        and t.next_step_kind = 'appointment' and t.status = 'open' and t.due_at > v_at)),
  page as (
    select c.* from cand c
    where p_after_property is null
       or (p_after_touch is null and (c.last_touch_at is not null or c.property_id > p_after_property))
       or (p_after_touch is not null and c.last_touch_at is not null
           and (c.last_touch_at > p_after_touch or (c.last_touch_at = p_after_touch and c.property_id > p_after_property)))
    order by c.last_touch_at asc nulls first, c.property_id
    limit p_limit + 1),
  shown as (
    select * from (select pg.*, row_number() over (order by pg.last_touch_at asc nulls first, pg.property_id) as rn from page pg) x
    where x.rn <= p_limit)
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'propertyId', s.property_id, 'lastTouchAt', s.last_touch_at, 'row', s.row_data) order by s.rn) from shown s), '[]'::jsonb),
    'totalCount', (select count(*) from cand),
    'cursor', case when (select count(*) from page) > p_limit then
        (select jsonb_build_object('touch', s.last_touch_at, 'property', s.property_id) from shown s order by s.rn desc limit 1)
      end)
  into v_result;
  return v_result;
end;
$$;
revoke all on function public.fn_get_my_leads_triage(uuid, uuid, integer, integer, timestamptz, uuid) from public, anon;
grant execute on function public.fn_get_my_leads_triage(uuid, uuid, integer, integer, timestamptz, uuid) to authenticated;

commit;
