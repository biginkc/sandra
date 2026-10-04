-- My Leads one-call close, P1a-writers (1a.6): offer follow-up chain, propagation and guards.
--
-- Logging an offer now creates its follow-up as a phone appointment in the same transaction,
-- through fn_create_next_step, and stores the appointment CHAIN id on the offer (not a task
-- id: a reschedule closes the old task and inserts a successor in the same chain).
-- Three triggers keep the offer and the chain in step:
--   1. a reschedule successor on the chain moves offer.follow_up_at (never before sent_at);
--   2. a direct cancel of a pending offer's follow-up is refused (reschedule it or record the
--      offer outcome instead);
--   3. any offer outcome leaving 'pending' cancels the chain's open follow-up (cancelled, not
--      held: cancelled is KPI-neutral, held would inflate appointments kept). One constant:
--      the 'cancelled' status/outcome pair in trigger 3.
-- Also ships fn_my_leads_backfill_offer_follow_ups, the operator run that gives existing
-- pending offers their follow-up. NO data step runs when this migration applies: the merge
-- auto-applies to production, so the backfill is a housekeeping run kind (preview, then
-- --apply --confirm <fingerprint>) executed by scripts/my-leads-housekeeping.mjs
-- offer-backfill after a pasted preview is approved.
-- fn_log_acquisition_offer is the 20261003130000 body plus the follow-up creation and the
-- chain column in the offer insert; its signature is unchanged. The housekeeping rollback
-- entry point and fingerprint are copy-replaced from 20261005121500 (adds the
-- offer_follow_up_backfill branch; other branches byte-identical).
begin;

alter table public.acquisition_offers add column follow_up_calendar_chain_id uuid;
create index acquisition_offers_follow_up_chain_idx
  on public.acquisition_offers (org_id, follow_up_calendar_chain_id)
  where follow_up_calendar_chain_id is not null;

-- Internal helper (not callable by any API role): creates an offer's follow-up appointment and
-- stores its chain on the offer. Everything is derived from the offer row, so a caller can only
-- say WHEN. fn_create_next_step stays browser-strict: the call below uses origin 'offer', the
-- booking window and no source key (the key is stamped on the row afterwards), and runs as the
-- offer's actor, who is the authenticated caller of fn_log_acquisition_offer.
create or replace function public.fn_create_offer_follow_up_internal(p_offer_id uuid, p_due_at timestamptz)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_offer public.acquisition_offers%rowtype;
  v_prop public.properties%rowtype;
  v_follow jsonb;
begin
  select * into v_offer from public.acquisition_offers o where o.id = p_offer_id for update;
  if not found then
    raise exception 'NOT_FOUND: offer' using errcode = 'P0002';
  end if;
  if v_offer.outcome <> 'pending' or v_offer.follow_up_calendar_chain_id is not null then
    raise exception 'INVALID_INPUT: offer already has a follow-up or is resolved' using errcode = '22023';
  end if;
  if p_due_at is null or not isfinite(p_due_at) or p_due_at <= v_offer.sent_at
     or p_due_at > statement_timestamp() + interval '2 years' then
    raise exception 'INVALID_INPUT: follow-up must be after the offer was sent and within 2 years'
      using errcode = '22023';
  end if;
  select * into v_prop from public.properties p where p.id = v_offer.property_id and p.org_id = v_offer.org_id;
  v_follow := public.fn_create_next_step(
    p_org := v_offer.org_id, p_actor := v_offer.actor_user_id,
    p_assignee := coalesce(v_prop.assigned_user_id, v_offer.actor_user_id),
    p_kind := 'appointment', p_title := 'Offer follow-up', p_due_at := p_due_at,
    p_property := v_offer.property_id, p_contact := v_prop.homeowner_contact_id,
    p_mode := 'phone', p_origin := 'offer', p_enforce_window := true);
  update public.tasks
  set source_key = 'offer_follow_up:' || v_offer.id::text
  where id = (v_follow ->> 'task_id')::uuid and org_id = v_offer.org_id;
  update public.acquisition_offers
  set follow_up_calendar_chain_id = (v_follow ->> 'calendar_chain_id')::uuid
  where id = v_offer.id and org_id = v_offer.org_id;
  return v_follow;
end $$;

