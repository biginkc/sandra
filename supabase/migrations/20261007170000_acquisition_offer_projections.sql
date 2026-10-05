-- My Leads Phase 3c (TECH-PLAN-2026-10 §3.6): offer projection, `superseded` offers, recovery RPCs.
--
-- A contract sent through the send-contract card is projected into an acquisition offer by a
-- durable projection row, never by code in the eSign send path:
--   * the projection row exists BEFORE the eSign request (linked by send_intent_id on insert);
--   * esign_requests.delivery_state = 'sent' flips awaiting_send -> pending by TRIGGER only; the
--     trigger never calls the offer RPC and swallows its own errors, so an offer rejection can never
--     roll back the eSign confirmation;
--   * a service-role runner logs the offer through the existing fn_log_acquisition_offer (13-arg
--     overload) by setting request.jwt.claim.sub to the stored actor for the transaction;
--   * CAS values (episode, queue version, shared status) are read inside the runner after locking
--     property -> queue -> episode, in the same order as fn_log_acquisition_offer.
-- No row is inserted and nothing runs when this migration applies. SQLSTATE note: the business
-- conflicts here use MLS01 like the other My Leads functions (never 40001, which PostgREST retries).
-- Rollback twin: supabase/rollbacks/20261007170000_acquisition_offer_projections.sql
begin;

-- 1. Offers can be superseded (never accepted or declined afterwards: those RPCs need 'pending').
alter table public.acquisition_offers drop constraint acquisition_offers_outcome_check;
alter table public.acquisition_offers add constraint acquisition_offers_outcome_check check (
  (outcome = 'pending' and outcome_at is null and outcome_by is null)
  or (outcome in ('accepted', 'declined', 'superseded') and outcome_at is not null and outcome_by is not null)
) not valid;
alter table public.acquisition_offers validate constraint acquisition_offers_outcome_check;

-- 2. The projection table.
create table public.acquisition_offer_projections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  send_intent_id uuid not null,
  request_hash text not null,
  submission_hash text not null,
  send_payload jsonb not null check (jsonb_typeof(send_payload) = 'object'),
  esign_request_id uuid,
  amount_cents bigint not null check (amount_cents > 0),
  closing_date date not null,
  motivation_kind text check (motivation_kind in ('specified', 'no_motivation')),
  motivation_text text,
  temperature text check (temperature in ('hot', 'warm', 'cold')),
  state text not null default 'awaiting_send'
    check (state in ('awaiting_send', 'pending', 'logged', 'conflict', 'failed', 'cancelled')),
  resolution text check (resolution in
    ('auto', 'superseded_prior_offer', 'reassigned', 'contract_cancelled', 'send_failed', 'never_claimed')),
  conflict_code text,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  last_error_code text,
  sent_at timestamptz,
  follow_up_at timestamptz,
  offer_id uuid references public.acquisition_offers(id) on delete set null,
  logged_at timestamptz,
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  alerted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint acquisition_offer_projections_id_org_key unique (id, org_id),
  foreign key (property_id, org_id) references public.properties(id, org_id) on delete cascade,
  foreign key (esign_request_id, org_id) references public.esign_requests(id, org_id),
  check (state <> 'logged' or offer_id is not null),
  check (state <> 'conflict' or conflict_code is not null),
  check (state <> 'pending' or (esign_request_id is not null and sent_at is not null))
);
create unique index acquisition_offer_projections_intent_idx
  on public.acquisition_offer_projections (org_id, send_intent_id);
create unique index acquisition_offer_projections_request_idx
  on public.acquisition_offer_projections (org_id, esign_request_id) where esign_request_id is not null;
create unique index acquisition_offer_projections_open_property_idx
  on public.acquisition_offer_projections (org_id, property_id)
  where state in ('awaiting_send', 'pending', 'conflict');
create index acquisition_offer_projections_due_idx
  on public.acquisition_offer_projections (next_attempt_at) where state = 'pending';
create index acquisition_offer_projections_property_idx
  on public.acquisition_offer_projections (org_id, property_id, created_at desc);

alter table public.acquisition_offer_projections enable row level security;
create policy acquisition_offer_projections_select on public.acquisition_offer_projections
  for select to authenticated using (public.hugo_has_active_org_access(org_id));
revoke all on public.acquisition_offer_projections from public, anon, authenticated, service_role;
grant select on public.acquisition_offer_projections to authenticated;
grant select, insert, update, delete on public.acquisition_offer_projections to service_role;

