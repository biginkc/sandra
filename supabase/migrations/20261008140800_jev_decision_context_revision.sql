-- Root review of f271492e (jev-root-cas-review.md, 2026-09-20):
-- f271492e's atomic RPCs fixed the split-HTTP-transaction TOCTOU gap, but
-- their compare-and-set only inspects the ONE column each correction
-- target cares about (outreach_dispo, or status+is_dnc_locked). That
-- misses every OTHER way a decision's context can go stale:
--   - promotion (new_lead): another writer changes outreach_dispo to
--     nurture/not_interested while status stays 'prospect' — invisible
--     to a status-only check, still promotes over that newer decision.
--   - suppression (opted_out/dnc): another writer advances status,
--     changes the linked contact, books an appointment, or a NEWER
--     inbound/outbound arrives — none of which touch outreach_dispo —
--     invisible to a dispo-only check, stale correction still applies.
--   - same-value human writes (ABA): outreach_dispo goes X -> Y -> X.
--     Value equality can never see this; the exact-repeat check from
--     f271492e checked outcome equality, which is the SAME blind spot.
--   - the original direct-SQL correction RPCs (fn_correct_*,
--     fn_confirm_*) have the identical narrow-column blind spot — they
--     were never audited for this, despite an f271492e comment claiming
--     they "always were atomic, never had a race" (true for the
--     split-transaction bug; unproven, and now shown false, for this
--     staleness-detection gap).
--
-- Fix: a durable, monotonic decision_context_revision on `properties`,
-- captured onto `ai_disposition_reviews`/`jev_lead_decisions` at
-- creation (a BEFORE INSERT trigger — every current and future creation
-- path gets this for free, no per-RPC plumbing) and re-synced onto that
-- same row by every one of ITS OWN successful corrections/confirmations.
-- Every mutation branch (both atomic-apply RPCs, both direct-SQL
-- fn_correct_* RPCs, and both fn_confirm_* RPCs — "all mutation branches
-- and manual confirmation need same contract") compares the property's
-- CURRENT revision against the value this specific row last recorded,
-- BEFORE touching anything. A mismatch means SOMETHING decision-relevant
-- happened since this row's own last known-good state — a genuinely
-- different signal than "does the current column value happen to equal
-- what I'm about to write", which same-value writes and unrelated actors
-- can both spoof.
--
-- The revision itself is bumped two ways, deliberately NOT by a fragile
-- timestamp:
--   1. A BEFORE UPDATE OF (outreach_dispo, status, homeowner_contact_id,
--      qualified_at) trigger on `properties`. Postgres fires a
--      `... OF column_list` trigger whenever the UPDATE statement's SET
--      clause TARGETS one of those columns — regardless of whether the
--      value actually changes — so `setOutreachDispo` writing
--      outreach_dispo to its OWN current value (a same-value human
--      re-affirmation) still bumps the revision. This is what closes the
--      ABA gap, and it applies uniformly to EVERY existing and future
--      writer of these columns (setOutreachDispo, qualifyProperty, the
--      correction RPCs themselves, fn_apply_ai_disposition_with_review,
--      etc.) with zero changes to any of that TS/SQL code. Deliberately
--      excludes needs_human_attention/updated_at — those churn on every
--      escalation and would invalidate pending decisions constantly for
--      reasons unrelated to the actual decision outcome.
--   2. Explicit AFTER INSERT triggers on `messages` (new inbound SMS)
--      and `tasks` (a booked appointment) — "newer thread activity" and
--      "appointment after decision" are not properties writes at all,
--      so the properties-level trigger can't see them.
--
-- Every successful correction/confirmation write re-syncs its own
-- row's decision_context_revision to the property's new value
-- (`returning ... decision_context_revision into ...`), so a genuine
-- retry of that SAME row's SAME already-applied outcome sees a matching
-- revision and is reported as an explicit, distinct "already_corrected"/
-- "already_confirmed" replay — never re-writing, never duplicating the
-- audit row — while anything ELSE that happened since (even a same-
-- value write, even on an unrelated column this table doesn't track by
-- value) is caught as a real conflict.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.properties
  add column decision_context_revision bigint not null default 0;

alter table public.ai_disposition_reviews
  add column decision_context_revision bigint not null default 0;

alter table public.jev_lead_decisions
  add column decision_context_revision bigint not null default 0;

-- ----------------------------------------------------------------------------
-- Capture-at-creation: every INSERT into either decision table snapshots
-- the property's CURRENT revision. Generic — works for every existing
-- and future creation path (fn_propose_deferred_ai_disposition_review,
-- fn_propose_jev_lead_decision, fn_auto_apply_jev_lead_decision,
-- fn_promote_classifier_event_to_decision, fn_apply_ai_disposition_with_review,
-- fn_propose_ai_dnc_suppression_review, ...) without touching any of them.
-- ----------------------------------------------------------------------------
create or replace function public.jev_capture_decision_context_revision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select p.decision_context_revision into new.decision_context_revision
  from public.properties p
  where p.id = new.property_id;
  return new;
end;
$$;

drop trigger if exists trg_ai_disposition_reviews_capture_revision on public.ai_disposition_reviews;
create trigger trg_ai_disposition_reviews_capture_revision
  before insert on public.ai_disposition_reviews
  for each row execute function public.jev_capture_decision_context_revision();

drop trigger if exists trg_jev_lead_decisions_capture_revision on public.jev_lead_decisions;
create trigger trg_jev_lead_decisions_capture_revision
  before insert on public.jev_lead_decisions
  for each row execute function public.jev_capture_decision_context_revision();

-- ----------------------------------------------------------------------------
-- Bump on any decision-relevant properties write — including same-value
-- ones, which is exactly the point (ABA).
-- ----------------------------------------------------------------------------
create or replace function public.jev_bump_decision_context_revision()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.decision_context_revision := old.decision_context_revision + 1;
  return new;
end;
$$;

drop trigger if exists trg_properties_bump_decision_context_revision on public.properties;
create trigger trg_properties_bump_decision_context_revision
  before update of outreach_dispo, status, homeowner_contact_id, qualified_at
  on public.properties
  for each row execute function public.jev_bump_decision_context_revision();

-- ----------------------------------------------------------------------------
-- Bump on new inbound SMS — "newer thread activity" is not itself a
-- properties write, so the trigger above can't see it.
-- ----------------------------------------------------------------------------
create or replace function public.jev_bump_decision_context_revision_on_inbound()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.direction = 'inbound' and new.channel = 'sms' and new.property_id is not null then
    update public.properties
    set decision_context_revision = decision_context_revision + 1
    where id = new.property_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_messages_bump_decision_context_revision on public.messages;
create trigger trg_messages_bump_decision_context_revision
  after insert on public.messages
  for each row execute function public.jev_bump_decision_context_revision_on_inbound();

-- ----------------------------------------------------------------------------
-- Bump on a booked appointment (public.tasks, type = 'appointment' —
-- fn_book_appointment, 20260814170000_appointment_booking_rpcs.sql).
-- Untouched otherwise: this is a passive observer trigger, not a change
-- to the booking RPC's own logic.
-- ----------------------------------------------------------------------------
create or replace function public.jev_bump_decision_context_revision_on_appointment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.type = 'appointment' and new.related_property_id is not null then
    update public.properties
    set decision_context_revision = decision_context_revision + 1
    where id = new.related_property_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_tasks_bump_decision_context_revision on public.tasks;
create trigger trg_tasks_bump_decision_context_revision
  after insert on public.tasks
  for each row execute function public.jev_bump_decision_context_revision_on_appointment();

-- ----------------------------------------------------------------------------
-- fn_apply_and_record_ai_disposition_review_correction — revision-aware.
-- ----------------------------------------------------------------------------
create or replace function public.fn_apply_and_record_ai_disposition_review_correction(
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
  v_updated_id uuid;
  v_new_revision bigint;
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

  select p.status, p.outreach_dispo, p.is_dnc_locked, p.is_training, p.homeowner_contact_id, p.decision_context_revision
  into v_property
  from public.properties p
  where p.id = v_review.property_id and p.org_id = v_review.org_id
  for update;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_property.is_training then
    raise exception 'Customer actions are unavailable for an internal training lead.' using errcode = '22023';
  end if;

  -- Root review of f271492e (jev-root-cas-review.md, 2026-09-20): the
  -- authoritative staleness gate. A mismatch means something decision-
  -- relevant happened since this review's own last recorded state —
  -- ANY write to outreach_dispo/status/homeowner_contact_id/qualified_at
  -- (even a same-value one), a new inbound, or a new appointment. This
  -- catches everything the narrower column checks below cannot: a
  -- disposition-only race hiding a status change, a status-only race
  -- hiding a dispo change, ABA, and cross-table activity.
  if v_property.decision_context_revision is distinct from v_review.decision_context_revision then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  -- Explicit replay identity ("Replay identity should be explicit, not
  -- mistaken for unrelated human state matching desired value"): this
  -- row's own last correction already achieved exactly this outcome,
  -- and — per the revision check just above — nothing decision-relevant
  -- has happened since. Not a value-equality coincidence with someone
  -- else's unrelated action.
  if v_review.status <> 'pending' and v_review.corrected_disposition = p_corrected_disposition then
    return jsonb_build_object(
      'status', 'already_corrected', 'reviewId', v_review.id,
      'correctedDisposition', p_corrected_disposition
    );
  end if;

  -- trg_properties_supersede_ai_disposition_reviews (an outreach_dispo
  -- write) and fn_propose_deferred_ai_disposition_review's manual
  -- supersede (a NEW proposal superseding an old pending one, which does
  -- NOT itself write outreach_dispo) can both mark this review
  -- 'superseded' without necessarily bumping decision_context_revision —
  -- kept as its own explicit check, not subsumed by the revision gate.
  if v_review.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  -- Defense in depth: the specific column values this review actually
  -- expects, checked in addition to the revision gate above.
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

  -- ------------------------------------------------------------------
  -- Atomic write: the WHERE clause below is the last-instant concurrency
  -- control for anything happening DURING this very function call (the
  -- revision check above already ruled out anything before it started).
  -- ------------------------------------------------------------------
  if p_corrected_disposition = 'new_lead' then
    if v_property.is_dnc_locked then
      raise exception 'DNC_LOCKED: property is permanently read-only' using errcode = '22023';
    end if;
    update public.properties
    set status = 'new_lead', qualified_at = now(), qualified_by = v_actor, updated_at = now()
    where id = v_review.property_id and org_id = v_review.org_id
      and status = 'prospect' and is_dnc_locked = false
    returning id, decision_context_revision into v_updated_id, v_new_revision;
    if v_updated_id is null then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  else
    update public.properties
    set outreach_dispo = p_corrected_disposition, follow_up_at = null, updated_at = now()
    where id = v_review.property_id and org_id = v_review.org_id
      and outreach_dispo is not distinct from v_property.outreach_dispo
    returning id, decision_context_revision into v_updated_id, v_new_revision;
    if v_updated_id is null then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;

    if v_property.homeowner_contact_id is not null then
      begin
        update public.contacts
        set sms_opted_out = true, sms_opted_out_at = now()
        where id = v_property.homeowner_contact_id
          and do_not_contact = false and sms_opted_out = false;
      exception when others then
        -- A 'dnc' write can cascade-lock the linked contact before this
        -- statement runs (reject_locked_property_contact_mutation) —
        -- the contact is ALREADY suppressed by that lock, same tolerance
        -- setOutreachDispo itself already applies for this exact case.
        if sqlerrm not like 'DNC_LOCKED%' then
          raise;
        end if;
      end;
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
      human_reviewed_by = coalesce(human_reviewed_by, v_actor),
      decision_context_revision = v_new_revision
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
        when 'new_lead' then 'qualifyProperty' else 'setOutreachDispo'
      end
    )
  );

  return jsonb_build_object(
    'status', 'corrected', 'reviewId', v_review.id,
    'correctedDisposition', p_corrected_disposition,
    'propertyId', v_review.property_id,
    'homeownerContactId', v_property.homeowner_contact_id
  );
end;
$$;

revoke all on function public.fn_apply_and_record_ai_disposition_review_correction(uuid, text, text)
  from public, anon, service_role;
grant execute on function public.fn_apply_and_record_ai_disposition_review_correction(uuid, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- fn_apply_and_record_jev_lead_decision_correction — revision-aware.
-- ----------------------------------------------------------------------------
create or replace function public.fn_apply_and_record_jev_lead_decision_correction(
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
  v_updated_id uuid;
  v_new_revision bigint;
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

  select p.status, p.outreach_dispo, p.is_dnc_locked, p.is_training, p.homeowner_contact_id, p.decision_context_revision
  into v_property
  from public.properties p
  where p.id = v_decision.property_id and p.org_id = v_decision.org_id
  for update;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_property.is_training then
    raise exception 'Customer actions are unavailable for an internal training lead.' using errcode = '22023';
  end if;

  if v_property.decision_context_revision is distinct from v_decision.decision_context_revision then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  if v_decision.status <> 'pending' and v_decision.resolved_outcome = p_corrected_outcome then
    return jsonb_build_object(
      'status', 'already_corrected', 'decisionId', v_decision.id,
      'resolvedOutcome', p_corrected_outcome
    );
  end if;

  if v_decision.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  if v_decision.status = 'pending' then
    if v_property.status is distinct from 'prospect' or v_property.outreach_dispo is not null then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  elsif v_decision.resolved_outcome = 'new_lead' then
    if v_property.status is distinct from 'new_lead' then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  else
    if v_property.outreach_dispo is distinct from v_decision.resolved_outcome then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  end if;

  update public.properties
  set outreach_dispo = p_corrected_outcome, follow_up_at = null, updated_at = now()
  where id = v_decision.property_id and org_id = v_decision.org_id
    and outreach_dispo is not distinct from v_property.outreach_dispo
  returning id, decision_context_revision into v_updated_id, v_new_revision;
  if v_updated_id is null then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  if v_property.homeowner_contact_id is not null then
    begin
      update public.contacts
      set sms_opted_out = true, sms_opted_out_at = now()
      where id = v_property.homeowner_contact_id
        and do_not_contact = false and sms_opted_out = false;
    exception when others then
      if sqlerrm not like 'DNC_LOCKED%' then
        raise;
      end if;
    end;
  end if;

  update public.jev_lead_decisions
  set status = 'corrected',
      resolved_outcome = p_corrected_outcome,
      resolved_at = now(),
      resolved_by = v_actor,
      resolution_reason = nullif(btrim(p_reason), ''),
      human_reviewed_at = coalesce(human_reviewed_at, now()),
      human_reviewed_by = coalesce(human_reviewed_by, v_actor),
      decision_context_revision = v_new_revision
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
    'resolvedOutcome', p_corrected_outcome,
    'propertyId', v_decision.property_id,
    'homeownerContactId', v_property.homeowner_contact_id
  );
end;
$$;

revoke all on function public.fn_apply_and_record_jev_lead_decision_correction(uuid, text, text)
  from public, anon, service_role;
grant execute on function public.fn_apply_and_record_jev_lead_decision_correction(uuid, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- fn_correct_ai_disposition_review — the direct-SQL wrong_number/
-- not_interested/nurture correction, now revision-aware too. Already
-- single-transaction with a real FOR UPDATE lock (no split-HTTP-request
-- gap), but that lock only protects concurrency DURING this call — it
-- never detected staleness accrued BEFORE this call started, which is
-- exactly what root's finding says was unproven.
-- ----------------------------------------------------------------------------
create or replace function public.fn_correct_ai_disposition_review(
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
  v_expected_dispo text;
  v_new_revision bigint;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_corrected_disposition not in ('wrong_number', 'not_interested', 'nurture') then
    raise exception 'INVALID_CORRECTION_TARGET' using errcode = '22023';
  end if;

  select * into v_review
  from public.ai_disposition_reviews
  where id = p_review_id
  for update;
  if not found then
    raise exception 'REVIEW_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_review.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select p.outreach_dispo, p.is_dnc_locked, p.needs_human_attention, p.decision_context_revision
  into v_property
  from public.properties p
  where p.id = v_review.property_id and p.org_id = v_review.org_id
  for update;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_property.decision_context_revision is distinct from v_review.decision_context_revision then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  if v_review.status <> 'pending' and v_review.corrected_disposition = p_corrected_disposition then
    return jsonb_build_object(
      'status', 'already_corrected', 'reviewId', v_review.id,
      'correctedDisposition', p_corrected_disposition
    );
  end if;

  if v_review.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  v_expected_dispo := case
    when v_review.corrected_disposition is not null then v_review.corrected_disposition
    when v_review.dispo_applied then v_review.disposition
    else null
  end;

  if v_expected_dispo is not null then
    if v_property.outreach_dispo is distinct from v_expected_dispo then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  else
    if v_property.outreach_dispo is not null then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  end if;

  if v_property.outreach_dispo is distinct from p_corrected_disposition
     and v_property.outreach_dispo in ('opted_out', 'dnc', 'bad_number', 'callback_requested', 'booked_appointment')
  then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  update public.ai_disposition_reviews
  set corrected_disposition = p_corrected_disposition,
      corrected_at = now(),
      corrected_by = v_actor,
      correction_reason = nullif(btrim(p_reason), ''),
      dispo_applied = true,
      status = case when status = 'pending' then 'confirmed' else status end,
      resolved_at = case when status = 'pending' then now() else resolved_at end,
      reviewed_by = case when status = 'pending' then v_actor else reviewed_by end
  where id = v_review.id;

  if v_property.outreach_dispo is distinct from p_corrected_disposition then
    update public.properties
    set outreach_dispo = p_corrected_disposition,
        needs_human_attention = false,
        last_ai_escalation_reason = null,
        updated_at = now()
    where id = v_review.property_id and org_id = v_review.org_id
    returning decision_context_revision into v_new_revision;
  else
    v_new_revision := v_property.decision_context_revision;
  end if;

  update public.ai_disposition_reviews
  set decision_context_revision = v_new_revision
  where id = v_review.id;

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
      'reason', p_reason
    )
  );

  return jsonb_build_object(
    'status', 'corrected', 'reviewId', v_review.id,
    'correctedDisposition', p_corrected_disposition
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- fn_correct_jev_lead_decision — same revision-aware treatment for the
-- direct-SQL new_lead/nurture/wrong_number/not_interested correction.
-- ----------------------------------------------------------------------------
create or replace function public.fn_correct_jev_lead_decision(
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
  v_new_revision bigint;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_corrected_outcome not in ('new_lead', 'nurture', 'wrong_number', 'not_interested') then
    raise exception 'INVALID_CORRECTION_TARGET' using errcode = '22023';
  end if;

  select * into v_decision
  from public.jev_lead_decisions
  where id = p_decision_id
  for update;
  if not found then
    raise exception 'DECISION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_decision.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select p.status, p.outreach_dispo, p.is_dnc_locked, p.needs_human_attention, p.decision_context_revision
  into v_property
  from public.properties p
  where p.id = v_decision.property_id and p.org_id = v_decision.org_id
  for update;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_property.decision_context_revision is distinct from v_decision.decision_context_revision then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  if v_decision.status <> 'pending' and v_decision.resolved_outcome = p_corrected_outcome then
    return jsonb_build_object(
      'status', 'already_corrected', 'decisionId', v_decision.id,
      'resolvedOutcome', p_corrected_outcome
    );
  end if;

  if v_decision.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  if v_decision.status = 'pending' then
    if v_property.status is distinct from 'prospect' or v_property.outreach_dispo is not null then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  elsif v_decision.resolved_outcome = 'new_lead' then
    if v_property.status is distinct from 'new_lead' then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  else
    if v_property.outreach_dispo is distinct from v_decision.resolved_outcome then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  end if;

  v_new_revision := v_property.decision_context_revision;

  if p_corrected_outcome = 'new_lead' then
    if v_property.is_dnc_locked then
      raise exception 'DNC_LOCKED' using errcode = '22023';
    end if;
    if v_property.status is distinct from 'prospect' and v_property.status is distinct from 'new_lead' then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
    if v_property.status is distinct from 'new_lead' then
      update public.properties
      set status = 'new_lead', qualified_at = now(), qualified_by = v_actor::text,
          updated_at = now()
      where id = v_decision.property_id and org_id = v_decision.org_id
      returning decision_context_revision into v_new_revision;
    end if;
  else
    if v_property.outreach_dispo is distinct from p_corrected_outcome then
      if v_property.outreach_dispo in ('opted_out', 'dnc', 'bad_number', 'callback_requested', 'booked_appointment') then
        raise exception 'STALE_STATE' using errcode = '40001';
      end if;
      update public.properties
      set outreach_dispo = p_corrected_outcome,
          needs_human_attention = false,
          last_ai_escalation_reason = null,
          updated_at = now()
      where id = v_decision.property_id and org_id = v_decision.org_id
      returning decision_context_revision into v_new_revision;
    end if;
  end if;

  update public.jev_lead_decisions
  set status = 'corrected',
      resolved_outcome = p_corrected_outcome,
      resolved_at = now(),
      resolved_by = v_actor,
      resolution_reason = nullif(btrim(p_reason), ''),
      decision_context_revision = v_new_revision
  where id = v_decision.id;

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
      'reason', p_reason
    )
  );

  return jsonb_build_object(
    'status', 'corrected', 'decisionId', v_decision.id,
    'resolvedOutcome', p_corrected_outcome
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- fn_confirm_ai_disposition_review — "all mutation branches and manual
-- confirmation need same contract." The existing property_outcome_changed
-- supersede check already catches an outreach_dispo mismatch; OR'd here
-- with the revision check so a decision-relevant change that never
-- touched outreach_dispo (a new inbound, a same-value ABA write, a
-- status/contact change) is ALSO caught, not just accepted because the
-- one column it happened to check still matches.
-- ----------------------------------------------------------------------------
create or replace function public.fn_confirm_ai_disposition_review(p_review_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_review public.ai_disposition_reviews%rowtype;
  v_property record;
  v_new_revision bigint;
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

  select p.outreach_dispo, p.decision_context_revision
  into v_property
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

  if not v_review.dispo_applied then
    -- Unapplied proposal (Jev-driven dnc, Option B / a below-threshold
    -- deferred proposal): outreach_dispo was deliberately never written.
    -- A revision mismatch here means something happened since Jev
    -- proposed this — treat exactly like the applied-case supersede path
    -- below rather than blindly confirming and writing over it.
    if v_property.decision_context_revision is distinct from v_review.decision_context_revision
      or v_property.outreach_dispo is not null
    then
      update public.ai_disposition_reviews
      set status = 'superseded',
          resolved_at = now(),
          superseded_reason = 'property_outcome_changed'
      where id = v_review.id;

      insert into public.lead_events (
        org_id, property_id, actor_type, event_type, payload,
        source_type, source_id
      ) values (
        v_review.org_id, v_review.property_id, 'system', 'ai_dispo_review_superseded',
        jsonb_build_object(
          'review_id', v_review.id,
          'proposed_disposition', v_review.disposition,
          'replacement_disposition', v_property.outreach_dispo,
          'reason', 'property_outcome_changed',
          'source_inbound_message_id', v_review.source_inbound_message_id
        ),
        'ai_disposition_reviews.superseded', v_review.id
      )
      on conflict (source_type, source_id) where source_id is not null do nothing;

      return jsonb_build_object('status', 'superseded', 'reviewId', v_review.id);
    end if;

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
      and org_id = v_review.org_id
    returning decision_context_revision into v_new_revision;

    update public.ai_disposition_reviews
    set decision_context_revision = v_new_revision
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

  if v_property.outreach_dispo is distinct from v_review.disposition
    or v_property.decision_context_revision is distinct from v_review.decision_context_revision
  then
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
        'replacement_disposition', v_property.outreach_dispo,
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

-- ----------------------------------------------------------------------------
-- fn_confirm_jev_lead_decision — same treatment: OR the revision check
-- into the existing property_outcome_changed supersede paths.
-- ----------------------------------------------------------------------------
create or replace function public.fn_confirm_jev_lead_decision(p_decision_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_decision public.jev_lead_decisions%rowtype;
  v_property record;
  v_new_revision bigint;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;

  select * into v_decision
  from public.jev_lead_decisions
  where id = p_decision_id;
  if not found then
    raise exception 'DECISION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_decision.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select p.status, p.outreach_dispo, p.is_dnc_locked, p.needs_human_attention, p.decision_context_revision
  into v_property
  from public.properties p
  where p.id = v_decision.property_id and p.org_id = v_decision.org_id
  for update;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_decision
  from public.jev_lead_decisions
  where id = p_decision_id
  for update;

  if v_decision.status <> 'pending' then
    return jsonb_build_object(
      'status', v_decision.status, 'decisionId', v_decision.id,
      'resolvedOutcome', v_decision.resolved_outcome
    );
  end if;

  if v_property.decision_context_revision is distinct from v_decision.decision_context_revision then
    update public.jev_lead_decisions
    set status = 'superseded', resolved_at = now(),
        superseded_reason = 'property_outcome_changed'
    where id = v_decision.id;
    return jsonb_build_object('status', 'superseded', 'decisionId', v_decision.id);
  end if;

  if v_decision.proposed_outcome = 'new_lead' then
    if v_property.is_dnc_locked then
      raise exception 'DNC_LOCKED' using errcode = '22023';
    end if;
    if v_property.status is distinct from 'prospect' then
      update public.jev_lead_decisions
      set status = 'superseded', resolved_at = now(),
          superseded_reason = 'property_outcome_changed'
      where id = v_decision.id;
      return jsonb_build_object('status', 'superseded', 'decisionId', v_decision.id);
    end if;
    update public.properties
    set status = 'new_lead',
        qualified_at = now(),
        qualified_by = v_actor::text,
        updated_at = now()
    where id = v_decision.property_id and org_id = v_decision.org_id
    returning decision_context_revision into v_new_revision;
  else
    -- nurture: must still be unset or already nurture (idempotent replay).
    if v_property.outreach_dispo is not null and v_property.outreach_dispo <> 'nurture' then
      update public.jev_lead_decisions
      set status = 'superseded', resolved_at = now(),
          superseded_reason = 'property_outcome_changed'
      where id = v_decision.id;
      return jsonb_build_object('status', 'superseded', 'decisionId', v_decision.id);
    end if;
    update public.properties
    set outreach_dispo = 'nurture',
        needs_human_attention = false,
        last_ai_escalation_reason = null,
        updated_at = now()
    where id = v_decision.property_id and org_id = v_decision.org_id
    returning decision_context_revision into v_new_revision;
  end if;

  update public.jev_lead_decisions
  set status = 'confirmed',
      resolved_outcome = v_decision.proposed_outcome,
      resolved_at = now(),
      resolved_by = v_actor,
      decision_context_revision = v_new_revision
  where id = v_decision.id;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload,
    source_type, source_id
  ) values (
    v_decision.org_id, v_decision.property_id, 'user', v_actor,
    'jev_lead_decision_confirmed',
    jsonb_build_object('decision_id', v_decision.id, 'outcome', v_decision.proposed_outcome),
    'jev_lead_decisions.confirmed', v_decision.id
  )
  on conflict (source_type, source_id) where source_id is not null do nothing;

  return jsonb_build_object(
    'status', 'confirmed', 'decisionId', v_decision.id,
    'resolvedOutcome', v_decision.proposed_outcome
  );
end;
$$;

commit;