CREATE OR REPLACE FUNCTION public.fn_log_acquisition_offer(p_org_id uuid, p_property_id uuid, p_expected_episode_id uuid, p_expected_queue_version bigint, p_expected_shared_status text, p_idempotency_key uuid, p_amount_cents bigint, p_sent_via text, p_sent_at timestamp with time zone, p_follow_up_at timestamp with time zone, p_motivation_kind text DEFAULT NULL::text, p_motivation_text text DEFAULT NULL::text, p_temperature text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid := public.my_leads_workflow_require_actor(p_org_id);
  v_hash text;
  v_replay jsonb;
  v_command_id uuid := extensions.gen_random_uuid();
  v_offer_id uuid := extensions.gen_random_uuid();
  v_result jsonb;
  v_property public.properties%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_pending public.acquisition_offers%rowtype;
  v_role text;
  v_queue_exists boolean;
  v_episode_exists boolean;
  v_version bigint;
  v_kind text;
  v_text text;
  v_due timestamptz;
begin
  if p_property_id is null or p_expected_episode_id is null
     or p_expected_queue_version is null or p_expected_queue_version < 0
     or p_expected_shared_status is null or p_idempotency_key is null
     or p_amount_cents is null or p_amount_cents <= 0
     or p_sent_via not in ('dropbox_sign', 'verbal', 'email_text')
     or p_sent_at is null or p_follow_up_at is null
     or not isfinite(p_sent_at) or not isfinite(p_follow_up_at)
     or p_sent_at > statement_timestamp() or p_follow_up_at <= p_sent_at then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_temperature is not null and p_temperature not in ('hot', 'warm', 'cold') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_motivation_kind is not null then
    perform public.my_leads_workflow_assert_motivation(p_motivation_kind, p_motivation_text);
  elsif p_motivation_text is not null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_hash := public.my_leads_command_hash(
    'log_acquisition_offer', p_org_id, v_actor,
    jsonb_build_object(
      'propertyId', p_property_id, 'expectedEpisodeId', p_expected_episode_id,
      'expectedQueueVersion', p_expected_queue_version,
      'expectedSharedStatus', p_expected_shared_status, 'amountCents', p_amount_cents,
      'sentVia', p_sent_via, 'sentAt', p_sent_at, 'followUpAt', p_follow_up_at,
      'motivationKind', p_motivation_kind, 'motivationText', p_motivation_text,
      'temperature', p_temperature
    )
  );
  perform pg_advisory_xact_lock(hashtextextended(
    format('my-leads:%s:%s:%s', p_org_id, 'log_acquisition_offer', p_idempotency_key), 0
  ));
  v_replay := public.my_leads_workflow_replay(
    p_org_id, 'log_acquisition_offer', p_idempotency_key, v_actor, v_hash
  );
  if v_replay is not null then return v_replay; end if;
  if not exists (select 1 from public.acquisition_org_settings s where s.org_id = p_org_id and s.my_leads_enabled) then
    raise exception 'FEATURE_DISABLED' using errcode = '42501';
  end if;

  select * into v_property from public.properties p
  where p.id = p_property_id and p.org_id = p_org_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_property.is_dnc_locked or v_property.outreach_dispo = 'dnc' then
    raise exception 'DNC_LOCKED' using errcode = '42501';
  end if;
  if v_property.status is distinct from p_expected_shared_status then
    raise exception 'STALE_STATE' using errcode = 'MLS01';
  end if;
  select m.role into v_role from public.memberships m
  where m.org_id = p_org_id and m.user_id = v_actor and m.access_status = 'active'
    and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > statement_timestamp());
  if v_role is null then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if v_role <> 'owner' and v_property.assigned_user_id is distinct from v_actor then
    raise exception 'STALE_ASSIGNMENT' using errcode = 'MLS01';
  end if;
  if v_property.status in ('offer_declined', 'under_contract', 'closed', 'dead') then
    raise exception 'STALE_STATE' using errcode = 'MLS01';
  end if;

  select * into v_queue from public.acquisition_queue_states q
  where q.org_id = p_org_id and q.property_id = p_property_id for update;
  v_queue_exists := found;
  v_version := coalesce(v_queue.version, 0);
  if v_version <> p_expected_queue_version then raise exception 'STALE_STATE' using errcode = 'MLS01'; end if;
  if v_queue.archived_at is not null or v_queue.stage = 'under_contract' then
    raise exception 'STALE_STATE' using errcode = 'MLS01';
  end if;
  select * into v_episode from public.acquisition_assignment_episodes e
  where e.org_id = p_org_id and e.property_id = p_property_id and e.ended_at is null for update;
  v_episode_exists := found;
  if not v_episode_exists or v_episode.id is distinct from p_expected_episode_id then
    raise exception 'STALE_ASSIGNMENT' using errcode = 'MLS01';
  end if;
  select * into v_pending from public.acquisition_offers o
  where o.org_id = p_org_id and o.property_id = p_property_id and o.outcome = 'pending'
  for update;
  if found then raise exception 'PENDING_OFFER_EXISTS' using errcode = 'MLS01'; end if;

  if v_queue.motivation_recorded then
    if p_motivation_kind is not null and (
      v_queue.motivation_kind is distinct from p_motivation_kind or
      v_queue.motivation_text is distinct from nullif(btrim(p_motivation_text), '')
    ) then
      raise exception 'STALE_STATE' using errcode = 'MLS01';
    end if;
    v_kind := v_queue.motivation_kind;
    v_text := v_queue.motivation_text;
  else
    if p_motivation_kind is null then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
    perform public.my_leads_workflow_assert_motivation(p_motivation_kind, p_motivation_text);
    v_kind := p_motivation_kind;
    v_text := case when p_motivation_kind = 'specified' then btrim(p_motivation_text) end;
  end if;
  -- Offers retain their originating command through a composite FK. Reserve
  -- the receipt before inserting the fact, then fill its result after all
  -- state changes have succeeded.
  insert into public.acquisition_commands (
    id, org_id, actor_user_id, actor_kind, operation, idempotency_key, request_hash, result
  ) values (
    v_command_id, p_org_id, v_actor, 'user', 'log_acquisition_offer',
    p_idempotency_key, v_hash, '{}'::jsonb
  );
  if v_queue_exists then
    update public.acquisition_queue_states q
    set stage = 'offer_sent', stage_entered_at = p_sent_at,
        motivation_recorded = true, motivation_kind = v_kind, motivation_text = v_text,
        motivation_recorded_at = coalesce(q.motivation_recorded_at, statement_timestamp()),
        motivation_recorded_by = coalesce(q.motivation_recorded_by, v_actor),
        version = q.version + 1, updated_at = statement_timestamp()
    where q.org_id = p_org_id and q.property_id = p_property_id;
  else
    insert into public.acquisition_queue_states (
      org_id, property_id, stage, stage_entered_at, motivation_recorded,
      motivation_kind, motivation_text, motivation_recorded_at, motivation_recorded_by, version
    ) values (
      p_org_id, p_property_id, 'offer_sent', p_sent_at, true, v_kind, v_text,
      statement_timestamp(), v_actor, 1
    );
  end if;
  if p_temperature is not null then
    update public.properties set motivation_level = p_temperature where id = p_property_id and org_id = p_org_id;
  end if;
  -- The offer's own follow_up_at is stored as entered (history; closed KPI windows must not
  -- move). Its follow-up APPOINTMENT is never in the past: a back-dated offer's appointment is
  -- clamped to the next 09:00 America/Chicago and shows up as due then. Created right after the
  -- offer row exists, by an internal helper that derives everything from that row.
  v_due := p_follow_up_at;
  if v_due <= statement_timestamp() then
    v_due := (date_trunc('day', statement_timestamp() at time zone 'America/Chicago') + interval '9 hours'
      + case when (statement_timestamp() at time zone 'America/Chicago')::time >= time '09:00'
             then interval '1 day' else interval '0' end) at time zone 'America/Chicago';
  end if;
  insert into public.acquisition_offers (
    id, org_id, property_id, assignment_episode_id, actor_user_id,
    amount_cents, sent_via, sent_at, follow_up_at, idempotency_key, command_id
  ) values (
    v_offer_id, p_org_id, p_property_id, v_episode.id, v_actor,
    p_amount_cents, p_sent_via, p_sent_at, p_follow_up_at, p_idempotency_key, v_command_id
  );
  perform public.fn_create_offer_follow_up_internal(v_offer_id, v_due);
  update public.properties set status = 'offer_sent', updated_at = statement_timestamp()
  where id = p_property_id and org_id = p_org_id
    and status in ('prospect', 'new_lead', 'contacted', 'interested');
  v_result := jsonb_build_object(
    'ok', true, 'duplicate', false, 'propertyId', p_property_id,
    'queueVersion', v_version + 1, 'stage', 'offer_sent', 'archived', false,
    'offerId', v_offer_id, 'assignmentEpisodeId', v_episode.id
  );
  update public.acquisition_commands set result = v_result
  where id = v_command_id and org_id = p_org_id;
  perform public.my_leads_workflow_append_event(
    p_org_id, p_property_id, v_actor, v_command_id, 'log_acquisition_offer',
    jsonb_build_object('offerId', v_offer_id, 'stage', 'offer_sent')
  );
  return v_result;