-- 3. Pure helper: follow-up moment. (closing - N days) at HH:00 Central; when that is not after the
-- send time, the next calendar morning 09:00 Central after the send time.
create or replace function public.contract_follow_up_at(
  p_closing date, p_sent_at timestamptz, p_days integer, p_hour smallint
) returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select case
    when ((p_closing - p_days)::timestamp + make_interval(hours => p_hour)) at time zone 'America/Chicago' > p_sent_at
      then ((p_closing - p_days)::timestamp + make_interval(hours => p_hour)) at time zone 'America/Chicago'
    else ((date_trunc('day', p_sent_at at time zone 'America/Chicago') + interval '1 day' + interval '9 hours')
      at time zone 'America/Chicago')
  end
$$;

-- 4. Triggers on esign_requests. Both swallow their own errors.
create or replace function public.trg_offer_projection_link() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent public.acquisition_offer_projections%rowtype;
  v_matched integer;
begin
  begin
    update public.acquisition_offer_projections
    set esign_request_id = new.id, updated_at = now()
    where org_id = new.org_id and send_intent_id = new.send_intent_id and esign_request_id is null;
    get diagnostics v_matched = row_count;
    if v_matched = 0 and new.retry_of_request_id is not null then
      select * into v_parent from public.acquisition_offer_projections
      where org_id = new.org_id and esign_request_id = new.retry_of_request_id
        and state = 'failed' and resolution = 'send_failed';
      if found then
        insert into public.acquisition_offer_projections (
          org_id, property_id, actor_user_id, send_intent_id, request_hash, submission_hash, send_payload,
          esign_request_id, amount_cents, closing_date, motivation_kind, motivation_text, temperature, state
        ) values (
          v_parent.org_id, v_parent.property_id, new.created_by, new.send_intent_id, v_parent.request_hash,
          v_parent.submission_hash, v_parent.send_payload, new.id, v_parent.amount_cents, v_parent.closing_date,
          v_parent.motivation_kind, v_parent.motivation_text, v_parent.temperature, 'awaiting_send'
        );
      end if;
    end if;
  exception when others then
    raise warning 'offer projection link skipped: %', sqlerrm;
  end;
  return new;
end $$;

create trigger trg_offer_projection_link
  after insert on public.esign_requests
  for each row execute function public.trg_offer_projection_link();

create or replace function public.trg_offer_projection_state() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    if new.delivery_state = 'sent' and new.sent_at is not null then
      update public.acquisition_offer_projections
      set state = 'pending', sent_at = new.sent_at, next_attempt_at = now(), updated_at = now()
      where org_id = new.org_id and esign_request_id = new.id and state = 'awaiting_send';
    elsif new.delivery_state = 'failed' then
      update public.acquisition_offer_projections
      set state = 'failed', resolution = 'send_failed', updated_at = now()
      where org_id = new.org_id and esign_request_id = new.id and state = 'awaiting_send';
    end if;
    if new.void_requested_at is not null or new.status = 'voided' then
      update public.acquisition_offer_projections
      set state = 'cancelled', resolution = 'contract_cancelled', updated_at = now()
      where org_id = new.org_id and esign_request_id = new.id
        and state in ('awaiting_send', 'pending', 'conflict');
    end if;
  exception when others then
    raise warning 'offer projection state sync skipped: %', sqlerrm;
  end;
  return new;
end $$;

create trigger trg_offer_projection_state
  after update of delivery_state, status, void_requested_at on public.esign_requests
  for each row execute function public.trg_offer_projection_state();

