-- My Leads one-call close, P1c-2 (1c.4): seller morning-of reminder outbox.
--
-- Schema and service-only functions only. NO data step: nothing here inserts or changes a row, and
-- no migration enables any org. Nothing is scheduled until an operator inserts
-- seller_reminder_settings (org_id, enabled=true) AND the my_leads_feature_flags.seller_reminders
-- flag is on AND the application copy constant is non-null (all outside this migration).
-- The existing rep reminder sweep (fn_claim_appointment_reminders) is untouched: this job is
-- read-only against public.tasks and never writes reminder_claimed_at.
begin;

create table public.seller_reminder_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  send_hour_central smallint not null default 9 check (send_hour_central between 8 and 11),
  updated_at timestamptz not null default now()
);

create table public.seller_appointment_reminders (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null,
  task_id uuid not null,
  calendar_chain_id uuid not null,
  property_id uuid not null,
  contact_id uuid,
  due_at timestamptz not null,
  send_at timestamptz not null,
  send_local_date date not null,
  status text not null default 'pending'
    check (status in ('pending','claimed','sent','skipped','cancelled','failed','uncertain')),
  -- pending: waiting, or re-queued after a retryable failure/deferral; claimed: leased;
  -- sent/skipped/cancelled: final; failed: final after 3 definitive provider failures;
  -- uncertain: final, delivery unknown, NEVER resent.
  skip_reason text,
  attempts smallint not null default 0,
  send_key uuid not null default extensions.gen_random_uuid(),
  claim_token uuid,
  claimed_at timestamptz,
  message_id uuid references public.messages(id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seller_appointment_reminders_task_org_fkey
    foreign key (task_id, org_id) references public.tasks(id, org_id) on delete cascade,
  unique (task_id),
  unique (send_key),
  constraint seller_appointment_reminders_send_key_v4
    check (send_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);

-- One send per appointment (chain) per Chicago day (an uncertain row may have sent, so it holds the slot too): a reschedule makes a new task row, not a second text.
create unique index seller_appointment_reminders_one_send
  on public.seller_appointment_reminders (calendar_chain_id, send_local_date)
  where status in ('claimed','sent','uncertain');
create index seller_appointment_reminders_due_idx
  on public.seller_appointment_reminders (send_at) where status in ('pending','claimed');

alter table public.seller_reminder_settings enable row level security;
alter table public.seller_appointment_reminders enable row level security;
revoke all on public.seller_reminder_settings, public.seller_appointment_reminders
  from public, anon, authenticated, service_role;
-- The job reads only the on/off switch directly; every other access goes through the functions below.
grant select on public.seller_reminder_settings to service_role;

-- 1. schedule + cancel ------------------------------------------------------------------------------
create or replace function public.fn_schedule_seller_reminders(
  p_horizon interval default '36 hours',
  p_limit integer default 200,
  p_org_ids uuid[] default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare
  v_scheduled integer := 0;
  v_skipped integer := 0;
  v_cancelled_task integer := 0;
  v_cancelled_disabled integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_horizon is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  -- (b) cancel first, so a reschedule successor in the same run is not blocked by its predecessor.
  -- Only PENDING rows are cancelled here. A claimed row (fresh or stale) may be mid-dispatch or may have
  -- sent before a crash: cancelling it would free its one-per-day slot while a text may have gone out.
  -- Dispatch rechecks the task, switch and copy itself and finishes the row; a stale lease is reclaimed
  -- with the same key (safe replay) or, at 3 attempts, made uncertain.
  update public.seller_appointment_reminders r
     set status = 'cancelled', skip_reason = 'task_changed', claim_token = null, updated_at = now()
   where r.status = 'pending'
     and not exists (
       select 1 from public.tasks t
        where t.id = r.task_id and t.org_id = r.org_id
          and t.status = 'open' and t.mode = 'phone' and t.due_at = r.due_at);
  get diagnostics v_cancelled_task = row_count;

  update public.seller_appointment_reminders r
     set status = 'cancelled', skip_reason = 'reminders_disabled', claim_token = null, updated_at = now()
   where r.status = 'pending'
     and not exists (
       select 1 from public.seller_reminder_settings s where s.org_id = r.org_id and s.enabled);
  get diagnostics v_cancelled_disabled = row_count;

  -- (a) insert one row per open phone appointment in the horizon for enabled orgs.
  with candidates as (
    select t.id as task_id, t.org_id, t.calendar_chain_id, t.related_property_id as property_id,
           coalesce(t.contact_id, p.homeowner_contact_id) as contact_id, t.due_at, s.send_hour_central,
           (t.due_at at time zone 'America/Chicago')::date as local_date
      from public.tasks t
      join public.seller_reminder_settings s on s.org_id = t.org_id and s.enabled
      join public.properties p on p.id = t.related_property_id and p.org_id = t.org_id and p.deleted_at is null
     where t.type = 'appointment' and t.mode = 'phone' and t.status = 'open'
       and t.calendar_chain_id is not null
       and t.due_at > now() and t.due_at <= now() + p_horizon
       and (p_org_ids is null or t.org_id = any (p_org_ids))
       and not exists (select 1 from public.seller_appointment_reminders r where r.task_id = t.id)
     order by t.due_at
     limit p_limit
  ), timed as (
    select c.*,
           ((c.local_date::timestamp + interval '8 hours') at time zone 'America/Chicago') as day_open,
           least(((c.local_date::timestamp + make_interval(hours => c.send_hour_central::integer))
                    at time zone 'America/Chicago'),
                 c.due_at - interval '30 minutes') as target,
           -- Consent at scheduling time: no recipient, or a recorded STOP / do-not-contact, is never scheduled.
           (c.contact_id is null) as no_contact,
           (c.contact_id is not null and (
              exists (select 1 from public.contacts k
                       where k.id = c.contact_id and (k.do_not_contact or k.sms_opted_out))
              or coalesce((select e.event_type in ('opt_out','provider_auto_opt_out')
                             from public.consent_events e
                            where e.contact_id = c.contact_id and e.channel = 'sms'
                              and e.event_type in ('opt_out','provider_auto_opt_out','opt_in_marketing_written',
                                                   'opt_in_confirmed','opt_in_informational')
                            order by e.occurred_at desc, e.created_at desc limit 1), false))) as opted_out
      from candidates c
  ), decided as (
    select t.*,
           case
             when t.no_contact then 'no_contact'
             when t.opted_out then 'opted_out'
             when t.target < t.day_open then 'too_early_for_reminder'
             when t.target < now() and t.due_at - now() < interval '30 minutes' then 'created_too_late'
             else null
           end as skip_reason
      from timed t
  ), ins as (
    insert into public.seller_appointment_reminders
      (org_id, task_id, calendar_chain_id, property_id, contact_id, due_at, send_at, send_local_date, status, skip_reason)
    select d.org_id, d.task_id, d.calendar_chain_id, d.property_id, d.contact_id, d.due_at,
           case when d.skip_reason is null and d.target < now() then now() else d.target end,
           d.local_date,
           case when d.skip_reason is null then 'pending' else 'skipped' end,
           d.skip_reason
      from decided d
    on conflict (task_id) do nothing
    returning status
  )
  select count(*) filter (where status = 'pending'), count(*) filter (where status = 'skipped')
    into v_scheduled, v_skipped from ins;

  return jsonb_build_object(
    'scheduled', v_scheduled, 'skipped', v_skipped,
    'cancelledTaskChanged', v_cancelled_task, 'cancelledDisabled', v_cancelled_disabled);
end;
$function$;

-- 2. claim ------------------------------------------------------------------------------------------
create or replace function public.fn_claim_seller_reminders(
  p_limit integer default 1,
  p_org_ids uuid[] default null
) returns table (
  id uuid, org_id uuid, task_id uuid, calendar_chain_id uuid, property_id uuid, contact_id uuid,
  due_at timestamptz, send_at timestamptz, send_local_date date, attempts smallint,
  claim_token uuid, send_key uuid,
  property_state text, outreach_dispo text, do_not_contact boolean, sms_opted_out boolean,
  task_title text, task_due_at timestamptz, task_status text, task_mode text, contact_first_name text)
language plpgsql security definer set search_path = ''
as $function$
#variable_conflict use_column
declare
  v_id uuid;
  v_ids uuid[] := '{}';
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  -- A stale claim that already used its attempts may have sent: terminal, never selected again.
  update public.seller_appointment_reminders r
     set status = 'uncertain', skip_reason = 'unknown_delivery', claim_token = null, updated_at = now()
   where r.status = 'claimed' and r.claimed_at < now() - interval '10 minutes' and r.attempts >= 3;

  for v_id in
    select r.id
      from public.seller_appointment_reminders r
      join public.seller_reminder_settings s on s.org_id = r.org_id and s.enabled
     where ((r.status = 'pending' and r.send_at <= now())
         or (r.status = 'claimed' and r.claimed_at < now() - interval '10 minutes' and r.attempts < 3))
       and (p_org_ids is null or r.org_id = any (p_org_ids))
     order by r.send_at
     limit p_limit
     for update of r skip locked
  loop
    begin
      update public.seller_appointment_reminders r
         set status = 'claimed', claim_token = extensions.gen_random_uuid(), claimed_at = now(),
             attempts = r.attempts + 1, updated_at = now()
       where r.id = v_id;
      v_ids := v_ids || v_id;
    exception when unique_violation then
      -- another row of the same appointment already holds or used this day's send
      update public.seller_appointment_reminders r
         set status = 'skipped', skip_reason = 'duplicate_for_appointment_day', claim_token = null, updated_at = now()
       where r.id = v_id;
    end;
  end loop;

  return query
  select r.id, r.org_id, r.task_id, r.calendar_chain_id, r.property_id, r.contact_id,
         r.due_at, r.send_at, r.send_local_date, r.attempts, r.claim_token, r.send_key,
         p.state::text, p.outreach_dispo::text, k.do_not_contact, k.sms_opted_out,
         t.title::text, t.due_at, t.status::text, t.mode::text, k.first_name::text
    from public.seller_appointment_reminders r
    join public.tasks t on t.id = r.task_id and t.org_id = r.org_id
    join public.properties p on p.id = r.property_id
    left join public.contacts k on k.id = r.contact_id
   where r.id = any (v_ids)
   order by r.send_at;
end;
$function$;

-- 3. finish -----------------------------------------------------------------------------------------
create or replace function public.fn_finish_seller_reminder(
  p_id uuid,
  p_token uuid,
  p_status text,
  p_reason text default null,
  p_message_id uuid default null,
  p_retry_at timestamptz default null,
  p_new_send_key uuid default null
) returns boolean
language plpgsql security definer set search_path = ''
as $function$
declare
  v_rows integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_id is null or p_token is null
     or p_status is null or p_status not in ('sent','skipped','cancelled','failed','uncertain','pending') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_status = 'pending' and p_retry_at is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_status <> 'pending' and (p_new_send_key is not null or p_retry_at is not null) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  if p_status = 'pending' then
    -- A retry after a definitive provider failure carries a fresh key (the transport replays a reused
    -- key's stored result); the third failed attempt is final. A deferral (no key) did not try the
    -- provider, so it gives the attempt back.
    update public.seller_appointment_reminders r
       set status = case when p_new_send_key is not null and r.attempts >= 3 then 'failed' else 'pending' end,
           skip_reason = p_reason,
           send_at = p_retry_at,
           send_key = case when p_new_send_key is not null and r.attempts < 3 then p_new_send_key else r.send_key end,
           attempts = case when p_new_send_key is null then greatest(r.attempts - 1, 0) else r.attempts end,
           claim_token = null, claimed_at = null, updated_at = now()
     where r.id = p_id and r.claim_token = p_token and r.status = 'claimed';
  else
    update public.seller_appointment_reminders r
       set status = p_status,
           skip_reason = p_reason,
           message_id = coalesce(p_message_id, r.message_id),
           sent_at = case when p_status = 'sent' then now() else r.sent_at end,
           claim_token = null, claimed_at = null, updated_at = now()
     where r.id = p_id and r.claim_token = p_token and r.status = 'claimed';
  end if;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$function$;

revoke all on function public.fn_schedule_seller_reminders(interval, integer, uuid[]) from public, anon, authenticated;
revoke all on function public.fn_claim_seller_reminders(integer, uuid[]) from public, anon, authenticated;
revoke all on function public.fn_finish_seller_reminder(uuid, uuid, text, text, uuid, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.fn_schedule_seller_reminders(interval, integer, uuid[]) to service_role;
grant execute on function public.fn_claim_seller_reminders(integer, uuid[]) to service_role;
grant execute on function public.fn_finish_seller_reminder(uuid, uuid, text, text, uuid, timestamptz, uuid) to service_role;

commit;