end;
$function$;
-- (grants for fn_log_acquisition_offer are unchanged: create or replace keeps them)

-- 1. A new row in the offer's chain (reschedule or reassign successor) moves the offer's
-- follow_up_at. The offer's own first task is inserted before the offer row exists, so it
-- finds nothing here (and neither does a backfill task, whose chain is attached afterwards).
create or replace function public.trg_tasks_offer_follow_up_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_offer public.acquisition_offers%rowtype;
begin
  select * into v_offer from public.acquisition_offers o
  where o.org_id = new.org_id and o.follow_up_calendar_chain_id = new.calendar_chain_id
    and o.outcome = 'pending'
  for update;
  if not found then
    return new;
  end if;
  if new.due_at <= v_offer.sent_at then
    raise exception 'OFFER_FOLLOW_UP_BEFORE_SENT: the follow-up cannot be before the offer was sent'
      using errcode = 'P0001';
  end if;
  update public.acquisition_offers
  set follow_up_at = new.due_at, updated_at = statement_timestamp()
  where id = v_offer.id and org_id = v_offer.org_id;
  return new;
end $$;

create trigger trg_tasks_offer_follow_up_sync
  after insert on public.tasks
  for each row
  when (new.type = 'appointment' and new.calendar_chain_id is not null)
  execute function public.trg_tasks_offer_follow_up_sync();

-- 2. Only the offer outcome (trigger 3) may cancel a pending offer's follow-up.
create or replace function public.trg_tasks_offer_follow_up_cancel_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('sandra.allow_offer_follow_up_close', true), '') = 'on' then
    return new;
  end if;
  if exists (
    select 1 from public.acquisition_offers o
    where o.org_id = old.org_id and o.follow_up_calendar_chain_id = old.calendar_chain_id
      and o.outcome = 'pending'
  ) then
    raise exception 'OFFER_FOLLOW_UP_PENDING: reschedule it or record the offer outcome instead'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger trg_tasks_offer_follow_up_cancel_guard
  before update of status on public.tasks
  for each row
  when (old.type = 'appointment' and new.status = 'cancelled' and old.status <> 'cancelled')
  execute function public.trg_tasks_offer_follow_up_cancel_guard();

-- 3. An offer leaving 'pending' (contract recorded, offer declined, or a future 'superseded')
-- cancels the chain's open follow-up. Both bypass settings are restored to their previous
-- values afterwards, so the rest of the transaction is guarded again.
create or replace function public.trg_acquisition_offer_close_follow_up() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_move text := coalesce(current_setting('sandra.allow_appointment_time_move', true), '');
  v_close text := coalesce(current_setting('sandra.allow_offer_follow_up_close', true), '');
  t record;
begin
  if new.follow_up_calendar_chain_id is null then
    return new;
  end if;
  perform set_config('sandra.allow_appointment_time_move', 'on', true);
  perform set_config('sandra.allow_offer_follow_up_close', 'on', true);
  for t in
    update public.tasks
    set status = 'cancelled', outcome = 'cancelled',
        calendar_generation = calendar_generation + 1, updated_at = now()
    where org_id = new.org_id and calendar_chain_id = new.follow_up_calendar_chain_id
      and type = 'appointment' and status in ('open', 'snoozed')
    returning id, mode, calendar_chain_id, calendar_generation, assignee_id, google_calendar_event_id
  loop
    -- Phone appointments never reach Google, so no ledger row. An in-person follow-up (a
    -- later mode change) needs its event removed, exactly as fn_cancel_appointment does.
    if t.mode = 'in_person' then
      insert into public.task_calendar_mutations (
        org_id, calendar_chain_id, operation, phase,
        source_task_id, old_assignee_id, event_id, expected_generation
      ) values (
        new.org_id, t.calendar_chain_id, 'cancel', 'pending',
        t.id, t.assignee_id, t.google_calendar_event_id, t.calendar_generation);
    end if;
  end loop;
  perform set_config('sandra.allow_appointment_time_move', v_move, true);
  perform set_config('sandra.allow_offer_follow_up_close', v_close, true);
  return new;
end $$;

create trigger trg_acquisition_offer_close_follow_up
  after update of outcome on public.acquisition_offers
  for each row
  when (old.outcome = 'pending' and new.outcome <> 'pending')
  execute function public.trg_acquisition_offer_close_follow_up();

-- Backfill (operator run, kind 'offer_follow_up_backfill'). Candidate = pending offer with no
-- follow-up chain on a live, not DNC-locked lead.
create or replace function public.my_leads_offer_backfill_candidate_ids(p_org_id uuid)
returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(o.id order by o.id), '{}'::uuid[])
  from public.acquisition_offers o
  join public.properties p on p.id = o.property_id and p.org_id = o.org_id
  where o.org_id = p_org_id
    and o.outcome = 'pending'
    and o.follow_up_calendar_chain_id is null
    and p.deleted_at is null
    and not coalesce(p.is_dnc_locked, false)
$$;

