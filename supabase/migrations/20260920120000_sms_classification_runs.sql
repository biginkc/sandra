-- Jev (TypeSafe) SMS-classification adapter: audit trail + machine
-- acceptance. Extends ai_disposition_reviews (20260827110000) rather than
-- replacing it — the review row is still the authoritative "has a human
-- looked at this" workflow state; sms_classification_runs is the
-- immutable evidence a machine decision was based on, and auto_accepted
-- is a truthful third resolution alongside pending/confirmed/superseded.
--
-- dnc is intentionally EXCLUDED from ever reaching auto_accepted, at the
-- database level, not just the application level (Jarrad ruling,
-- 2026-09-20): a genuine legal/DNC-registry demand may carry
-- record-keeping/escalation obligations a classifier shouldn't
-- unilaterally resolve, regardless of confidence.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- ----------------------------------------------------------------------------
-- sms_classification_runs — immutable evidence per classification attempt
-- ----------------------------------------------------------------------------
create table public.sms_classification_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  conversation_id uuid not null,
  source_inbound_message_id uuid not null references public.messages(id),
  -- Hash of the state actually sent to the provider (thread + business
  -- state), not the raw text — never store full SMS bodies here.
  state_hash text not null,
  state_version integer not null default 1,
  schema_version text not null,
  policy_version text not null,
  provider text not null,
  model text not null,
  -- Validated decision + Jev's per-answer probability distributions.
  -- No secrets, no raw SMS bodies — outcome/scope/reason enums and
  -- numeric distributions only.
  decision jsonb not null,
  resolved_outcome text,
  usage jsonb,
  latency_ms integer,
  fallback_reason text,
  created_at timestamptz not null default now(),
  constraint sms_classification_runs_property_org_fkey
    foreign key (property_id, org_id)
    references public.properties(id, org_id),
  constraint sms_classification_runs_provider_check
    check (provider in ('jev', 'legacy'))
);

comment on table public.sms_classification_runs is
  'Immutable audit record of one SMS-classification attempt (Jev or legacy). Evidence for ai_disposition_reviews.classification_run_id, not itself the applied outcome.';
comment on column public.sms_classification_runs.state_hash is
  'Hash of provider input (thread + state), not the raw content — lets a later attempt detect a stale context without storing SMS bodies twice.';
comment on column public.sms_classification_runs.decision is
  'Validated outcome/scope/reason enums + probability distributions only. No message bodies, no secrets.';

-- One logical evaluation per (message, provider, model, schema) — a
-- retry with the identical inputs reuses this row rather than creating a
-- duplicate; a genuinely changed context (state_hash differs) is a new
-- row, which is intentional, not a conflict.
create unique index idx_sms_classification_runs_logical_key
  on public.sms_classification_runs
  (source_inbound_message_id, provider, model, schema_version, state_hash);

create index idx_sms_classification_runs_conversation
  on public.sms_classification_runs (org_id, conversation_id, created_at desc);

create index idx_sms_classification_runs_property
  on public.sms_classification_runs (property_id, created_at desc);

alter table public.sms_classification_runs enable row level security;

create policy sms_classification_runs_org_select
  on public.sms_classification_runs
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id));

revoke all on table public.sms_classification_runs
  from public, anon, authenticated, service_role;
grant select on table public.sms_classification_runs to authenticated;
grant select, insert on table public.sms_classification_runs to service_role;

-- ----------------------------------------------------------------------------
-- ai_disposition_reviews — add auto_accepted status + provenance link
-- ----------------------------------------------------------------------------
alter table public.ai_disposition_reviews
  add column if not exists classification_run_id uuid
    references public.sms_classification_runs(id);

alter table public.ai_disposition_reviews
  drop constraint if exists ai_disposition_reviews_status_check;
alter table public.ai_disposition_reviews
  add constraint ai_disposition_reviews_status_check
  check (status in ('pending', 'confirmed', 'superseded', 'auto_accepted'));

alter table public.ai_disposition_reviews
  drop constraint if exists ai_disposition_reviews_resolution_check;
