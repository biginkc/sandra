-- Root direct-review findings (jev-root-ui-review.md, 2026-09-20):
--
-- 1. auto_accepted / system-confirmed rows must be reviewable — a human
--    marking one as reviewed must record that fact WITHOUT re-running
--    any disposition/promotion write (the effect already landed).
-- 2. Correction must cover the full taxonomy (including new_lead and
--    opted_out/dnc) via the EXISTING sanctioned suppression/promotion
--    operations (qualifyProperty, setOutreachDispo) — not a parallel
--    from-scratch SQL reimplementation of TCPA suppression. The
--    application-layer flow is: call the sanctioned TS operation first
--    (it has its own staleness guard and does the real write/suppression
--    side effect), then call one of the RPCs below to record the
--    correction in the audit trail — same "effect first, record second"
--    ordering already used for auto-apply.
--
-- This migration is purely additive: new columns, widened CHECK
-- constraints (to accept the full outcome set as an audit value), and
-- new RPCs. No existing column, constraint, or RPC behavior changes.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- ----------------------------------------------------------------------------
-- "Mark reviewed" — a human looked at an already-applied decision
-- (auto_accepted, or jev_lead_decisions' system-confirmed rows where
-- resolved_by is null) without re-applying anything. Idempotent: a
-- second mark is a no-op that returns the original reviewer/time.
-- ----------------------------------------------------------------------------
alter table public.ai_disposition_reviews
  add column if not exists human_reviewed_at timestamptz,
  add column if not exists human_reviewed_by uuid references auth.users(id);

alter table public.jev_lead_decisions
  add column if not exists human_reviewed_at timestamptz,
  add column if not exists human_reviewed_by uuid references auth.users(id);

comment on column public.ai_disposition_reviews.human_reviewed_at is
  'A human looked at this decision (any status), independent of confirm/correct. Never implies the underlying disposition changed.';
comment on column public.jev_lead_decisions.human_reviewed_at is
  'A human looked at this decision (any status), independent of confirm/correct. Never implies the underlying disposition changed.';