-- 5. Create (service role). Replays of the same intent return the same row only when it matches.
create or replace function public.fn_create_offer_projection(
  p_org_id uuid, p_property_id uuid, p_actor uuid, p_send_intent_id uuid, p_request_hash text,
  p_submission_hash text, p_send_payload jsonb, p_amount_cents bigint, p_closing_date date,
  p_motivation_kind text, p_motivation_text text, p_temperature text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.acquisition_offer_projections%rowtype;
  v_id uuid;
begin
  if p_org_id is null or p_property_id is null or p_actor is null or p_send_intent_id is null
     or p_request_hash is null or p_submission_hash is null or p_send_payload is null
     or p_amount_cents is null or p_amount_cents <= 0 or p_closing_date is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.org_id = p_org_id and m.user_id = p_actor and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.properties p
    where p.id = p_property_id and p.org_id = p_org_id and coalesce(p.is_training, false) = false
  ) then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  select * into v_existing from public.acquisition_offer_projections
  where org_id = p_org_id and send_intent_id = p_send_intent_id;
  if found then
    if v_existing.actor_user_id = p_actor and v_existing.request_hash = p_request_hash
       and v_existing.amount_cents = p_amount_cents and v_existing.closing_date = p_closing_date then
      return v_existing.id;
    end if;
    raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'MLS01';
  end if;
  -- Database-enforced guard, whatever the intent id: serialize on the property row, then refuse when a
  -- contract is already open (awaiting send, being logged, or needing reconciliation), when an earlier
  -- logged contract is still out for signature, or when an offer is already pending. A page reload that
  -- mints a fresh intent id therefore cannot send a second contract. The open-property unique index
  -- below remains the last line of defence.
  perform 1 from public.properties where id = p_property_id and org_id = p_org_id for update;
  if exists (
    select 1 from public.acquisition_offer_projections x
    where x.org_id = p_org_id and x.property_id = p_property_id and x.state in ('awaiting_send', 'pending', 'conflict')
  ) or exists (
    select 1 from public.acquisition_offer_projections x
    join public.esign_requests r on r.id = x.esign_request_id and r.org_id = x.org_id
    where x.org_id = p_org_id and x.property_id = p_property_id and x.state = 'logged'
      and r.status in ('awaiting', 'viewed') and r.void_requested_at is null
  ) then
    raise exception 'OPEN_CONTRACT_EXISTS' using errcode = 'MLS01';
  end if;
  if exists (
    select 1 from public.acquisition_offers o
    where o.org_id = p_org_id and o.property_id = p_property_id and o.outcome = 'pending'
  ) then
    raise exception 'PENDING_OFFER_EXISTS' using errcode = 'MLS01';
  end if;
  insert into public.acquisition_offer_projections (
    org_id, property_id, actor_user_id, send_intent_id, request_hash, submission_hash, send_payload,
    amount_cents, closing_date, motivation_kind, motivation_text, temperature
  ) values (
    p_org_id, p_property_id, p_actor, p_send_intent_id, p_request_hash, p_submission_hash, p_send_payload,
    p_amount_cents, p_closing_date, p_motivation_kind, nullif(btrim(p_motivation_text), ''), p_temperature
  ) returning id into v_id;
  return v_id;
end $$;

