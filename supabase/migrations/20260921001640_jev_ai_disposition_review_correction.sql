-- Adds human-correction capability to ai_disposition_reviews (20260827110000)
-- WITHOUT touching its existing status/resolution CHECK constraints or the
-- semantics of pending/confirmed/superseded/auto_accepted — those stay
-- exactly as already hardened. A correction is recorded in new, purely
-- additive columns instead, so `disposition` continues to mean "what Jev
-- originally proposed" and a new `corrected_disposition` means "what a
-- human later decided was actually correct", with its own actor/time/
-- reason — satisfying "a previously applied system decision can be
-- corrected without being mistaken for intervening human work."
--
-- Correction targets are restricted to {wrong_number, not_interested,
-- nurture} — same restriction and same reason as
-- fn_correct_jev_lead_decision (20260920235450_jev_lead_decisions.sql):
-- dnc/opted_out need a TCPA suppression side effect only the existing
-- authenticated setOutreachDispo action performs correctly, and new_lead
-- promotion is jev_lead_decisions' domain, not this table's.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.ai_disposition_reviews
  add column if not exists corrected_disposition text,
  add column if not exists corrected_at timestamptz,
  add column if not exists corrected_by uuid references auth.users(id),
  add column if not exists correction_reason text;

alter table public.ai_disposition_reviews
  add constraint ai_disposition_reviews_corrected_disposition_check
  check (corrected_disposition is null or corrected_disposition in
    ('wrong_number', 'not_interested', 'nurture'));

alter table public.ai_disposition_reviews
  add constraint ai_disposition_reviews_correction_tuple_check
  check (
    (corrected_disposition is null and corrected_at is null and corrected_by is null)
    or
    (corrected_disposition is not null and corrected_at is not null and corrected_by is not null)
  );

comment on column public.ai_disposition_reviews.corrected_disposition is
  'What a human later decided was actually correct, distinct from disposition (Jev''s original proposal). Written only by fn_correct_ai_disposition_review.';

-- ----------------------------------------------------------------------------
-- fn_correct_ai_disposition_review — authenticated, any active org member.
-- Re-validates the property against whatever this review's most recent
-- resolution actually wrote (the latest correction if any, else the
-- original disposition — but only if that write already landed;
-- dnc's Option B rows may not have written outreach_dispo at all yet).
-- Applies the correction directly to properties.outreach_dispo, honoring
-- the same terminal-priority ordering fn_apply_ai_disposition_with_review
-- uses so a correction never downgrades a more specific state that
-- arrived through a separate path in the meantime. Never touches
-- consent_events/suppression — "no suppression removal from a positive
-- correction."
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
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_corrected_disposition not in ('wrong_number', 'not_interested', 'nurture') then
    raise exception 'INVALID_CORRECTION_TARGET' using errcode = '22023';
  end if;

  select * into v_review
  from public.ai_disposition_reviews
  where id = p_review_id;
  if not found then
    raise exception 'REVIEW_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_review.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_review.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  select p.outreach_dispo, p.is_dnc_locked, p.needs_human_attention
  into v_property
  from public.properties p
  where p.id = v_review.property_id and p.org_id = v_review.org_id
  for update;
  if not found then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_review
  from public.ai_disposition_reviews
  where id = p_review_id
  for update;
  if v_review.status = 'superseded' then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  -- What did this review's most recent resolution actually write?
  -- corrected_disposition if it's been corrected before; else disposition
  -- itself, but only if that write already landed (dispo_applied=true —
  -- always true except an unconfirmed dnc Option B row).
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
    -- Nothing written yet by this review (unconfirmed dnc proposal) —
    -- outreach_dispo must still be whatever it was before Jev's
    -- proposal, i.e. untouched by anything else since.
    if v_property.outreach_dispo is not null then
      raise exception 'STALE_STATE' using errcode = '40001';
    end if;
  end if;

  if v_property.outreach_dispo is distinct from p_corrected_disposition
     and v_property.outreach_dispo in ('opted_out', 'dnc', 'bad_number', 'callback_requested', 'booked_appointment')
  then
    -- Unlike fn_apply_ai_disposition_with_review's severity ordering
    -- (which guards an AUTOMATED write from silently downgrading a case
    -- a human may have already escalated), a human correction has no
    -- such ordering among the three allowed targets themselves — the
    -- human reviewing this IS the authority making the call, and
    -- wrong_number/not_interested/nurture are lateral alternatives, not
    -- a severity ladder. Only block writing over something outside the
    -- allowed target set entirely (dnc/opted_out/etc — already more
    -- serious or side-effect-bearing states this RPC must never touch).
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  -- Astra-pattern ordering (mirrors fn_confirm_ai_disposition_review's
  -- unapplied-dnc branch, 20260920120000_sms_classification_runs.sql):
  -- resolve THIS review row FIRST, while it may still be 'pending', so
  -- the existing trg_properties_supersede_ai_disposition_reviews trigger
  -- — which fires after the properties.outreach_dispo update below and
  -- marks every `pending` review for this property as superseded — no
  -- longer matches this row by the time it fires. A pending row that
  -- gets corrected is a resolved review (a human just decided the real
  -- outcome), not a superseded one.
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
    where id = v_review.property_id and org_id = v_review.org_id;
  end if;

  -- No source_type/source_id: a review can be corrected more than once,
  -- same reasoning as jev_lead_decisions' correction event.
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

revoke all on function public.fn_correct_ai_disposition_review(uuid, text, text)
  from public, anon, service_role;
grant execute on function public.fn_correct_ai_disposition_review(uuid, text, text) to authenticated;

commit;