-- Each offer's appointment keeps its own follow_up_at exactly when that is still in the
-- future, otherwise it moves to the next 09:00 America/Chicago strictly after the run, so no
-- backfilled appointment is ever in the past (an attribution row stamped at a due time
-- inside a closed historical window would change that window's KPIs). The offer's own
-- follow_up_at is left at its historical value. The id array is built once, under the
-- candidate locks on apply; the fingerprint covers exactly those rows, the actor, the next
-- 09:00 and each offer's overdue-or-future classification, so a row crossing "now" between
-- preview and apply makes the preview stale.
create or replace function public.fn_my_leads_backfill_offer_follow_ups(
  p_org_id uuid,
  p_actor uuid,
  p_apply boolean default false,
  p_fingerprint text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := statement_timestamp();
  v_next_nine timestamptz;
  v_ids uuid[];
  v_count int;
  v_overdue int;
  v_min timestamptz;
  v_max timestamptz;
  v_skipped_locked int;
  v_by_assignee jsonb;
  v_sample jsonb;
  v_fp text;
  v_preview jsonb;
  v_run uuid;
  o record;
  v_due timestamptz;
  v_follow jsonb;
  v_task_id uuid;
  v_chain uuid;
  v_applied_updated timestamptz;
  v_applied_generation int;
  v_captured timestamptz;
  v_accountable uuid;
  v_created int := 0;
  v_moved int := 0;
  v_kept int := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  perform public.my_leads_housekeeping_require_service();
  if p_org_id is null or p_actor is null then
    raise exception 'INVALID_INPUT: org and actor are required' using errcode = 'P0001';
  end if;
  perform 1 from public.memberships m
  where m.org_id = p_org_id and m.user_id = p_actor and m.access_status = 'active'
    and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > v_now);
  if not found then
    raise exception 'INVALID_ACTOR: actor must be an active member of the org' using errcode = 'P0001';
  end if;
  v_next_nine := (date_trunc('day', v_now at time zone 'America/Chicago') + interval '9 hours'
    + case when (v_now at time zone 'America/Chicago')::time >= time '09:00'
           then interval '1 day' else interval '0' end) at time zone 'America/Chicago';

  if p_apply then
    if p_fingerprint is null then
      raise exception 'FINGERPRINT_REQUIRED: apply needs the fingerprint from the preview' using errcode = 'P0001';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('my-leads-housekeeping:' || p_org_id::text, 0));
    -- Lock order property -> offer, as the offer commands do.
    perform 1 from public.properties p
    where p.org_id = p_org_id and p.id in (
      select o2.property_id from public.acquisition_offers o2
      where o2.org_id = p_org_id and o2.id = any(public.my_leads_offer_backfill_candidate_ids(p_org_id)))
    order by p.id for update;
    perform 1 from public.acquisition_offers o2
    where o2.org_id = p_org_id and o2.id = any(public.my_leads_offer_backfill_candidate_ids(p_org_id))
    order by o2.id for update;
  end if;
  v_ids := public.my_leads_offer_backfill_candidate_ids(p_org_id);
  v_count := coalesce(array_length(v_ids, 1), 0);

  select count(*) filter (where of.follow_up_at <= v_now)::int, min(of.follow_up_at), max(of.follow_up_at)
  into v_overdue, v_min, v_max
  from public.acquisition_offers of where of.org_id = p_org_id and of.id = any(v_ids);
  select coalesce(jsonb_agg(jsonb_build_object('assignee', s.assignee, 'count', s.n) order by s.assignee), '[]'::jsonb)
  into v_by_assignee
  from (select coalesce(p.assigned_user_id, p_actor) as assignee, count(*) as n
        from public.acquisition_offers of
        join public.properties p on p.id = of.property_id and p.org_id = of.org_id
        where of.org_id = p_org_id and of.id = any(v_ids) group by 1) s;
  select coalesce(jsonb_agg(u.x order by u.x), '[]'::jsonb) into v_sample
  from unnest(v_ids[1:20]) as u(x);
  -- Visibility only: pending offers with no chain on a deleted or DNC-locked lead (never touched).
  select count(*)::int into v_skipped_locked
  from public.acquisition_offers of
  join public.properties p on p.id = of.property_id and p.org_id = of.org_id
  where of.org_id = p_org_id and of.outcome = 'pending' and of.follow_up_calendar_chain_id is null
    and (p.deleted_at is not null or coalesce(p.is_dnc_locked, false));

  select encode(sha256(convert_to('offer_follow_up_backfill|' || p_actor::text || '|' || v_next_nine::text || '|' ||
           coalesce(string_agg(
             of.id::text || ':' || of.property_id::text || ':' || of.outcome || ':' || of.follow_up_at::text || ':' ||
             coalesce(of.follow_up_calendar_chain_id::text, '') || ':' ||
             coalesce(p.assigned_user_id, p_actor)::text || ':' || (of.follow_up_at > v_now)::text,
             ',' order by of.id), ''), 'utf8')), 'hex')
  into v_fp
  from public.acquisition_offers of
  join public.properties p on p.id = of.property_id and p.org_id = of.org_id
  where of.org_id = p_org_id and of.id = any(v_ids);

  v_preview := jsonb_build_object(
    'kind', 'offer_follow_up_backfill',
    'actor', p_actor,
    'candidates', v_count,
    'earliestFollowUp', v_min,
    'latestFollowUp', v_max,
    'overdue', v_overdue,
    'overdueMovedToNextNine', v_overdue,
    'keptExact', v_count - v_overdue,
    'nextNine', v_next_nine,
    'skippedLocked', v_skipped_locked,
    'byAssignee', v_by_assignee,
    'sample', v_sample,
    'fingerprint', v_fp);

  if not p_apply then
    return v_preview;
  end if;
  if p_fingerprint is distinct from v_fp then
    raise exception 'FINGERPRINT_MISMATCH: the cohort changed since the preview; run a new preview' using errcode = 'P0001';
  end if;
  if v_count = 0 then
    return v_preview || jsonb_build_object('noop', true, 'runId', null);
  end if;

  insert into public.my_leads_housekeeping_runs (org_id, kind, params, created_at)
  values (p_org_id, 'offer_follow_up_backfill', jsonb_build_object(
    'actor', p_actor, 'nextNine', v_next_nine, 'fingerprint', v_fp), clock_timestamp())
  returning id into v_run;

  for o in
    select of.id, of.property_id, of.follow_up_at, of.outcome, p.assigned_user_id, p.homeowner_contact_id
    from public.acquisition_offers of
    join public.properties p on p.id = of.property_id and p.org_id = of.org_id
    where of.org_id = p_org_id and of.id = any(v_ids)
    order by of.id
  loop
    begin
      -- Before-image first; the offer is changed only where one exists.
      insert into public.my_leads_housekeeping_before_images (run_id, table_name, row_id, before)
      values (v_run, 'acquisition_offers', o.id, jsonb_build_object(
        'op', 'updated', 'follow_up_calendar_chain_id', null, 'follow_up_at', o.follow_up_at,
        'outcome', o.outcome, 'property_id', o.property_id));
      v_due := case when o.follow_up_at > v_now then o.follow_up_at else v_next_nine end;
      v_follow := public.fn_create_next_step(
        p_org := p_org_id, p_actor := p_actor,
        p_assignee := coalesce(o.assigned_user_id, p_actor),
        p_kind := 'appointment', p_title := 'Offer follow-up', p_due_at := v_due,
        p_property := o.property_id, p_contact := o.homeowner_contact_id,
        p_mode := 'phone', p_source_key := 'offer_follow_up:' || o.id::text,
        p_origin := 'offer_backfill');
      v_task_id := (v_follow ->> 'task_id')::uuid;
      v_chain := (v_follow ->> 'calendar_chain_id')::uuid;
      select tk.updated_at, tk.calendar_generation into v_applied_updated, v_applied_generation
      from public.tasks tk where tk.id = v_task_id and tk.org_id = p_org_id;
      insert into public.my_leads_housekeeping_before_images (run_id, table_name, row_id, before)
      values (v_run, 'tasks', v_task_id, jsonb_build_object(
        'op', 'created', 'offer_id', o.id, 'property_id', o.property_id,
        'applied_updated_at', v_applied_updated, 'applied_due_at', v_due,
        'applied_calendar_chain_id', v_chain, 'applied_generation', v_applied_generation));
      select aa.captured_at, aa.accountable_user_id into v_captured, v_accountable
      from public.acquisition_appointment_attribution aa
      where aa.task_id = v_task_id and aa.org_id = p_org_id and aa.source = 'offer_backfill';
      if found then
        insert into public.my_leads_housekeeping_before_images (run_id, table_name, row_id, before)
        values (v_run, 'acquisition_appointment_attribution', v_task_id, jsonb_build_object(
          'op', 'created', 'source', 'offer_backfill', 'accountable_user_id', v_accountable,
          'applied_captured_at', v_captured));
      end if;
      update public.acquisition_offers
      set follow_up_calendar_chain_id = v_chain
      where id = o.id and org_id = p_org_id and outcome = 'pending' and follow_up_calendar_chain_id is null;
      if not found then
        raise exception 'OFFER_CHANGED' using errcode = 'P0001';
      end if;
      update public.my_leads_housekeeping_before_images b
      set before = b.before || jsonb_build_object('applied_calendar_chain_id', v_chain)
      where b.run_id = v_run and b.table_name = 'acquisition_offers' and b.row_id = o.id;
      v_created := v_created + 1;
      if v_due = o.follow_up_at then v_kept := v_kept + 1; else v_moved := v_moved + 1; end if;
    exception when others then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'offer', o.id, 'reason', sqlerrm, 'code', sqlstate));
    end;
  end loop;

  v_result := jsonb_build_object('created', v_created, 'keptExact', v_kept,
    'movedToNextNine', v_moved, 'skipped', v_skipped);
  update public.my_leads_housekeeping_runs set summary = v_result where id = v_run and org_id = p_org_id;
  return v_preview || jsonb_build_object('runId', v_run) || v_result;