create or replace function public.fn_mark_ai_disposition_review_reviewed(
  p_review_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_review public.ai_disposition_reviews%rowtype;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  select * into v_review from public.ai_disposition_reviews where id = p_review_id;
  if not found then
    raise exception 'REVIEW_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_review.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if v_review.human_reviewed_at is null then
    update public.ai_disposition_reviews
    set human_reviewed_at = now(), human_reviewed_by = v_actor
    where id = p_review_id;
    v_review.human_reviewed_at := now();
    v_review.human_reviewed_by := v_actor;
  end if;

  return jsonb_build_object(
    'status', 'reviewed',
    'reviewId', p_review_id,
    'humanReviewedAt', v_review.human_reviewed_at,
    'humanReviewedBy', v_review.human_reviewed_by
  );
end;
$$;

revoke all on function public.fn_mark_ai_disposition_review_reviewed(uuid)
  from public, anon, service_role;
grant execute on function public.fn_mark_ai_disposition_review_reviewed(uuid) to authenticated;

create or replace function public.fn_mark_jev_lead_decision_reviewed(
  p_decision_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_decision public.jev_lead_decisions%rowtype;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  select * into v_decision from public.jev_lead_decisions where id = p_decision_id;
  if not found then
    raise exception 'DECISION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_decision.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if v_decision.human_reviewed_at is null then
    update public.jev_lead_decisions
    set human_reviewed_at = now(), human_reviewed_by = v_actor
    where id = p_decision_id;
    v_decision.human_reviewed_at := now();
    v_decision.human_reviewed_by := v_actor;
  end if;

  return jsonb_build_object(
    'status', 'reviewed',
    'decisionId', p_decision_id,
    'humanReviewedAt', v_decision.human_reviewed_at,
    'humanReviewedBy', v_decision.human_reviewed_by
  );
end;
$$;

revoke all on function public.fn_mark_jev_lead_decision_reviewed(uuid)
  from public, anon, service_role;
grant execute on function public.fn_mark_jev_lead_decision_reviewed(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Widen the audit-value CHECK constraints so the full taxonomy can be
-- RECORDED (not necessarily directly WRITTEN by SQL) as a correction
-- outcome. fn_correct_ai_disposition_review / fn_correct_jev_lead_decision
-- (the direct-write RPCs) are UNCHANGED — they still only accept their
-- original restricted target sets and still never touch suppression.
-- ----------------------------------------------------------------------------
alter table public.ai_disposition_reviews
  drop constraint if exists ai_disposition_reviews_corrected_disposition_check;
alter table public.ai_disposition_reviews
  add constraint ai_disposition_reviews_corrected_disposition_check
  check (corrected_disposition is null or corrected_disposition in
    ('new_lead', 'wrong_number', 'not_interested', 'nurture', 'opted_out', 'dnc'));

alter table public.jev_lead_decisions
  drop constraint if exists jev_lead_decisions_resolved_outcome_check;
alter table public.jev_lead_decisions
  add constraint jev_lead_decisions_resolved_outcome_check
  check (resolved_outcome is null or resolved_outcome in
    ('new_lead', 'nurture', 'wrong_number', 'not_interested', 'opted_out', 'dnc'));

-- ----------------------------------------------------------------------------
-- fn_begin_ai_disposition_review_correction — root final-review finding
-- (P1, jev-root-final-review.md, 2026-09-20): the TS action was calling
-- qualifyProperty/setOutreachDispo using a CALLER-SUPPLIED property id,
-- before validating anything about the review row — a wrong/mismatched
-- id could mutate an unrelated property, and a stale review (something
-- changed since Jev's decision) had no guard at all before the
-- sanctioned operation ran. This RPC is the authoritative first step:
-- it locks and validates the review row, re-checks the SAME staleness
-- condition fn_correct_ai_disposition_review already enforces, and
-- returns the property id FROM THE LOCKED ROW ITSELF — the caller must
-- use this value, never a client-supplied one, for the sanctioned
-- operation that follows. Mutates nothing.
-- ----------------------------------------------------------------------------
create or replace function public.fn_begin_ai_disposition_review_correction(
  p_review_id uuid,
  p_corrected_disposition text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_review public.ai_disposition_reviews%rowtype;
  v_property record;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_corrected_disposition not in ('new_lead', 'opted_out', 'dnc') then
    raise exception 'INVALID_CORRECTION_TARGET' using errcode = '22023';
  end if;

  select * into v_review from public.ai_disposition_reviews where id = p_review_id for update;
  if not found then
    raise exception 'REVIEW_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_review.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select p.status, p.outreach_dispo, p.is_dnc_locked
  into v_property
  from public.properties p
  where p.id = v_review.property_id and p.org_id = v_review.org_id;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- trg_properties_supersede_ai_disposition_reviews auto-supersedes any
  -- pending review the instant properties.outreach_dispo changes — which
  -- includes THIS correction's own sanctioned setOutreachDispo call, if a
  -- prior attempt got that far before its record step failed/was never
  -- reached. That self-caused supersede (superseded_reason =
  -- 'property_outcome_changed' AND outreach_dispo already equals what
  -- this correction asked for) is a retry, not staleness. Any other
  -- superseded review — a genuine new Jev decision, or someone else's
  -- write to a different value — is real staleness.
  if v_review.status = 'superseded'
    and not (
      v_review.superseded_reason = 'property_outcome_changed'
      and p_corrected_disposition <> 'new_lead'
      and v_property.outreach_dispo is not distinct from p_corrected_disposition
    )
  then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  -- Same staleness pre-check as fn_correct_ai_disposition_review: the
  -- property must still look like exactly what this review last
  -- resolved to (or, if never applied, still be untouched) — OR already
  -- match the outcome THIS correction is asking for, which means a
  -- prior attempt's sanctioned op already ran and only the record step
  -- failed/was never reached; that is a retry, not staleness, and must
  -- be allowed through so fn_record_*_correction can pick it up.
  if p_corrected_disposition = 'new_lead' then
    -- new_lead never touches outreach_dispo, so a partial-retry
    -- shortcut on that column doesn't apply here.
    if v_review.status = 'pending' and v_review.dispo_applied then
      if v_property.outreach_dispo is distinct from v_review.disposition then
        raise exception 'STALE_STATE' using errcode = '40001';
      end if;
    elsif v_review.status = 'pending' and not v_review.dispo_applied then
      if v_property.outreach_dispo is not null then
        raise exception 'STALE_STATE' using errcode = '40001';
      end if;
    elsif v_property.outreach_dispo is distinct from coalesce(v_review.corrected_disposition, v_review.disposition) then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  else
    if v_review.status = 'pending' and v_review.dispo_applied then
      if v_property.outreach_dispo is distinct from v_review.disposition
        and v_property.outreach_dispo is distinct from p_corrected_disposition
      then
        raise exception 'STALE_STATE' using errcode = '40001';
      end if;
    elsif v_review.status = 'pending' and not v_review.dispo_applied then
      if v_property.outreach_dispo is not null
        and v_property.outreach_dispo is distinct from p_corrected_disposition
      then
        raise exception 'STALE_STATE' using errcode = '40001';
      end if;
    elsif v_property.outreach_dispo is distinct from coalesce(v_review.corrected_disposition, v_review.disposition)
      and v_property.outreach_dispo is distinct from p_corrected_disposition
    then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  end if;

  return jsonb_build_object(
    'reviewId', v_review.id,
    'propertyId', v_review.property_id,
    'orgId', v_review.org_id,
    'isDncLocked', coalesce(v_property.is_dnc_locked, false)
  );
end;
$$;

revoke all on function public.fn_begin_ai_disposition_review_correction(uuid, text)
  from public, anon, service_role;
grant execute on function public.fn_begin_ai_disposition_review_correction(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- fn_record_ai_disposition_review_correction — records a correction to
-- new_lead/opted_out/dnc AFTER the caller already applied it via
-- qualifyProperty or setOutreachDispo (using the property id
-- fn_begin_ai_disposition_review_correction returned, never a caller-
-- supplied one). Re-verifies the ACTUAL resulting state before
-- recording — "already_qualified" is not treated as proof of new_lead
-- (the property could be at some later, unrelated status by the time
-- this runs); if the current state does not exactly match the claimed
-- correction, this fails STALE_STATE rather than recording a lie.
-- ----------------------------------------------------------------------------
create or replace function public.fn_record_ai_disposition_review_correction(
  p_review_id uuid,
  p_corrected_disposition text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_review public.ai_disposition_reviews%rowtype;
  v_property record;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_corrected_disposition not in ('new_lead', 'opted_out', 'dnc') then
    -- The other three targets (wrong_number/not_interested/nurture) go
    -- through fn_correct_ai_disposition_review, which both writes and
    -- records atomically — this RPC is only for the sanctioned-operation
    -- targets that can't be written from SQL alone.
    raise exception 'INVALID_CORRECTION_TARGET' using errcode = '22023';
  end if;

  select * into v_review from public.ai_disposition_reviews where id = p_review_id for update;
  if not found then
    raise exception 'REVIEW_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_review.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select p.status, p.outreach_dispo
  into v_property
  from public.properties p
  where p.id = v_review.property_id and p.org_id = v_review.org_id;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Truthful recording only: the property must actually be in the state
  -- this correction claims, right now — not "close enough"
  -- (already_qualified could mean any later status, not specifically
  -- new_lead; a racing write could have moved outreach_dispo again since
  -- the sanctioned operation ran).
  if p_corrected_disposition = 'new_lead' then
    if v_property.status is distinct from 'new_lead' then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  else
    if v_property.outreach_dispo is distinct from p_corrected_disposition then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  end if;

  update public.ai_disposition_reviews
  set corrected_disposition = p_corrected_disposition,
      corrected_at = now(),
      corrected_by = v_actor,
      correction_reason = nullif(btrim(p_reason), ''),
      dispo_applied = true,
      status = case when status = 'pending' then 'confirmed' else status end,
      resolved_at = case when status = 'pending' then now() else resolved_at end,
      reviewed_by = case when status = 'pending' then v_actor else reviewed_by end,
      human_reviewed_at = coalesce(human_reviewed_at, now()),
      human_reviewed_by = coalesce(human_reviewed_by, v_actor)
  where id = p_review_id;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload
  ) values (
    v_review.org_id, v_review.property_id, 'user', v_actor,
    'ai_disposition_review_corrected',
    jsonb_build_object(
      'review_id', v_review.id,
      'original_disposition', v_review.disposition,
      'previous_corrected_disposition', v_review.corrected_disposition,
      'corrected_disposition', p_corrected_disposition,
      'reason', p_reason,
      'applied_via', case p_corrected_disposition
        when 'new_lead' then 'qualifyProperty'
        else 'setOutreachDispo'
      end
    )
  );

  return jsonb_build_object(
    'status', 'corrected', 'reviewId', v_review.id,
    'correctedDisposition', p_corrected_disposition
  );
end;
$$;

revoke all on function public.fn_record_ai_disposition_review_correction(uuid, text, text)
  from public, anon, service_role;
grant execute on function public.fn_record_ai_disposition_review_correction(uuid, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- fn_begin_jev_lead_decision_correction — same "derive the authoritative
-- property id, validate staleness, mutate nothing" pattern as
-- fn_begin_ai_disposition_review_correction, for jev_lead_decisions'
-- opted_out/dnc targets.
-- ----------------------------------------------------------------------------
create or replace function public.fn_begin_jev_lead_decision_correction(
  p_decision_id uuid,
  p_corrected_outcome text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_decision public.jev_lead_decisions%rowtype;
  v_property record;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_corrected_outcome not in ('opted_out', 'dnc') then
    raise exception 'INVALID_CORRECTION_TARGET' using errcode = '22023';
  end if;

  select * into v_decision from public.jev_lead_decisions where id = p_decision_id for update;
  if not found then
    raise exception 'DECISION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_decision.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_decision.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  select p.status, p.outreach_dispo, p.is_dnc_locked
  into v_property
  from public.properties p
  where p.id = v_decision.property_id and p.org_id = v_decision.org_id;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Same staleness pre-check as fn_correct_jev_lead_decision — except a
  -- pending decision whose property already shows EXACTLY the outcome
  -- this correction is asking for is treated as a retry (a prior
  -- attempt's sanctioned op already ran and only the record step
  -- failed/was never reached), not staleness.
  if v_decision.status = 'pending' then
    if v_property.status is distinct from 'prospect'
      or (v_property.outreach_dispo is not null and v_property.outreach_dispo is distinct from p_corrected_outcome)
    then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  elsif v_decision.resolved_outcome = 'new_lead' then
    if v_property.status is distinct from 'new_lead' then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  else
    if v_property.outreach_dispo is distinct from v_decision.resolved_outcome
      and v_property.outreach_dispo is distinct from p_corrected_outcome
    then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  end if;

  return jsonb_build_object(
    'decisionId', v_decision.id,
    'propertyId', v_decision.property_id,
    'orgId', v_decision.org_id,
    'isDncLocked', coalesce(v_property.is_dnc_locked, false)
  );
end;
$$;

revoke all on function public.fn_begin_jev_lead_decision_correction(uuid, text)
  from public, anon, service_role;
grant execute on function public.fn_begin_jev_lead_decision_correction(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- fn_record_jev_lead_decision_correction — same pattern for
-- jev_lead_decisions' opted_out/dnc targets (new_lead/wrong_number/
-- not_interested/nurture keep using fn_correct_jev_lead_decision, which
-- already writes them directly). Re-verifies the actual resulting
-- outreach_dispo before recording — never blind-trusts the caller.
-- ----------------------------------------------------------------------------
create or replace function public.fn_record_jev_lead_decision_correction(
  p_decision_id uuid,
  p_corrected_outcome text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_decision public.jev_lead_decisions%rowtype;
  v_property record;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_corrected_outcome not in ('opted_out', 'dnc') then
    raise exception 'INVALID_CORRECTION_TARGET' using errcode = '22023';
  end if;

  select * into v_decision from public.jev_lead_decisions where id = p_decision_id for update;
  if not found then
    raise exception 'DECISION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_decision.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select p.outreach_dispo into v_property
  from public.properties p
  where p.id = v_decision.property_id and p.org_id = v_decision.org_id;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_property.outreach_dispo is distinct from p_corrected_outcome then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  update public.jev_lead_decisions
  set status = 'corrected',
      resolved_outcome = p_corrected_outcome,
      resolved_at = now(),
      resolved_by = v_actor,
      resolution_reason = nullif(btrim(p_reason), ''),
      human_reviewed_at = coalesce(human_reviewed_at, now()),
      human_reviewed_by = coalesce(human_reviewed_by, v_actor)
  where id = p_decision_id;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload
  ) values (
    v_decision.org_id, v_decision.property_id, 'user', v_actor,
    'jev_lead_decision_corrected',
    jsonb_build_object(
      'decision_id', v_decision.id,
      'proposed_outcome', v_decision.proposed_outcome,
      'previous_resolved_outcome', v_decision.resolved_outcome,
      'corrected_outcome', p_corrected_outcome,
      'reason', p_reason,
      'applied_via', 'setOutreachDispo'
    )
  );

  return jsonb_build_object(
    'status', 'corrected', 'decisionId', v_decision.id,
    'resolvedOutcome', p_corrected_outcome
  );
end;
$$;

revoke all on function public.fn_record_jev_lead_decision_correction(uuid, text, text)
  from public, anon, service_role;
grant execute on function public.fn_record_jev_lead_decision_correction(uuid, text, text) to authenticated;

commit;