-- 6. The runner. No grants: only the wrappers below call it.
create or replace function public.fn_offer_projection_run(
  p_projection_id uuid, p_actor uuid, p_persist_conflict boolean, p_resolution text default 'auto'
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p public.acquisition_offer_projections%rowtype;
  v_req public.esign_requests%rowtype;
  v_prop public.properties%rowtype;
  v_queue public.acquisition_queue_states%rowtype;
  v_episode public.acquisition_assignment_episodes%rowtype;
  v_settings public.acquisition_contract_settings%rowtype;
  v_follow timestamptz;
  v_doc_cents bigint;
  v_doc_text text;
  v_prev text;
  v_result jsonb;
  v_code text;
begin
  perform set_config('lock_timeout', '3s', true);
  select * into v_p from public.acquisition_offer_projections where id = p_projection_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_p.state = 'logged' then return jsonb_build_object('state', 'logged', 'offerId', v_p.offer_id); end if;
  if v_p.state in ('cancelled', 'failed') or v_p.state = 'awaiting_send'
     or (v_p.state = 'conflict' and p_persist_conflict) then
    if not p_persist_conflict then raise exception 'PROJECTION_NOT_LOGGED' using errcode = 'MLS01'; end if;
    return jsonb_build_object('state', v_p.state, 'code', v_p.conflict_code);
  end if;

  select * into v_req from public.esign_requests where id = v_p.esign_request_id and org_id = v_p.org_id;
  if not found or v_req.delivery_state <> 'sent' or v_req.sent_at is null or v_req.sign_request_id is null then
    if not p_persist_conflict then raise exception 'PROJECTION_NOT_LOGGED' using errcode = 'MLS01'; end if;
    update public.acquisition_offer_projections set state = 'awaiting_send', updated_at = now()
    where id = v_p.id and state = 'pending';
    return jsonb_build_object('state', 'awaiting_send');
  end if;
  if v_req.void_requested_at is not null or v_req.status = 'voided' then
    if not p_persist_conflict then raise exception 'PROJECTION_NOT_LOGGED' using errcode = 'MLS01'; end if;
    update public.acquisition_offer_projections
    set state = 'cancelled', resolution = 'contract_cancelled', updated_at = now() where id = v_p.id;
    return jsonb_build_object('state', 'cancelled');
  end if;

  -- Amount guard: never log an amount that differs from the document that was sent.
  v_doc_text := nullif(regexp_replace(coalesce(v_req.merge_value_snapshot ->> 'offer_price', ''), '[^0-9.]', '', 'g'), '');
  begin
    v_doc_cents := case when v_doc_text is null then null else round(v_doc_text::numeric * 100)::bigint end;
  exception when others then
    v_doc_cents := null;
  end;
  if v_doc_cents is distinct from v_p.amount_cents then
    if not p_persist_conflict then raise exception 'AMOUNT_MISMATCH' using errcode = 'MLS01'; end if;
    update public.acquisition_offer_projections
    set state = 'conflict', conflict_code = 'AMOUNT_MISMATCH', last_error_code = 'AMOUNT_MISMATCH', updated_at = now()
    where id = v_p.id;
    return jsonb_build_object('state', 'conflict', 'code', 'AMOUNT_MISMATCH');
  end if;

  -- Same lock order as fn_log_acquisition_offer: property -> queue -> episode.
  select * into v_prop from public.properties where id = v_p.property_id and org_id = v_p.org_id for update;
  if not found then
    if not p_persist_conflict then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    update public.acquisition_offer_projections
    set state = 'conflict', conflict_code = 'NOT_FOUND', last_error_code = 'NOT_FOUND', updated_at = now() where id = v_p.id;
    return jsonb_build_object('state', 'conflict', 'code', 'NOT_FOUND');
  end if;
  select * into v_queue from public.acquisition_queue_states
  where org_id = v_p.org_id and property_id = v_p.property_id for update;
  select * into v_episode from public.acquisition_assignment_episodes
  where org_id = v_p.org_id and property_id = v_p.property_id and ended_at is null for update;
  if not found then
    if not p_persist_conflict then raise exception 'STALE_ASSIGNMENT' using errcode = 'MLS01'; end if;
    update public.acquisition_offer_projections
    set state = 'conflict', conflict_code = 'STALE_ASSIGNMENT', last_error_code = 'STALE_ASSIGNMENT', updated_at = now()
    where id = v_p.id;
    return jsonb_build_object('state', 'conflict', 'code', 'STALE_ASSIGNMENT');
  end if;

  -- Follow-up moment is computed once and stored so retries replay identical arguments.
  v_follow := v_p.follow_up_at;
  if v_follow is null then
    select * into v_settings from public.acquisition_contract_settings where org_id = v_p.org_id;
    v_follow := public.contract_follow_up_at(
      v_p.closing_date, v_req.sent_at,
      coalesce(v_settings.follow_up_days_before_closing, 3), coalesce(v_settings.follow_up_hour_central, 9)::smallint
    );
    update public.acquisition_offer_projections set follow_up_at = v_follow, updated_at = now() where id = v_p.id;
  end if;

  v_prev := current_setting('request.jwt.claim.sub', true);
  perform set_config('request.jwt.claim.sub', p_actor::text, true);
  begin
    v_result := public.fn_log_acquisition_offer(
      v_p.org_id, v_p.property_id, v_episode.id, coalesce(v_queue.version, 0), v_prop.status, v_p.id,
      v_p.amount_cents, 'dropbox_sign', v_req.sent_at, v_follow, v_p.motivation_kind, v_p.motivation_text,
      v_p.temperature
    );
  exception when others then
    perform set_config('request.jwt.claim.sub', coalesce(v_prev, ''), true);
    v_code := sqlerrm;
    if v_code in ('STALE_STATE', 'STALE_ASSIGNMENT', 'PENDING_OFFER_EXISTS', 'DNC_LOCKED', 'FORBIDDEN',
                  'FEATURE_DISABLED', 'NOT_FOUND', 'INVALID_INPUT', 'UNAUTHENTICATED', 'IDEMPOTENCY_CONFLICT') then
      if not p_persist_conflict then raise; end if;
      update public.acquisition_offer_projections
      set state = 'conflict', conflict_code = v_code, last_error_code = v_code, updated_at = now() where id = v_p.id;
      return jsonb_build_object('state', 'conflict', 'code', v_code);
    end if;
    if not p_persist_conflict then raise; end if;
    update public.acquisition_offer_projections
    set attempts = attempts + 1, last_error_code = left(v_code, 64),
        next_attempt_at = now() + (least(attempts + 1, 10) * interval '1 minute'),
        state = case when attempts + 1 >= 12 then 'conflict' else state end,
        conflict_code = case when attempts + 1 >= 12 then 'PROJECTION_RETRY_EXHAUSTED' else conflict_code end,
        updated_at = now()
    where id = v_p.id;
    return jsonb_build_object('state', (select state from public.acquisition_offer_projections where id = v_p.id),
      'code', left(v_code, 64));
  end;
  perform set_config('request.jwt.claim.sub', coalesce(v_prev, ''), true);
  update public.acquisition_offer_projections
  set state = 'logged', offer_id = (v_result ->> 'offerId')::uuid, logged_at = now(), follow_up_at = v_follow,
      resolution = coalesce(p_resolution, 'auto'), conflict_code = null, last_error_code = null, updated_at = now()
  where id = v_p.id;
  return jsonb_build_object('state', 'logged', 'offerId', v_result ->> 'offerId');
end $$;

-- 7. Wrappers.
create or replace function public.fn_project_acquisition_offer(p_projection_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_actor uuid;
begin
  select actor_user_id into v_actor from public.acquisition_offer_projections where id = p_projection_id;
  if v_actor is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return public.fn_offer_projection_run(p_projection_id, v_actor, true);
end $$;

create or replace function public.fn_retry_offer_projection(
  p_org_id uuid, p_projection_id uuid, p_resolution text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.my_leads_workflow_require_actor(p_org_id);
  v_p public.acquisition_offer_projections%rowtype;
  v_role text;
  v_assignee uuid;
begin
  if p_resolution is not null and p_resolution <> 'reassigned' then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_p from public.acquisition_offer_projections
  where id = p_projection_id and org_id = p_org_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select m.role into v_role from public.memberships m
  where m.org_id = p_org_id and m.user_id = v_actor and m.access_status = 'active';
  select assigned_user_id into v_assignee from public.properties where id = v_p.property_id and org_id = p_org_id;
  if v_role is distinct from 'owner' and v_assignee is distinct from v_actor then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_p.state = 'conflict' then
    update public.acquisition_offer_projections
    set state = 'pending', attempts = 0, conflict_code = null, last_error_code = null,
        next_attempt_at = now(), updated_at = now()
    where id = v_p.id;
  elsif v_p.state <> 'pending' then
    return jsonb_build_object('state', v_p.state, 'offerId', v_p.offer_id);
  end if;
  return public.fn_offer_projection_run(
    p_projection_id, v_actor, true, case when p_resolution = 'reassigned' then 'reassigned' else 'auto' end);
end $$;

create or replace function public.fn_offer_projection_repair() returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_n integer := 0; v_c integer;
begin
  update public.acquisition_offer_projections p
  set state = 'pending', sent_at = r.sent_at, next_attempt_at = now(), updated_at = now()
  from public.esign_requests r
  where p.state = 'awaiting_send' and r.id = p.esign_request_id and r.org_id = p.org_id
    and r.delivery_state = 'sent' and r.sent_at is not null
    and r.void_requested_at is null and r.status <> 'voided';
  get diagnostics v_c = row_count; v_n := v_n + v_c;
  update public.acquisition_offer_projections p
  set state = 'failed', resolution = 'send_failed', updated_at = now()
  from public.esign_requests r
  where p.state = 'awaiting_send' and r.id = p.esign_request_id and r.org_id = p.org_id
    and r.delivery_state = 'failed';
  get diagnostics v_c = row_count; v_n := v_n + v_c;
  update public.acquisition_offer_projections p
  set state = 'cancelled', resolution = 'contract_cancelled', updated_at = now()
  from public.esign_requests r
  where p.state in ('awaiting_send', 'pending', 'conflict') and r.id = p.esign_request_id and r.org_id = p.org_id
    and (r.void_requested_at is not null or r.status = 'voided');
  get diagnostics v_c = row_count; v_n := v_n + v_c;
  update public.acquisition_offer_projections
  set state = 'failed', resolution = 'never_claimed', updated_at = now()
  where state = 'awaiting_send' and esign_request_id is null and created_at < now() - interval '15 minutes';
  get diagnostics v_c = row_count; v_n := v_n + v_c;
  return v_n;
end $$;

-- Release an intent whose send failed before any eSign request was claimed.
create or replace function public.fn_abandon_offer_projection(p_projection_id uuid) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare v_c integer;
begin
  update public.acquisition_offer_projections
  set state = 'failed', resolution = 'never_claimed', updated_at = now()
  where id = p_projection_id and state = 'awaiting_send' and esign_request_id is null;
  get diagnostics v_c = row_count;
  return v_c > 0;
end $$;

create or replace function public.fn_offer_projection_due(p_limit integer) returns setof uuid
language sql
security definer
set search_path = ''
as $$
  select id from public.acquisition_offer_projections
  where state = 'pending' and next_attempt_at <= now()
  order by next_attempt_at
  limit greatest(coalesce(p_limit, 10), 1)
  for update skip locked
$$;

-- 8. Recovery 1: supersede the stale pending offer and log this one, atomically.
create or replace function public.fn_supersede_offer_and_log(
  p_org_id uuid, p_projection_id uuid, p_idempotency_key uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.my_leads_workflow_require_actor(p_org_id);
  v_hash text;
  v_replay jsonb;
  v_p public.acquisition_offer_projections%rowtype;
  v_prop public.properties%rowtype;
  v_role text;
  v_stale public.acquisition_offers%rowtype;
  v_run jsonb;
  v_command_id uuid := extensions.gen_random_uuid();
  v_result jsonb;
begin
  if p_projection_id is null or p_idempotency_key is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  v_hash := public.my_leads_command_hash('supersede_acquisition_offer', p_org_id, v_actor,
    jsonb_build_object('projectionId', p_projection_id));
  perform pg_advisory_xact_lock(hashtextextended(
    format('my-leads:%s:%s:%s', p_org_id, 'supersede_acquisition_offer', p_idempotency_key), 0));
  v_replay := public.my_leads_workflow_replay(p_org_id, 'supersede_acquisition_offer', p_idempotency_key, v_actor, v_hash);
  if v_replay is not null then return v_replay; end if;

  select * into v_p from public.acquisition_offer_projections
  where id = p_projection_id and org_id = p_org_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select m.role into v_role from public.memberships m
  where m.org_id = p_org_id and m.user_id = v_actor and m.access_status = 'active';
  select * into v_prop from public.properties where id = v_p.property_id and org_id = p_org_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v_role is distinct from 'owner' and v_prop.assigned_user_id is distinct from v_actor then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_p.state <> 'conflict' or v_p.conflict_code is distinct from 'PENDING_OFFER_EXISTS' then
    raise exception 'STALE_STATE' using errcode = 'MLS01';
  end if;
  select * into v_stale from public.acquisition_offers
  where org_id = p_org_id and property_id = v_p.property_id and outcome = 'pending' for update;
  if not found or v_p.sent_at is null or not (v_stale.sent_at < v_p.sent_at) then
    raise exception 'STALE_STATE' using errcode = 'MLS01';
  end if;

  update public.acquisition_offers
  set outcome = 'superseded', outcome_at = statement_timestamp(), outcome_by = v_actor,
      updated_at = statement_timestamp()
  where id = v_stale.id and org_id = p_org_id;
  -- Setting outcome='superseded' fires the chain trigger that cancels the stale offer's open follow-up.

  v_run := public.fn_offer_projection_run(p_projection_id, v_actor, false, 'superseded_prior_offer');
  if v_run ->> 'state' is distinct from 'logged' then
    raise exception 'PROJECTION_NOT_LOGGED' using errcode = 'MLS01';
  end if;

  v_result := jsonb_build_object('ok', true, 'duplicate', false, 'offerId', v_run ->> 'offerId',
    'supersededOfferId', v_stale.id);
  insert into public.acquisition_commands (
    id, org_id, actor_user_id, actor_kind, operation, idempotency_key, request_hash, result
  ) values (v_command_id, p_org_id, v_actor, 'user', 'supersede_acquisition_offer', p_idempotency_key, v_hash, v_result);
  perform public.my_leads_workflow_append_event(p_org_id, v_p.property_id, v_actor, v_command_id,
    'supersede_acquisition_offer',
    jsonb_build_object('offerId', v_run ->> 'offerId', 'supersededOfferId', v_stale.id));
  update public.acquisition_offer_projections
  set resolution = 'superseded_prior_offer', resolved_by = v_actor, resolved_at = now(), updated_at = now()
  where id = p_projection_id;
  return v_result;
end $$;

-- 9. Read helper for the strip, lead page and card: unresolved projections the caller may act on.
create or replace function public.fn_list_offer_conflicts(
  p_org_id uuid, p_member_id uuid, p_property_id uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.my_leads_workflow_require_actor(p_org_id);
  v_role text;
begin
  if p_member_id is distinct from v_actor then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select m.role into v_role from public.memberships m
  where m.org_id = p_org_id and m.user_id = v_actor and m.access_status = 'active';
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'projectionId', p.id, 'propertyId', p.property_id, 'address', pr.address,
      'conflictCode', p.conflict_code, 'requestId', p.esign_request_id, 'sentAt', p.sent_at,
      'amountCents', p.amount_cents, 'actorUserId', p.actor_user_id,
      'pendingOfferAmountCents', (
        select o.amount_cents from public.acquisition_offers o
        where o.org_id = p.org_id and o.property_id = p.property_id and o.outcome = 'pending' limit 1)
    ) order by p.sent_at)
    from public.acquisition_offer_projections p
    join public.properties pr on pr.id = p.property_id and pr.org_id = p.org_id
    where p.org_id = p_org_id and p.state = 'conflict'
      and (p_property_id is null or p.property_id = p_property_id)
      and (v_role = 'owner' or pr.assigned_user_id = v_actor)
  ), '[]'::jsonb);
end $$;

-- 10. KPI: a superseded offer and its replacement are ONE offer sent; only the latest counts
-- (Jarrad's decision, "Count only the latest."). Anchored patch of the live fn_get_acquisition_kpis
-- body (the offers count is the only change); it fails loudly if the anchor ever stops matching.
do $patch$
declare
  v_def text := pg_get_functiondef('public.fn_get_acquisition_kpis(uuid,uuid,timestamptz,timestamptz)'::regprocedure);
  v_old constant text := 'select count(*) into v_offers from public.acquisition_offers where org_id=p_org_id and actor_user_id=p_member_id and sent_at>=p_start and sent_at<p_end;';
  v_new constant text := 'select count(*) into v_offers from public.acquisition_offers where org_id=p_org_id and actor_user_id=p_member_id and sent_at>=p_start and sent_at<p_end and outcome<>''superseded'';';
begin
  if position(v_old in v_def) = 0 then
    raise exception 'fn_get_acquisition_kpis offers-count anchor not found';
  end if;
  execute replace(v_def, v_old, v_new);
end
$patch$;

revoke all on function public.contract_follow_up_at(date, timestamptz, integer, smallint)
  from public, anon, authenticated, service_role;
grant execute on function public.contract_follow_up_at(date, timestamptz, integer, smallint) to service_role;
revoke all on function public.trg_offer_projection_link() from public, anon, authenticated, service_role;
revoke all on function public.trg_offer_projection_state() from public, anon, authenticated, service_role;
revoke all on function public.fn_create_offer_projection(uuid, uuid, uuid, uuid, text, text, jsonb, bigint, date, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.fn_offer_projection_run(uuid, uuid, boolean, text)
  from public, anon, authenticated, service_role;
revoke all on function public.fn_project_acquisition_offer(uuid) from public, anon, authenticated, service_role;
revoke all on function public.fn_retry_offer_projection(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.fn_offer_projection_repair() from public, anon, authenticated, service_role;
revoke all on function public.fn_abandon_offer_projection(uuid) from public, anon, authenticated, service_role;
revoke all on function public.fn_offer_projection_due(integer) from public, anon, authenticated, service_role;
revoke all on function public.fn_supersede_offer_and_log(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.fn_list_offer_conflicts(uuid, uuid, uuid) from public, anon, authenticated, service_role;

grant execute on function public.fn_create_offer_projection(uuid, uuid, uuid, uuid, text, text, jsonb, bigint, date, text, text, text) to service_role;
grant execute on function public.fn_project_acquisition_offer(uuid) to service_role;
grant execute on function public.fn_offer_projection_repair() to service_role;
grant execute on function public.fn_abandon_offer_projection(uuid) to service_role;
grant execute on function public.fn_offer_projection_due(integer) to service_role;
grant execute on function public.fn_retry_offer_projection(uuid, uuid, text) to authenticated;
grant execute on function public.fn_supersede_offer_and_log(uuid, uuid, uuid) to authenticated;
grant execute on function public.fn_list_offer_conflicts(uuid, uuid, uuid) to authenticated;

commit;