end $$;

-- Copy-replaced from 20261005121500 (adds the offer_follow_up_backfill fence).
create or replace function public.my_leads_housekeeping_rollback_fingerprint(p_run uuid, p_org_id uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(
    r.status || '|' || coalesce((
      select string_agg(
        b.table_name || ':' || b.row_id::text || ':' || b.before::text || ':' || coalesce(case b.table_name
          when 'properties' then (select p.assigned_user_id::text || '/' || p.updated_at::text
            from public.properties p where p.id = b.row_id and p.org_id = p_org_id)
          when 'tasks' then (select t.assignee_id::text || '/' || t.status || '/' || t.updated_at::text || '/' || t.calendar_generation::text
              || case when r.kind = 'relabel' then
                   '/' || t.type || '/' || t.mode || '/' || t.due_at::text || '/' || coalesce(t.end_at::text, '')
                   || '/' || coalesce(t.calendar_chain_id::text, '')
                   || '/' || (select count(*) from public.task_calendar_mutations m
                              where m.org_id = p_org_id and m.calendar_chain_id = t.calendar_chain_id)::text
                   || '/' || (select count(*) from public.tasks s
                              where s.org_id = p_org_id and s.calendar_chain_id = t.calendar_chain_id)::text
                 when r.kind = 'offer_follow_up_backfill' then
                   '/' || t.type || '/' || t.due_at::text || '/' || coalesce(t.calendar_chain_id::text, '')
                   || '/' || (select count(*) from public.tasks s
                              where s.org_id = p_org_id and s.calendar_chain_id = t.calendar_chain_id)::text
                   || '/' || (select count(*) from public.task_calendar_mutations m
                              where m.org_id = p_org_id and m.calendar_chain_id = t.calendar_chain_id)::text
                 else '' end
            from public.tasks t where t.id = b.row_id and t.org_id = p_org_id)
          when 'acquisition_appointment_attribution' then (select a.source || '/' || a.accountable_user_id::text || '/' || a.captured_at::text
            from public.acquisition_appointment_attribution a where a.task_id = b.row_id and a.org_id = p_org_id)
          when 'acquisition_offers' then (select coalesce(o.follow_up_calendar_chain_id::text, '') || '/' || o.outcome || '/' || o.follow_up_at::text
            from public.acquisition_offers o where o.id = b.row_id and o.org_id = p_org_id)
          when 'acquisition_attempts' then (select coalesce(a.outcome, '')
            from public.acquisition_attempts a where a.id = b.row_id and a.org_id = p_org_id)
          when 'acquisition_assignment_episodes' then (select e.eligible::text || '/' || coalesce(e.ended_at::text, '')
            from public.acquisition_assignment_episodes e where e.id = b.row_id and e.org_id = p_org_id)
        end, 'missing'),
        ',' order by b.table_name, b.row_id)
      from public.my_leads_housekeeping_before_images b where b.run_id = p_run), ''), 'utf8')), 'hex')
  from public.my_leads_housekeeping_runs r
  where r.id = p_run and r.org_id = p_org_id
$$;

