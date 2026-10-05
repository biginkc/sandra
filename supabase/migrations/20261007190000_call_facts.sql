-- My Leads Phase 3c (TECH-PLAN-2026-10 section 3.12): call facts (AI proposals) and the claim/complete job.
-- Additive only. Inert until the `facts_job` flag is on for an org (the flag defaults OFF and the claim
-- function itself refuses orgs with the flag off). Nothing here writes to a lead: a fact is a proposal that
-- a human accepts through fn_accept_call_fact, which only appends a lead note.
--
-- Creates:
--   public.lead_call_facts          one row per call activity; `status` is the human-facing state,
--                                   `processing_state` the durable job state (claimed|done|failed)
--   public.fn_claim_call_facts      service_role; claim/lease/reclaim, input from call_transcripts
--   public.fn_complete_call_facts   service_role; ONE transaction: deterministic summary note + facts + done
--   public.fn_accept_call_fact      authenticated; records accepted[field] and appends a lead note
--   public.fn_unaccept_call_fact    authenticated; compensation when the next-step appointment fails
--   public.fn_dismiss_call_facts    authenticated
-- Rollback twin: supabase/rollbacks/20261007190000_call_facts.sql
begin;

create table public.lead_call_facts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  call_activity_id uuid not null,
  source text not null default 'dialpad_ai_recap' check (source in ('dialpad_ai_recap')),
  status text not null default 'proposed'
    check (status in ('proposed', 'partially_accepted', 'dismissed', 'no_facts')),
  summary_note_id uuid references public.lead_notes(id) on delete set null,
  -- { field: { value, evidence } } keyed by the field allow-list in fn_complete_call_facts (the approved Jev questions)
  facts jsonb not null default '{}'::jsonb check (jsonb_typeof(facts) = 'object'),
  accepted jsonb not null default '{}'::jsonb check (jsonb_typeof(accepted) = 'object'),
  model text,
  extracted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Durable job state, separate from the human-facing `status`.
  processing_state text not null default 'claimed' check (processing_state in ('claimed', 'done', 'failed')),
  claim_token uuid,
  lease_until timestamptz,
  attempts smallint not null default 0 check (attempts between 0 and 5),
  unique (org_id, call_activity_id),
  foreign key (call_activity_id, property_id, org_id)
    references public.call_activities(id, property_id, org_id) on delete cascade
);
create index lead_call_facts_property_idx on public.lead_call_facts (org_id, property_id, extracted_at desc);
create index lead_call_facts_reclaim_idx on public.lead_call_facts (lease_until) where processing_state = 'claimed';

alter table public.lead_call_facts enable row level security;
create policy lead_call_facts_org_select on public.lead_call_facts
  for select to authenticated using (public.hugo_has_active_org_access(org_id));

revoke all on public.lead_call_facts from public, anon, authenticated, service_role;
-- Members read the proposal columns; the job state (token, lease) is service-only.
grant select (
  id, org_id, property_id, call_activity_id, source, status, summary_note_id,
  facts, accepted, model, extracted_at, updated_at, processing_state
) on public.lead_call_facts to authenticated;
grant select, insert, update on public.lead_call_facts to service_role;