alter table public.ai_disposition_reviews
  add constraint ai_disposition_reviews_resolution_check
  check (
    (status = 'pending'
      and resolved_at is null
      and reviewed_by is null
      and superseded_reason is null)
    or
    (status = 'confirmed'
      and resolved_at is not null
      and reviewed_by is not null
      and superseded_reason is null)
    or
    (status = 'superseded'
      and resolved_at is not null
      and reviewed_by is null
      and superseded_reason is not null)
    or
    (status = 'auto_accepted'
      and resolved_at is not null
      and reviewed_by is null
      and superseded_reason is null
      and classification_run_id is not null)
  );

-- dnc is hard-blocked from ever carrying an auto_accepted row, enforced
-- at the schema level so an application bug can't silently route a
-- legal/DNC-registry decision around the human gate.
alter table public.ai_disposition_reviews
  add constraint ai_disposition_reviews_dnc_never_auto_accepted
  check (not (disposition = 'dnc' and status = 'auto_accepted'));

-- ----------------------------------------------------------------------------
-- fn_accept_ai_disposition_review — service-role-only machine acceptance
--
-- Mirrors fn_confirm_ai_disposition_review's supersede-on-mismatch and
-- lock-ordering logic exactly, but:
--   · requires service_role (never a signed-in user — the caller is the
--     dispatch pipeline, after its own effects already succeeded)
--   · sets reviewed_by = null, links classification_run_id
--   · hard-rejects disposition = 'dnc' (belt-and-suspenders with the
--     table constraint above — fail loud here rather than let the insert
--     bounce off the CHECK with a less specific error)
--   · retry-safe: returns the existing resolution on a second call
--     instead of erroring, per the plan's "run acceptance only after
--     required effects succeeded; on failure, retry acceptance without
--     repeating SMS/suppression effects" requirement
-- ----------------------------------------------------------------------------
create or replace function public.fn_accept_ai_disposition_review(
  p_review_id uuid,
  p_classification_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_review public.ai_disposition_reviews%rowtype;
  v_outreach_dispo text;
  v_run public.sms_classification_runs%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required'
      using errcode = '42501';
  end if;

  select run.*
  into v_run
  from public.sms_classification_runs run
  where run.id = p_classification_run_id;

  if not found then
    raise exception 'classification run not found'
      using errcode = 'P0002';
  end if;

  select review.*
  into v_review
  from public.ai_disposition_reviews review
  where review.id = p_review_id;

  if not found then
    raise exception 'AI disposition review not found'
      using errcode = 'P0002';
  end if;

  if v_review.org_id is distinct from v_run.org_id
    or v_review.property_id is distinct from v_run.property_id
    or v_review.conversation_id is distinct from v_run.conversation_id
  then
    raise exception 'classification run does not match review org/property/conversation'
      using errcode = '23514';
  end if;

  if v_review.disposition = 'dnc' then
    raise exception 'dnc dispositions require human confirmation and can never be auto-accepted'
      using errcode = '42501';
  end if;

  -- Match the AI writer's / confirm RPC's property -> review lock order.
  select p.outreach_dispo
  into v_outreach_dispo
  from public.properties p
  where p.id = v_review.property_id
    and p.org_id = v_review.org_id
  for update;

  if not found then
    raise exception 'AI disposition review property not found'
      using errcode = 'P0002';
  end if;

  select review.*
  into v_review
  from public.ai_disposition_reviews review
  where review.id = p_review_id
  for update;

  if not found then
    raise exception 'AI disposition review not found'
      using errcode = 'P0002';
  end if;

  if v_review.status <> 'pending' then
    -- Retry-safe: a second acceptance attempt (e.g. after a transient
    -- failure elsewhere in dispatch) returns the already-resolved status
    -- rather than erroring, so the caller never re-runs SMS/suppression
    -- effects to retry this step alone.
    return jsonb_build_object(
      'status', v_review.status,
      'reviewId', v_review.id
    );
  end if;

  if v_outreach_dispo is distinct from v_review.disposition then
    update public.ai_disposition_reviews
    set status = 'superseded',
        resolved_at = now(),
        superseded_reason = 'property_outcome_changed'
    where id = v_review.id;

    insert into public.lead_events (
      org_id, property_id, actor_type, event_type, payload,
      source_type, source_id
    ) values (
      v_review.org_id,
      v_review.property_id,
      'system',
      'ai_dispo_review_superseded',
      jsonb_build_object(
        'review_id', v_review.id,
        'proposed_disposition', v_review.disposition,
        'replacement_disposition', v_outreach_dispo,
        'reason', 'property_outcome_changed',
        'source_inbound_message_id', v_review.source_inbound_message_id
      ),
      'ai_disposition_reviews.superseded',
      v_review.id
    )
    on conflict (source_type, source_id) where source_id is not null do nothing;

    return jsonb_build_object(
      'status', 'superseded',
      'reviewId', v_review.id
    );
  end if;

  update public.ai_disposition_reviews
  set status = 'auto_accepted',
      resolved_at = now(),
      reviewed_by = null,
      classification_run_id = p_classification_run_id
  where id = v_review.id;

  insert into public.lead_events (
    org_id, property_id, actor_type, event_type, payload,
    source_type, source_id
  ) values (
    v_review.org_id,
    v_review.property_id,
    'system',
    'ai_dispo_review_auto_accepted',
    jsonb_build_object(
      'review_id', v_review.id,
      'disposition', v_review.disposition,
      'classification_run_id', p_classification_run_id,
      'source_inbound_message_id', v_review.source_inbound_message_id
    ),
    'ai_disposition_reviews.auto_accepted',
    v_review.id
  )
  on conflict (source_type, source_id) where source_id is not null do nothing;

  return jsonb_build_object(
    'status', 'auto_accepted',
    'reviewId', v_review.id
  );
end;
$$;

revoke all on function public.fn_accept_ai_disposition_review(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_accept_ai_disposition_review(uuid, uuid)
  to service_role;

-- ----------------------------------------------------------------------------
-- ai_responder_configs — classifier provider/mode settings (per-org)
--
-- Separate from `model`/`min_confidence`, which govern the existing
-- combined Claude classify+generate call. classifier_provider/mode
-- govern ONLY the sms-classification adapter's decision step.
-- ----------------------------------------------------------------------------
alter table public.ai_responder_configs
  add column if not exists classifier_provider text not null default 'legacy'
    check (classifier_provider in ('legacy', 'jev')),
  add column if not exists classifier_mode text not null default 'shadow'
    check (classifier_mode in ('shadow', 'automatic')),
  add column if not exists classifier_fallback_max_consecutive integer
    not null default 2 check (classifier_fallback_max_consecutive >= 0);

comment on column public.ai_responder_configs.classifier_provider is
  'legacy = existing combined Claude classify+generate call (default, zero behavior change). jev = TypeSafe decision-only classifier.';
comment on column public.ai_responder_configs.classifier_mode is
  'shadow = Jev decision computed + persisted to sms_classification_runs, but legacy decision still drives dispatched effects (default). automatic = Jev decision drives effects. dnc can never reach automatic regardless of this flag — enforced by ai_disposition_reviews_dnc_never_auto_accepted.';
comment on column public.ai_responder_configs.classifier_fallback_max_consecutive is
  'After this many consecutive Jev failures/timeouts for one conversation, fall back to the legacy provider for that conversation rather than retrying indefinitely. NOT YET READ BY ANY CODE as of 2026-09-20 (Fable PR review finding) — dispatch-bridge.ts currently falls back to legacy on every single Jev failure, with no per-conversation counter. This column exists for a future consecutive-failure-budget implementation; do not assume it is live config until that lands.';

-- ----------------------------------------------------------------------------
-- Jev-driven DNC: suppress immediately, defer the disposition write
--
-- Astra PR review finding (2026-09-20, BLOCKING): the original version of
-- this adapter let close_dnc's existing effect function
-- (applyResponderDnc) run immediately for Jev-driven decisions too —
-- same as legacy. That means the *disposition write* (properties.
-- outreach_dispo='dnc') happened before any human saw it, even though
-- auto-ACCEPT of the review record was correctly blocked. A review row
-- that documents an already-applied decision is not a gate.
--
-- Jarrad's decision (2026-09-20, "Option B"): the phone-suppression
-- effect (consent_events / applyPhoneLevelOptOut, application-side, TS)
-- still happens immediately — halting suppression until a human clicks
-- something would mean continuing to text someone who just invoked
-- DNC/legal language, which is the worse risk. What waits for a human is
-- specifically the outreach_dispo='dnc' write and the disposition/
-- paperwork implications that go with it.
--
-- dispo_applied tracks whether THIS ROW'S disposition write has actually
-- landed on properties.outreach_dispo yet. Every existing/legacy review
-- path defaults it to true — legacy's fn_apply_ai_disposition_with_review
-- writes outreach_dispo in the same transaction as creating the review,
-- unchanged, so for those rows "applied" is simply always true, same as
-- today. Only the new fn_propose_ai_dnc_suppression_review RPC below ever
-- creates a row with dispo_applied=false.
-- ----------------------------------------------------------------------------
alter table public.ai_disposition_reviews
  add column if not exists dispo_applied boolean not null default true;

comment on column public.ai_disposition_reviews.dispo_applied is
  'true (default, matches every existing review path) = properties.outreach_dispo already reflects this row''s disposition. false = only ever set by fn_propose_ai_dnc_suppression_review for a Jev-driven dnc decision — the phone is already suppressed (consent_events, applied by application code before/alongside this RPC), but outreach_dispo has NOT been written yet; fn_confirm_ai_disposition_review applies it at confirm time and flips this to true.';

-- Service-role-only. Creates a pending review for a Jev-driven dnc
-- decision WITHOUT writing properties.outreach_dispo — that write is
-- deferred to fn_confirm_ai_disposition_review. Does not touch
-- consent_events either; phone suppression is applied by the caller
-- (dispatch.ts, via the existing applyPhoneLevelOptOut) before or
-- alongside calling this RPC, not by this function.
create or replace function public.fn_propose_ai_dnc_suppression_review(
  p_property_id uuid,
  p_conversation_id uuid,
  p_source_inbound_message_id uuid,
  p_ai_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_message record;
  v_property record;
  v_existing_review public.ai_disposition_reviews%rowtype;
  v_pending_review public.ai_disposition_reviews%rowtype;
  v_review public.ai_disposition_reviews%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required'
      using errcode = '42501';
  end if;

  if nullif(btrim(p_ai_reason), '') is null then
    raise exception 'AI disposition reason is required'
      using errcode = '22023';
  end if;

  select m.id, m.org_id, m.property_id, m.conversation_id
  into v_message
  from public.messages m
  where m.id = p_source_inbound_message_id
    and m.channel = 'sms'
    and m.direction = 'inbound'
  for share;

  if not found
    or v_message.property_id is distinct from p_property_id
    or v_message.conversation_id is distinct from p_conversation_id
  then
    raise exception 'inbound SMS does not match property/conversation'
      using errcode = '23514';
  end if;

  select p.org_id, p.outreach_dispo, p.needs_human_attention
  into v_property
  from public.properties p
  where p.id = p_property_id
    and p.org_id = v_message.org_id
  for update;

  if not found then
    raise exception 'property does not match inbound SMS organization'
      using errcode = '23514';
  end if;

  select review.*
  into v_existing_review
  from public.ai_disposition_reviews review
  where review.source_inbound_message_id = p_source_inbound_message_id;

  if found then
    return jsonb_build_object(
      'status', 'replayed',
      'reviewId', v_existing_review.id,
      'reviewStatus', v_existing_review.status
    );
  end if;

  if v_property.outreach_dispo = 'dnc' then
    -- Already dnc (e.g. a prior confirmed review) — nothing left to
    -- propose.
    return jsonb_build_object('status', 'already_terminal');
  end if;

  select review.*
  into v_pending_review
  from public.ai_disposition_reviews review
  where review.org_id = v_message.org_id
    and review.conversation_id = p_conversation_id
    and review.status = 'pending'
  for update;

  if v_pending_review.id is not null then
    update public.ai_disposition_reviews
    set status = 'superseded',
        resolved_at = now(),
        superseded_reason = 'new_ai_decision'
    where id = v_pending_review.id;

    insert into public.lead_events (
      org_id, property_id, actor_type, event_type, payload,
      source_type, source_id
    ) values (
      v_message.org_id,
      p_property_id,
      'system',
      'ai_dispo_review_superseded',
      jsonb_build_object(
        'review_id', v_pending_review.id,
        'proposed_disposition', v_pending_review.disposition,
        'replacement_disposition', 'dnc',
        'reason', 'new_ai_decision',
        'source_inbound_message_id', v_pending_review.source_inbound_message_id
      ),
      'ai_disposition_reviews.superseded',
      v_pending_review.id
    )
    on conflict (source_type, source_id) where source_id is not null do nothing;
  end if;

  -- Mark needs_human_attention so this surfaces for review, WITHOUT
  -- touching outreach_dispo — that is the entire point of this RPC.
  update public.properties
  set needs_human_attention = true,
      updated_at = now()
  where id = p_property_id
    and org_id = v_message.org_id;

  insert into public.ai_disposition_reviews (
    org_id,
    property_id,
    conversation_id,
    source_inbound_message_id,
    disposition,
    ai_reason,
    dispo_applied
  ) values (
    v_message.org_id,
    p_property_id,
    p_conversation_id,
    p_source_inbound_message_id,
    'dnc',
    btrim(p_ai_reason),
    false
  )
  returning * into v_review;

  insert into public.lead_events (
    org_id, property_id, actor_type, event_type, payload,
    source_type, source_id
  ) values (
    v_message.org_id,
    p_property_id,
    'ai',
    'dispo_proposed',
    jsonb_build_object(
      'disposition', 'dnc',
      'review_id', v_review.id,
      'reason', btrim(p_ai_reason),
      'source_inbound_message_id', p_source_inbound_message_id,
      'note', 'suppression already applied by caller; outreach_dispo write deferred to human confirmation'
    ),
    'ai_disposition_reviews.proposed',
    v_review.id
  );

  return jsonb_build_object(
    'status', 'proposed',
    'reviewId', v_review.id,
    'reviewStatus', v_review.status
  );
end;
$$;

revoke all on function public.fn_propose_ai_dnc_suppression_review(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.fn_propose_ai_dnc_suppression_review(
  uuid, uuid, uuid, text
) to service_role;

-- Extends fn_confirm_ai_disposition_review (20260827110000) to apply the
-- deferred outreach_dispo write when dispo_applied=false. Every existing
-- call site/row has dispo_applied=true, for which this function's
-- behavior is byte-for-byte identical to the original — the new branch
-- is unreachable for any pre-existing row shape.
create or replace function public.fn_confirm_ai_disposition_review(
  p_review_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_review public.ai_disposition_reviews%rowtype;
  v_outreach_dispo text;
begin
  if auth.uid() is null then
    raise exception 'signed-in user required'
      using errcode = '42501';
  end if;

  select review.*
  into v_review
  from public.ai_disposition_reviews review
  where review.id = p_review_id;

  if not found then
    raise exception 'AI disposition review not found'
      using errcode = 'P0002';
  end if;

  if not public.hugo_has_active_org_access(v_review.org_id) then
    raise exception 'active organization access required'
      using errcode = '42501';
  end if;

  select p.outreach_dispo
  into v_outreach_dispo
  from public.properties p
  where p.id = v_review.property_id
    and p.org_id = v_review.org_id
  for update;

  if not found then
    raise exception 'AI disposition review property not found'
      using errcode = 'P0002';
  end if;

  select review.*
  into v_review
  from public.ai_disposition_reviews review
  where review.id = p_review_id
  for update;

  if not found then
    raise exception 'AI disposition review not found'
      using errcode = 'P0002';
  end if;

  if v_review.status <> 'pending' then
    return jsonb_build_object(
      'status', v_review.status,
      'reviewId', v_review.id
    );
  end if;

  -- Unapplied proposal (Jev-driven dnc, Option B): outreach_dispo was
  -- deliberately never written by the propose step. Write it now, as
  -- part of this human confirmation, instead of running the
  -- already-applied supersede-on-mismatch check below (which assumes
  -- outreach_dispo already reflects this review's disposition — for an
  -- unapplied row it never did, by design).
  if not v_review.dispo_applied then
    -- Astra PR review finding (2026-09-20, BLOCKING): the existing
    -- trigger `trg_properties_supersede_ai_disposition_reviews`
    -- (20260827110000) fires AFTER UPDATE OF outreach_dispo on
    -- properties and supersedes every `pending` review for that
    -- property/org — including this very row, if the property update
    -- ran first. That would flip this row to 'superseded' with
    -- superseded_reason set, and the very next statement here trying to
    -- set it to 'confirmed' would then violate
    -- ai_disposition_reviews_resolution_check (confirmed requires
    -- superseded_reason IS NULL). Order matters: resolve THIS review to
    -- 'confirmed' FIRST, while it's still 'pending' and this is the only
    -- statement touching it, so when the trigger fires off the property
    -- update below, its `where review.status = 'pending'` filter no
    -- longer matches this row at all.
    update public.ai_disposition_reviews
    set status = 'confirmed',
        resolved_at = now(),
        reviewed_by = auth.uid(),
        dispo_applied = true
    where id = v_review.id;

    update public.properties
    set outreach_dispo = v_review.disposition,
        needs_human_attention = false,
        last_ai_escalation_reason = null,
        updated_at = now()
    where id = v_review.property_id
      and org_id = v_review.org_id;

    insert into public.lead_events (
      org_id, property_id, actor_type, actor_id, event_type, payload,
      source_type, source_id
    ) values (
      v_review.org_id,
      v_review.property_id,
      'user',
      auth.uid(),
      'ai_dispo_review_confirmed',
      jsonb_build_object(
        'review_id', v_review.id,
        'disposition', v_review.disposition,
        'source_inbound_message_id', v_review.source_inbound_message_id,
        'note', 'deferred dispo write applied at confirmation'
      ),
      'ai_disposition_reviews.confirmed',
      v_review.id
    )
    on conflict (source_type, source_id) where source_id is not null do nothing;

    return jsonb_build_object(
      'status', 'confirmed',
      'reviewId', v_review.id
    );
  end if;

  if v_outreach_dispo is distinct from v_review.disposition then
    update public.ai_disposition_reviews
    set status = 'superseded',
        resolved_at = now(),
        superseded_reason = 'property_outcome_changed'
    where id = v_review.id;

    insert into public.lead_events (
      org_id, property_id, actor_type, event_type, payload,
      source_type, source_id
    ) values (
      v_review.org_id,
      v_review.property_id,
      'system',
      'ai_dispo_review_superseded',
      jsonb_build_object(
        'review_id', v_review.id,
        'proposed_disposition', v_review.disposition,
        'replacement_disposition', v_outreach_dispo,
        'reason', 'property_outcome_changed',
        'source_inbound_message_id', v_review.source_inbound_message_id
      ),
      'ai_disposition_reviews.superseded',
      v_review.id
    )
    on conflict (source_type, source_id) where source_id is not null do nothing;

    return jsonb_build_object(
      'status', 'superseded',
      'reviewId', v_review.id
    );
  end if;

  update public.ai_disposition_reviews
  set status = 'confirmed',
      resolved_at = now(),
      reviewed_by = auth.uid()
  where id = v_review.id;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload,
    source_type, source_id
  ) values (
    v_review.org_id,
    v_review.property_id,
    'user',
    auth.uid(),
    'ai_dispo_review_confirmed',
    jsonb_build_object(
      'review_id', v_review.id,
      'disposition', v_review.disposition,
      'source_inbound_message_id', v_review.source_inbound_message_id
    ),
    'ai_disposition_reviews.confirmed',
    v_review.id
  )
  on conflict (source_type, source_id) where source_id is not null do nothing;

  return jsonb_build_object(
    'status', 'confirmed',
    'reviewId', v_review.id
  );
end;
$$;

commit;