-- Copy-replaced from 20261005121500 (adds the offer_follow_up_backfill branch; other branches unchanged).
create or replace function public.fn_my_leads_housekeeping_rollback(
  p_run uuid, p_org_id uuid, p_fingerprint text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.my_leads_housekeeping_runs%rowtype;
  v_target uuid;
  v_owner uuid;
  r record;
  v_cur record;
  v_old uuid;
  v_created uuid;
  v_orig uuid;
  v_work text;
  v_prior_sub text;
  v_restored int := 0;
  v_already int := 0;
  v_not_restored jsonb := '[]'::jsonb;
  v_images int;
  v_summary jsonb;
  v_flag_move text;
  v_flag_retired text;
  v_rows int;
  v_attr_src text;
  v_attr_user uuid;
  v_attr_at timestamptz;
  v_attr_img jsonb;
  v_task_img jsonb;
  v_task_id uuid;
  v_flag_close text;
begin
  perform public.my_leads_housekeeping_require_service();
  if p_org_id is null then
    raise exception 'INVALID_INPUT: org is required' using errcode = 'P0001';
  end if;
  select * into v_run from public.my_leads_housekeeping_runs
  where id = p_run and org_id = p_org_id for update;
  if not found then
    raise exception 'RUN_NOT_FOUND' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('my-leads-housekeeping:' || p_org_id::text, 0));
  if v_run.status = 'rolled_back' then
    return jsonb_build_object('runId', p_run, 'noop', true, 'status', 'rolled_back');
  end if;
  if p_fingerprint is null then
    raise exception 'FINGERPRINT_REQUIRED: rollback needs the fingerprint from the run info' using errcode = 'P0001';
  end if;
  -- Lock every row the rollback may touch, then recompute the fence under those locks.
  perform 1 from public.properties p
  where p.org_id = p_org_id and p.id in (
    select b.row_id from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'properties') order by p.id for update;
  perform 1 from public.acquisition_offers o
  where o.org_id = p_org_id and o.id in (
    select b.row_id from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'acquisition_offers') order by o.id for update;
  perform 1 from public.tasks t
  where t.org_id = p_org_id and t.id in (
    select b.row_id from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'tasks') order by t.id for update;
  perform 1 from public.acquisition_attempts a
  where a.org_id = p_org_id and a.id in (
    select b.row_id from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'acquisition_attempts') order by a.id for update;
  perform 1 from public.acquisition_appointment_attribution aa
  where aa.org_id = p_org_id and aa.task_id in (
    select b.row_id from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'acquisition_appointment_attribution') order by aa.task_id for update;
  if p_fingerprint is distinct from public.my_leads_housekeeping_rollback_fingerprint(p_run, p_org_id) then
    raise exception 'FINGERPRINT_MISMATCH: the run state changed since the preview; run a new preview' using errcode = 'P0001';
  end if;

  if v_run.kind = 'reassign' then
    v_target := (v_run.params ->> 'target')::uuid;
    v_owner := (v_run.params ->> 'owner')::uuid;

    for r in
      select b.row_id, b.before from public.my_leads_housekeeping_before_images b
      where b.run_id = p_run and b.table_name = 'properties' order by b.row_id
    loop
      begin
        select p.assigned_user_id, p.updated_at into v_cur
        from public.properties p
        where p.id = r.row_id and p.org_id = p_org_id;
        if not found then
          raise exception 'PROPERTY_MISSING' using errcode = 'P0001';
        end if;
        v_old := (r.before ->> 'assigned_user_id')::uuid;
        if v_cur.assigned_user_id is not distinct from v_old then
          v_already := v_already + 1;
          continue;
        end if;
        if v_cur.assigned_user_id is distinct from v_target then
          raise exception 'REASSIGNED_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.updated_at is distinct from (r.before ->> 'applied_updated_at')::timestamptz then
          raise exception 'EDITED_SINCE' using errcode = 'P0001';
        end if;
        select i.row_id into v_created
        from public.my_leads_housekeeping_before_images i
        where i.run_id = p_run and i.table_name = 'acquisition_assignment_episodes'
          and i.before ->> 'op' = 'created' and i.before ->> 'property_id' = r.row_id::text;
        select i.row_id into v_orig
        from public.my_leads_housekeeping_before_images i
        where i.run_id = p_run and i.table_name = 'acquisition_assignment_episodes'
          and i.before ->> 'op' = 'updated' and i.before ->> 'property_id' = r.row_id::text;
        if v_created is null or v_orig is null then
          raise exception 'EPISODE_IMAGE_MISSING' using errcode = 'P0001';
        end if;
        v_work := public.my_leads_housekeeping_work_since(p_org_id, r.row_id, v_created, v_run.created_at);
        if v_work is not null then
          raise exception 'WORK_RECORDED: %', v_work using errcode = 'P0001';
        end if;

        -- Observer ends the created episode and opens a throwaway one for the old owner.
        update public.properties
        set assigned_user_id = v_old, updated_at = (r.before ->> 'updated_at')::timestamptz
        where id = r.row_id and org_id = p_org_id;
        delete from public.acquisition_assignment_episodes e
        where e.org_id = p_org_id and e.property_id = r.row_id and e.ended_at is null;
        delete from public.acquisition_assignment_episodes e
        where e.id = v_created and e.org_id = p_org_id and e.property_id = r.row_id;
        update public.acquisition_assignment_episodes e
        set ended_at = null
        where e.id = v_orig and e.org_id = p_org_id and e.property_id = r.row_id;
        v_restored := v_restored + 1;
      exception when others then
        v_not_restored := v_not_restored || jsonb_build_array(jsonb_build_object(
          'property', r.row_id, 'reason', sqlerrm, 'code', sqlstate));
      end;
    end loop;

    for r in
      select b.row_id, b.before from public.my_leads_housekeeping_before_images b
      where b.run_id = p_run and b.table_name = 'tasks' order by b.row_id
    loop
      v_prior_sub := coalesce(current_setting('request.jwt.claim.sub', true), '');
      begin
        select t.assignee_id, t.status, t.type, t.updated_at, t.calendar_generation into v_cur
        from public.tasks t where t.id = r.row_id and t.org_id = p_org_id;
        if not found then
          raise exception 'TASK_MISSING' using errcode = 'P0001';
        end if;
        v_old := (r.before ->> 'assignee_id')::uuid;
        if v_cur.assignee_id is not distinct from v_old then
          v_already := v_already + 1;
          continue;
        end if;
        if v_cur.assignee_id is distinct from v_target then
          raise exception 'ASSIGNEE_CHANGED_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.updated_at is distinct from (r.before ->> 'applied_updated_at')::timestamptz
           or v_cur.calendar_generation is distinct from (r.before ->> 'applied_generation')::int
           or v_cur.status is distinct from (r.before ->> 'status') then
          raise exception 'EDITED_SINCE' using errcode = 'P0001';
        end if;
        -- A task goes back with its lead: while the lead is kept (work recorded, edited), so is the task.
        perform 1 from public.properties p
        where p.id = (r.before ->> 'property_id')::uuid and p.org_id = p_org_id
          and p.assigned_user_id is not distinct from v_target;
        if found then
          raise exception 'LEAD_NOT_RESTORED' using errcode = 'P0001';
        end if;
        if v_cur.type = 'appointment' then
          perform set_config('request.jwt.claim.sub', v_owner::text, true);
          perform public.fn_reassign_appointment(
            r.row_id, v_old, md5('rollback:' || p_run::text || r.row_id::text)::uuid);
          perform set_config('request.jwt.claim.sub', v_prior_sub, true);
        else
          update public.tasks set assignee_id = v_old, updated_at = (r.before ->> 'updated_at')::timestamptz
          where id = r.row_id and org_id = p_org_id and assignee_id = v_target;
        end if;
        v_restored := v_restored + 1;
      exception when others then
        perform set_config('request.jwt.claim.sub', v_prior_sub, true);
        v_not_restored := v_not_restored || jsonb_build_array(jsonb_build_object(
          'task', r.row_id, 'reason', sqlerrm, 'code', sqlstate));
      end;
    end loop;

  elsif v_run.kind = 'close_attempts' then
    select count(*)::int into v_images
    from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'acquisition_attempts';
    -- Only rows still carrying the housekeeping value are restored; a row changed since
    -- (e.g. a call finalised it) is reported, never overwritten.
    update public.acquisition_attempts a
    set outcome = b.before ->> 'outcome'
    from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'acquisition_attempts'
      and b.row_id = a.id and a.org_id = p_org_id and a.outcome = 'not_logged';
    get diagnostics v_restored = row_count;
    if v_restored < v_images then
      select coalesce(jsonb_agg(jsonb_build_object('attempt', b.row_id, 'reason', 'outcome_changed_since')), '[]'::jsonb)
      into v_not_restored
      from public.my_leads_housekeeping_before_images b
      join public.acquisition_attempts a on a.id = b.row_id and a.org_id = p_org_id
      where b.run_id = p_run and b.table_name = 'acquisition_attempts'
        and a.outcome is distinct from (b.before ->> 'outcome');
    end if;
  elsif v_run.kind = 'relabel' then
    -- A relabeled row goes back only while it still equals what the run left: open, same
    -- type/times/chain, no calendar ledger row or successor on the chain, no work on the lead
    -- since the run, and its attribution row (when the run created one) untouched.
    for r in
      select b.row_id, b.before from public.my_leads_housekeeping_before_images b
      where b.run_id = p_run and b.table_name = 'tasks' order by b.row_id
    loop
      v_flag_move := coalesce(current_setting('sandra.allow_appointment_time_move', true), '');
      v_flag_retired := coalesce(current_setting('sandra.allow_retired_task_type', true), '');
      begin
        select t.type, t.status, t.mode, t.location, t.due_at, t.end_at, t.calendar_chain_id, t.updated_at into v_cur
        from public.tasks t where t.id = r.row_id and t.org_id = p_org_id;
        if not found then
          raise exception 'TASK_MISSING' using errcode = 'P0001';
        end if;
        if v_cur.type is not distinct from (r.before ->> 'type') and v_cur.calendar_chain_id is null then
          v_already := v_already + 1;
          continue;
        end if;
        if v_cur.type <> 'appointment' then
          raise exception 'TYPE_CHANGED_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.status <> 'open' then
          raise exception 'NOT_OPEN_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.due_at is distinct from (r.before ->> 'applied_due_at')::timestamptz
           or v_cur.end_at is distinct from (r.before ->> 'applied_end_at')::timestamptz
           or v_cur.calendar_chain_id is distinct from (r.before ->> 'applied_calendar_chain_id')::uuid then
          raise exception 'RESCHEDULED_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.mode <> 'phone' or v_cur.location is not null then
          raise exception 'MODE_CHANGED_SINCE' using errcode = 'P0001';
        end if;
        if exists (select 1 from public.task_calendar_mutations m
                   where m.org_id = p_org_id and m.calendar_chain_id = v_cur.calendar_chain_id) then
          raise exception 'CALENDAR_ACTIVITY_SINCE' using errcode = 'P0001';
        end if;
        if exists (select 1 from public.tasks s
                   where s.org_id = p_org_id and s.calendar_chain_id = v_cur.calendar_chain_id and s.id <> r.row_id) then
          raise exception 'SUCCESSOR_EXISTS' using errcode = 'P0001';
        end if;
        if v_cur.updated_at is distinct from (r.before ->> 'applied_updated_at')::timestamptz then
          raise exception 'EDITED_SINCE' using errcode = 'P0001';
        end if;
        v_work := public.my_leads_housekeeping_work_since(
          p_org_id, (r.before ->> 'related_property_id')::uuid, null::uuid, v_run.created_at);
        if v_work is not null then
          raise exception 'WORK_RECORDED: %', v_work using errcode = 'P0001';
        end if;
        select i.before into v_attr_img
        from public.my_leads_housekeeping_before_images i
        where i.run_id = p_run and i.table_name = 'acquisition_appointment_attribution'
          and i.row_id = r.row_id and i.before ->> 'op' = 'created';
        if v_attr_img is not null then
          select a.source, a.accountable_user_id, a.captured_at into v_attr_src, v_attr_user, v_attr_at
          from public.acquisition_appointment_attribution a
          where a.task_id = r.row_id and a.org_id = p_org_id;
          if found and (v_attr_src is distinct from 'relabel_2026_10'
                        or v_attr_user::text is distinct from (v_attr_img ->> 'accountable_user_id')
                        or v_attr_at is distinct from (v_attr_img ->> 'applied_captured_at')::timestamptz) then
            raise exception 'ATTRIBUTION_CHANGED_SINCE' using errcode = 'P0001';
          end if;
        end if;

        perform set_config('sandra.allow_appointment_time_move', 'on', true);
        perform set_config('sandra.allow_retired_task_type', 'on', true);
        update public.tasks
        set type = r.before ->> 'type', status = r.before ->> 'status',
            due_at = (r.before ->> 'due_at')::timestamptz,
            snoozed_until = (r.before ->> 'snoozed_until')::timestamptz,
            end_at = (r.before ->> 'end_at')::timestamptz,
            calendar_chain_id = (r.before ->> 'calendar_chain_id')::uuid,
            mode = r.before ->> 'mode',
            updated_at = (r.before ->> 'updated_at')::timestamptz
        where id = r.row_id and org_id = p_org_id and type = 'appointment' and status = 'open';
        get diagnostics v_rows = row_count;
        perform set_config('sandra.allow_appointment_time_move', v_flag_move, true);
        perform set_config('sandra.allow_retired_task_type', v_flag_retired, true);
        if v_rows <> 1 then
          raise exception 'TASK_CHANGED' using errcode = 'P0001';
        end if;
        if v_attr_img is not null then
          delete from public.acquisition_appointment_attribution a
          where a.task_id = r.row_id and a.org_id = p_org_id and a.source = 'relabel_2026_10';
        end if;
        v_restored := v_restored + 1;
      exception when others then
        v_not_restored := v_not_restored || jsonb_build_array(jsonb_build_object(
          'task', r.row_id, 'reason', sqlerrm, 'code', sqlstate));
      end;
    end loop;

  elsif v_run.kind = 'offer_follow_up_backfill' then
    -- Per offer: the follow-up it was given goes away only while the offer is still pending on
    -- the chain the run set and the task is still exactly what the run created (open, same
    -- time, no successor, no calendar ledger row). A rescheduled, completed or offer-resolved
    -- follow-up is reported, never touched. The offer's follow_up_at was never changed.
    for r in
      select b.row_id, b.before from public.my_leads_housekeeping_before_images b
      where b.run_id = p_run and b.table_name = 'acquisition_offers' order by b.row_id
    loop
      v_flag_move := coalesce(current_setting('sandra.allow_appointment_time_move', true), '');
      begin
        select o.follow_up_calendar_chain_id, o.outcome into v_cur
        from public.acquisition_offers o where o.id = r.row_id and o.org_id = p_org_id;
        if not found then
          raise exception 'OFFER_MISSING' using errcode = 'P0001';
        end if;
        if v_cur.follow_up_calendar_chain_id is null then
          v_already := v_already + 1;
          continue;
        end if;
        if v_cur.follow_up_calendar_chain_id is distinct from (r.before ->> 'applied_calendar_chain_id')::uuid then
          raise exception 'CHAIN_CHANGED_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.outcome <> 'pending' then
          raise exception 'OFFER_RESOLVED_SINCE' using errcode = 'P0001';
        end if;
        select i.row_id, i.before into v_task_id, v_task_img
        from public.my_leads_housekeeping_before_images i
        where i.run_id = p_run and i.table_name = 'tasks' and i.before ->> 'offer_id' = r.row_id::text;
        if v_task_id is null then
          raise exception 'TASK_IMAGE_MISSING' using errcode = 'P0001';
        end if;
        select t.status, t.due_at, t.mode, t.calendar_chain_id, t.calendar_generation, t.updated_at into v_cur
        from public.tasks t where t.id = v_task_id and t.org_id = p_org_id;
        if not found then
          raise exception 'TASK_MISSING' using errcode = 'P0001';
        end if;
        if v_cur.status <> 'open' then
          raise exception 'NOT_OPEN_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.due_at is distinct from (v_task_img ->> 'applied_due_at')::timestamptz
           or v_cur.calendar_chain_id is distinct from (v_task_img ->> 'applied_calendar_chain_id')::uuid then
          raise exception 'RESCHEDULED_SINCE' using errcode = 'P0001';
        end if;
        if v_cur.mode <> 'phone' then
          raise exception 'MODE_CHANGED_SINCE' using errcode = 'P0001';
        end if;
        if exists (select 1 from public.task_calendar_mutations m
                   where m.org_id = p_org_id and m.calendar_chain_id = v_cur.calendar_chain_id) then
          raise exception 'CALENDAR_ACTIVITY_SINCE' using errcode = 'P0001';
        end if;
        if exists (select 1 from public.tasks s
                   where s.org_id = p_org_id and s.calendar_chain_id = v_cur.calendar_chain_id and s.id <> v_task_id) then
          raise exception 'SUCCESSOR_EXISTS' using errcode = 'P0001';
        end if;
        if v_cur.calendar_generation is distinct from (v_task_img ->> 'applied_generation')::int
           or v_cur.updated_at is distinct from (v_task_img ->> 'applied_updated_at')::timestamptz then
          raise exception 'EDITED_SINCE' using errcode = 'P0001';
        end if;
        select i.before into v_attr_img
        from public.my_leads_housekeeping_before_images i
        where i.run_id = p_run and i.table_name = 'acquisition_appointment_attribution'
          and i.row_id = v_task_id and i.before ->> 'op' = 'created';
        if v_attr_img is not null then
          select a.source, a.accountable_user_id, a.captured_at into v_attr_src, v_attr_user, v_attr_at
          from public.acquisition_appointment_attribution a
          where a.task_id = v_task_id and a.org_id = p_org_id;
          if found and (v_attr_src is distinct from 'offer_backfill'
                        or v_attr_user::text is distinct from (v_attr_img ->> 'accountable_user_id')
                        or v_attr_at is distinct from (v_attr_img ->> 'applied_captured_at')::timestamptz) then
            raise exception 'ATTRIBUTION_CHANGED_SINCE' using errcode = 'P0001';
          end if;
        end if;

        -- Null the pointer first (the cancel guard only blocks a chain a pending offer points at).
        update public.acquisition_offers
        set follow_up_calendar_chain_id = null
        where id = r.row_id and org_id = p_org_id and outcome = 'pending'
          and follow_up_calendar_chain_id = (r.before ->> 'applied_calendar_chain_id')::uuid;
        get diagnostics v_rows = row_count;
        if v_rows <> 1 then
          raise exception 'OFFER_CHANGED' using errcode = 'P0001';
        end if;
        perform set_config('sandra.allow_appointment_time_move', 'on', true);
        update public.tasks
        set status = 'cancelled', outcome = 'cancelled',
            calendar_generation = calendar_generation + 1, updated_at = now()
        where id = v_task_id and org_id = p_org_id and status = 'open'
          and calendar_generation = (v_task_img ->> 'applied_generation')::int;
        get diagnostics v_rows = row_count;
        perform set_config('sandra.allow_appointment_time_move', v_flag_move, true);
        if v_rows <> 1 then
          raise exception 'TASK_CHANGED' using errcode = 'P0001';
        end if;
        if v_attr_img is not null then
          delete from public.acquisition_appointment_attribution a
          where a.task_id = v_task_id and a.org_id = p_org_id and a.source = 'offer_backfill';
        end if;
        v_restored := v_restored + 1;
      exception when others then
        v_not_restored := v_not_restored || jsonb_build_array(jsonb_build_object(
          'offer', r.row_id, 'reason', sqlerrm, 'code', sqlstate));
      end;
    end loop;

  else
    raise exception 'ROLLBACK_UNSUPPORTED: kind % has no rollback branch in this release', v_run.kind
      using errcode = 'P0001';
  end if;

  v_summary := jsonb_build_object(
    'restored', v_restored, 'alreadyRestored', v_already, 'notRestored', v_not_restored);
  if jsonb_array_length(v_not_restored) = 0 then
    update public.my_leads_housekeeping_runs
    set status = 'rolled_back', rolled_back_at = now(),
        summary = summary || jsonb_build_object('rollback', v_summary)
    where id = p_run and org_id = p_org_id;
  else
    update public.my_leads_housekeeping_runs
    set summary = summary || jsonb_build_object('rollback', v_summary)
    where id = p_run and org_id = p_org_id;
  end if;
  return jsonb_build_object('runId', p_run,
    'status', case when jsonb_array_length(v_not_restored) = 0 then 'rolled_back' else 'applied' end)
    || v_summary;
end $$;

revoke all on function public.fn_create_offer_follow_up_internal(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.trg_tasks_offer_follow_up_sync() from public, anon, authenticated, service_role;
revoke all on function public.trg_tasks_offer_follow_up_cancel_guard() from public, anon, authenticated, service_role;
revoke all on function public.trg_acquisition_offer_close_follow_up() from public, anon, authenticated, service_role;
revoke all on function public.my_leads_offer_backfill_candidate_ids(uuid) from public, anon, authenticated, service_role;
revoke all on function public.my_leads_housekeeping_rollback_fingerprint(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.fn_my_leads_backfill_offer_follow_ups(uuid, uuid, boolean, text)
  from public, anon, authenticated;
revoke all on function public.fn_my_leads_housekeeping_rollback(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fn_my_leads_backfill_offer_follow_ups(uuid, uuid, boolean, text) to service_role;
grant execute on function public.fn_my_leads_housekeeping_rollback(uuid, uuid, text) to service_role;

commit;