-- ----------------------------------------------------------------------------
-- fn_claim_call_facts (service_role)
-- ----------------------------------------------------------------------------
create or replace function public.fn_claim_call_facts(p_limit integer, p_lease_seconds integer, p_window_hours integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims jsonb;
  v_exhausted jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  -- No backlog sweep: only calls that ended within this window are ever claimed.
  if p_window_hours is null or p_window_hours < 1 or p_window_hours > 720 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  -- A reservation whose worker crashed at the last allowed attempt is failed once and never selected again.
  with dead as (
    update public.lead_call_facts f
       set processing_state = 'failed', claim_token = null, lease_until = null, updated_at = now()
     where f.processing_state = 'claimed' and f.lease_until < now() and f.attempts >= 5
    returning f.id, f.call_activity_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('fact_id', d.id, 'call_activity_id', d.call_activity_id)), '[]'::jsonb)
    into v_exhausted from dead d;

  with eligible as (
    select ca.id as call_activity_id, ca.org_id, ca.property_id
      from public.call_activities ca
      join public.properties p on p.id = ca.property_id and p.org_id = ca.org_id
     where ca.property_id is not null
       and coalesce(ca.ended_at, ca.started_at) >= now() - make_interval(hours => p_window_hours)
       and p.is_training is not true
       and p.deleted_at is null
       and exists (select 1 from public.my_leads_feature_flags g where g.org_id = ca.org_id and g.facts_job)
       -- Phase 2.9: both artifact rows exist, every one is terminal, and at least one has content.
       and (select count(*) from public.dialpad_call_artifact_fetches f
             where f.org_id = ca.org_id and f.call_activity_id = ca.id and f.artifact in ('transcript', 'recap')) = 2
       and not exists (select 1 from public.dialpad_call_artifact_fetches f
             where f.org_id = ca.org_id and f.call_activity_id = ca.id and f.artifact in ('transcript', 'recap')
               and f.state not in ('available', 'unavailable', 'denied'))
       and exists (select 1 from public.dialpad_call_artifact_fetches f
             where f.org_id = ca.org_id and f.call_activity_id = ca.id and f.artifact in ('transcript', 'recap')
               and f.state = 'available')
       and (
         not exists (select 1 from public.lead_call_facts lf where lf.org_id = ca.org_id and lf.call_activity_id = ca.id)
         or exists (select 1 from public.lead_call_facts lf
                     where lf.org_id = ca.org_id and lf.call_activity_id = ca.id
                       and lf.processing_state = 'claimed' and lf.lease_until < now() and lf.attempts < 5)
       )
     order by coalesce(ca.ended_at, ca.started_at) desc, ca.id
     limit p_limit
  ),
  claimed as (
    insert into public.lead_call_facts as lcf (org_id, property_id, call_activity_id, processing_state, claim_token, lease_until, attempts)
    select e.org_id, e.property_id, e.call_activity_id, 'claimed', gen_random_uuid(),
           now() + make_interval(secs => p_lease_seconds), 1
      from eligible e
    on conflict (org_id, call_activity_id) do update
       set claim_token = gen_random_uuid(),
           lease_until = now() + make_interval(secs => p_lease_seconds),
           attempts = lcf.attempts + 1,
           updated_at = now()
     where lcf.processing_state = 'claimed' and lcf.lease_until < now() and lcf.attempts < 5
    returning lcf.id, lcf.claim_token, lcf.call_activity_id, lcf.org_id, lcf.property_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'fact_id', c.id,
           'claim_token', c.claim_token,
           'call_activity_id', c.call_activity_id,
           'org_id', c.org_id,
           'property_id', c.property_id,
           'summary', t.summary,
           'transcript', t.text,
           -- Known identifiers of the lead, so the caller can mask them before any text leaves Sandra.
           'contact_names', to_jsonb(array_remove(array[ct.first_name, ct.last_name, ct.entity_name], null)),
           'property_address', pr.address,
           'property_city', pr.city,
           'property_zip', pr.zip,
           -- Display names of the org's members (reps), so spoken names are masked before any text leaves Sandra.
           'rep_names', (
             select coalesce(jsonb_agg(distinct x.n), '[]'::jsonb) from (
               select nullif(btrim(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', '')), '') as n
                 from public.memberships m join auth.users u on u.id = m.user_id
                where m.org_id = c.org_id and m.access_status = 'active' and m.deletion_prepared_at is null
               union
               select nullif(btrim(split_part(u.email, '@', 1)), '')
                 from public.memberships m join auth.users u on u.id = m.user_id
                where m.org_id = c.org_id and m.access_status = 'active' and m.deletion_prepared_at is null
             ) x where x.n is not null),
           -- Relative dates ("tomorrow") are resolved against the CALL, not against when the sweep runs.
           'ended_at', (select coalesce(ca.ended_at, ca.started_at) from public.call_activities ca where ca.id = c.call_activity_id))), '[]'::jsonb)
    into v_claims
    from claimed c
    join public.properties pr on pr.id = c.property_id and pr.org_id = c.org_id
    left join public.contacts ct on ct.id = pr.homeowner_contact_id and ct.org_id = pr.org_id
    left join lateral (
      select ct.summary, ct.text from public.call_transcripts ct
       where ct.call_activity_id = c.call_activity_id
       order by (ct.status = 'available') desc, ct.updated_at desc, ct.id
       limit 1
    ) t on true;

  return jsonb_build_object('claims', v_claims, 'exhausted', v_exhausted);
