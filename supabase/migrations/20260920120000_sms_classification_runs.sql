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
  'After this many consecutive Jev failures/timeouts for one conversation, fall back to the legacy provider for that conversation rather than retrying indefinitely.';

commit;