end;
$$;
revoke all on function public.fn_claim_call_facts(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.fn_claim_call_facts(integer, integer, integer) to service_role;

-- ----------------------------------------------------------------------------
-- fn_complete_call_facts (service_role): the single completion transaction
-- ----------------------------------------------------------------------------
create or replace function public.fn_complete_call_facts(
  p_fact_id uuid,
  p_claim_token uuid,
  p_facts jsonb,
  p_status text,
  p_model text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.lead_call_facts%rowtype;
  v_summary text;
  v_ended timestamptz;
  v_note_id uuid;
  v_key text;
  v_item jsonb;
  v_allowed constant text[] := array['asking_price', 'mortgage', 'motivation', 'timeline', 'next_step', 'behind_on_payments', 'pain_behind_on_payments', 'pain_facing_auction', 'pain_back_taxes', 'pain_bankruptcy', 'pain_liens', 'pain_underwater', 'pain_downsizing_health', 'pain_moving_away', 'pain_tired_landlord', 'pain_inherited', 'pain_divorce', 'pain_vacant', 'pain_failed_listing', 'pain_major_repairs', 'not_rushed', 'objection_think', 'objection_relocation', 'objection_consult', 'objection_review_agreement', 'objection_unknown', 'objection_trust_signing', 'objection_earnest_proof', 'objection_price_pushback', 'objection_listing_realtor', 'objection_external_valuation', 'objection_buyer_identity', 'objection_property_access', 'objection_right_price_preoffer', 'objection_offer_now', 'objection_attorney_review', 'objection_closing_certainty', 'objection_text_only', 'objection_busy_callback', 'objection_buy_without_visit', 'objection_timing_feasibility', 'objection_competing_offer', 'objection_transaction_process', 'objection_email_refusal', 'objection_assignment_fee', 'objection_legal_question', 'objection_seller_costs', 'objection_offer_calculation', 'objection_offer_changes', 'objection_property_preparation', 'bad_experience', 'condition'];
begin
  if p_fact_id is null or p_claim_token is null or p_facts is null or jsonb_typeof(p_facts) <> 'object'
     or p_status not in ('proposed', 'no_facts') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  -- Shape guard (the real validation, verbatim evidence included, runs in code before this call).
  for v_key, v_item in select * from jsonb_each(p_facts) loop
    if not (v_key = any(v_allowed)) or jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item -> 'value') <> 'string' or jsonb_typeof(v_item -> 'evidence') <> 'string'
       -- `value` is verbatim call text; derived data is only ever in these two structured fields.
       or exists (select 1 from jsonb_object_keys(v_item) k where k not in ('value', 'evidence', 'amount_cents', 'due_at'))
       or (v_item ? 'amount_cents' and (jsonb_typeof(v_item -> 'amount_cents') <> 'number' or (v_item ->> 'amount_cents')::numeric <= 0))
       or (v_item ? 'due_at' and jsonb_typeof(v_item -> 'due_at') <> 'string') then
      raise exception 'INVALID_INPUT' using errcode = '22023';
    end if;
  end loop;
  if (p_facts = '{}'::jsonb) <> (p_status = 'no_facts') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  select * into v_row from public.lead_call_facts where id = p_fact_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.claim_token is distinct from p_claim_token then
    raise exception 'CLAIM_TOKEN_MISMATCH' using errcode = '40001';
  end if;
  -- A replay of the same completed claim is a no-op.
  if v_row.processing_state = 'done' then
    return jsonb_build_object('replayed', true, 'summaryNoteId', v_row.summary_note_id, 'status', v_row.status);
  end if;
  if v_row.processing_state <> 'claimed' or v_row.lease_until is null or v_row.lease_until < now() then
    raise exception 'LEASE_EXPIRED' using errcode = '40001';
  end if;

  select ct.summary into v_summary
    from public.call_transcripts ct
   where ct.call_activity_id = v_row.call_activity_id
   order by (ct.status = 'available') desc, ct.updated_at desc, ct.id
   limit 1;
  select ca.ended_at into v_ended from public.call_activities ca where ca.id = v_row.call_activity_id;

  if v_summary is not null and btrim(v_summary) <> '' then
    -- Deterministic identity: a replay (or a second worker) cannot create a second note.
    insert into public.lead_notes (org_id, property_id, author_user_id, body, idempotency_key)
    values (
      v_row.org_id, v_row.property_id, null,
      'Dialpad call summary' || coalesce(' ' || to_char(v_ended at time zone 'America/Chicago', 'YYYY-MM-DD'), '') || E'\n' || v_summary,
      md5('call_facts_summary:' || v_row.call_activity_id::text)::uuid
    )
    on conflict (org_id, idempotency_key) where idempotency_key is not null do nothing;
    select n.id into v_note_id from public.lead_notes n
     where n.org_id = v_row.org_id and n.idempotency_key = md5('call_facts_summary:' || v_row.call_activity_id::text)::uuid;
  end if;

  update public.lead_call_facts
     set summary_note_id = v_note_id, facts = p_facts, status = p_status, model = p_model,
         extracted_at = now(), updated_at = now(), processing_state = 'done', lease_until = null
   where id = p_fact_id;

  return jsonb_build_object('replayed', false, 'summaryNoteId', v_note_id, 'status', p_status);
end;
$$;
revoke all on function public.fn_complete_call_facts(uuid, uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.fn_complete_call_facts(uuid, uuid, jsonb, text, text) to service_role;

-- ----------------------------------------------------------------------------
-- fn_accept_call_fact (authenticated)
-- ----------------------------------------------------------------------------
create or replace function public.fn_accept_call_fact(p_org_id uuid, p_fact_id uuid, p_field text, p_value text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.my_leads_workflow_require_actor(p_org_id);
  v_row public.lead_call_facts%rowtype;
  v_label text;
  v_value text;
  v_item jsonb;
  v_note_key uuid;
  v_inserted integer;
begin
  v_label := case p_field
    when 'asking_price' then 'Asking price'
    when 'mortgage' then 'Mortgage'
    when 'motivation' then 'Motivation'
    when 'timeline' then 'Timeline'
    when 'next_step' then 'Next step'
    when 'behind_on_payments' then 'Behind on payments'
    when 'pain_behind_on_payments' then 'Behind on payments'
    when 'pain_facing_auction' then 'Facing auction'
    when 'pain_back_taxes' then 'Back taxes'
    when 'pain_bankruptcy' then 'Bankruptcy'
    when 'pain_liens' then 'Liens'
    when 'pain_underwater' then 'Underwater'
    when 'pain_downsizing_health' then 'Downsizing health'
    when 'pain_moving_away' then 'Moving away'
    when 'pain_tired_landlord' then 'Tired landlord'
    when 'pain_inherited' then 'Inherited'
    when 'pain_divorce' then 'Divorce'
    when 'pain_vacant' then 'Vacant'
    when 'pain_failed_listing' then 'Failed listing'
    when 'pain_major_repairs' then 'Major repairs'
    when 'not_rushed' then 'Not rushed'
    when 'objection_think' then 'Decision time'
    when 'objection_relocation' then 'Housing delay'
    when 'objection_consult' then 'Consult another person'
    when 'objection_review_agreement' then 'Personal agreement review'
    when 'objection_unknown' then 'Other question or concern'
    when 'objection_trust_signing' then 'Trust'
    when 'objection_earnest_proof' then 'Funding or earnest money'
    when 'objection_price_pushback' then 'Offered-price pushback'
    when 'objection_listing_realtor' then 'Listing alternative'
    when 'objection_external_valuation' then 'Outside valuation'
    when 'objection_buyer_identity' then 'Buyer identity'
    when 'objection_property_access' then 'Property access'
    when 'objection_right_price_preoffer' then 'Initial offer request'
    when 'objection_offer_now' then 'Offer-now condition'
    when 'objection_attorney_review' then 'Attorney review'
    when 'objection_closing_certainty' then 'Closing certainty'
    when 'objection_text_only' then 'Switch to text'
    when 'objection_busy_callback' then 'Busy or callback'
    when 'objection_buy_without_visit' then 'Sight-unseen explanation'
    when 'objection_timing_feasibility' then 'Closing timing'
    when 'objection_competing_offer' then 'Competing offer'
    when 'objection_transaction_process' then 'Transaction process'
    when 'objection_email_refusal' then 'Email refusal'
    when 'objection_assignment_fee' then 'Company compensation'
    when 'objection_legal_question' then 'Contract meaning'
    when 'objection_seller_costs' then 'Seller costs'
    when 'objection_offer_calculation' then 'Offer calculation'
    when 'objection_offer_changes' then 'Offer changes'
    when 'objection_property_preparation' then 'Property preparation'
    when 'bad_experience' then 'Bad experience'
    when 'condition' then 'Condition'
    else null end;
  if v_label is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;

  select * into v_row from public.lead_call_facts where id = p_fact_id and org_id = p_org_id for update;
  if not found or v_row.processing_state <> 'done' then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  -- Same scope as the app action: the lead must be in the caller's own My Leads queue.
  perform public.my_leads_require_read_scope(p_org_id, v_actor);
  if not exists (select 1 from public.properties p
                  where p.id = v_row.property_id and p.org_id = p_org_id and p.assigned_user_id = v_actor and p.deleted_at is null) then
    raise exception 'STALE_ASSIGNMENT' using errcode = '42501';
  end if;
  if v_row.status = 'dismissed' or not (v_row.facts ? p_field) then
    raise exception 'NOT_ACCEPTABLE' using errcode = '22023';
  end if;
  if v_row.accepted ? p_field then
    return jsonb_build_object('duplicate', true, 'field', p_field, 'status', v_row.status);
  end if;

  -- The stored proposal is the only source of the value: p_value is kept for signature stability and IGNORED.
  -- The value is the verbatim call text; nothing derived is written to the note.
  v_item := v_row.facts -> p_field;
  v_value := btrim(coalesce(v_item ->> 'value', ''));
  if v_value = '' or length(v_value) > 500 then
    raise exception 'NOT_ACCEPTABLE' using errcode = '22023';
  end if;

  v_note_key := md5('call_fact_accept:' || p_fact_id::text || ':' || p_field)::uuid;
  insert into public.lead_notes (org_id, property_id, author_user_id, body, idempotency_key)
  values (p_org_id, v_row.property_id, v_actor, 'From call summary - ' || v_label || ': ' || v_value, v_note_key)
  on conflict (org_id, idempotency_key) where idempotency_key is not null do nothing;
  get diagnostics v_inserted = row_count;

  update public.lead_call_facts
     set accepted = accepted || jsonb_build_object(p_field,
           jsonb_build_object('value', v_value, 'by', v_actor, 'at', now())
           || (v_item - 'value' - 'evidence')),
         status = 'partially_accepted', updated_at = now()
   where id = p_fact_id;
  return jsonb_build_object('duplicate', false, 'field', p_field, 'status', 'partially_accepted', 'noteWritten', v_inserted = 1);
end;
$$;
revoke all on function public.fn_accept_call_fact(uuid, uuid, text, text) from public, anon;
grant execute on function public.fn_accept_call_fact(uuid, uuid, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- fn_unaccept_call_fact (authenticated): compensation when the appointment behind an accepted
-- next_step could not be created. Removes the acceptance and its note so the chip comes back.
-- ----------------------------------------------------------------------------
create or replace function public.fn_unaccept_call_fact(p_org_id uuid, p_fact_id uuid, p_field text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.my_leads_workflow_require_actor(p_org_id);
  v_row public.lead_call_facts%rowtype;
begin
  select * into v_row from public.lead_call_facts where id = p_fact_id and org_id = p_org_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform public.my_leads_require_read_scope(p_org_id, v_actor);
  if not exists (select 1 from public.properties p
                  where p.id = v_row.property_id and p.org_id = p_org_id and p.assigned_user_id = v_actor and p.deleted_at is null) then
    raise exception 'STALE_ASSIGNMENT' using errcode = '42501';
  end if;
  if not (v_row.accepted ? p_field) or (v_row.accepted -> p_field ->> 'by')::uuid is distinct from v_actor then
    return jsonb_build_object('reverted', false);
  end if;
  delete from public.lead_notes
   where org_id = p_org_id and idempotency_key = md5('call_fact_accept:' || p_fact_id::text || ':' || p_field)::uuid;
  update public.lead_call_facts
     set accepted = accepted - p_field,
         status = case when status = 'partially_accepted' and (accepted - p_field) = '{}'::jsonb then 'proposed' else status end,
         updated_at = now()
   where id = p_fact_id;
  return jsonb_build_object('reverted', true);
end;
$$;
revoke all on function public.fn_unaccept_call_fact(uuid, uuid, text) from public, anon;
grant execute on function public.fn_unaccept_call_fact(uuid, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- fn_dismiss_call_facts (authenticated)
-- ----------------------------------------------------------------------------
create or replace function public.fn_dismiss_call_facts(p_org_id uuid, p_fact_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := public.my_leads_workflow_require_actor(p_org_id);
  v_row public.lead_call_facts%rowtype;
begin
  select * into v_row from public.lead_call_facts where id = p_fact_id and org_id = p_org_id for update;
  if not found or v_row.processing_state <> 'done' then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform public.my_leads_require_read_scope(p_org_id, v_actor);
  if not exists (select 1 from public.properties p
                  where p.id = v_row.property_id and p.org_id = p_org_id and p.assigned_user_id = v_actor and p.deleted_at is null) then
    raise exception 'STALE_ASSIGNMENT' using errcode = '42501';
  end if;
  if v_row.status in ('dismissed', 'no_facts') then
    return jsonb_build_object('status', 'dismissed', 'duplicate', true, 'by', v_actor);
  end if;
  update public.lead_call_facts set status = 'dismissed', updated_at = now() where id = p_fact_id;
  return jsonb_build_object('status', 'dismissed', 'duplicate', false, 'by', v_actor);
end;
$$;
revoke all on function public.fn_dismiss_call_facts(uuid, uuid) from public, anon;
grant execute on function public.fn_dismiss_call_facts(uuid, uuid) to authenticated;

commit;
