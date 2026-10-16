-- Root final-review finding (P1 #3, jev-root-final-review.md, 2026-09-20):
-- classifier_event rows (Jev classify failures / unclear / bad_number,
-- read directly from sms_classification_runs) had no actionable human-
-- resolution path — Review Jev showed them read-only in a "failed/held"
-- bucket forever, even though a human might determine the real outcome
-- for that lead. Fixed by letting a human "promote" a classifier_event
-- into a real, pending jev_lead_decisions row — from that point on it is
-- an ordinary Needs-a-decision item, correctable via the EXISTING
-- fn_correct_jev_lead_decision / fn_record_jev_lead_decision_correction
-- RPCs with zero further changes.
--
-- proposed_outcome is widened to also allow 'unclear'/'bad_number' —
-- these are real JevOutcome values (src/lib/sms-classification/types.ts),
-- not fabricated placeholders: 'unclear' also covers an outright classify
-- failure (fallback_reason set, no resolved_outcome at all), since "Jev
-- had literally no signal" and "Jev's own answer was unclear" are the
-- same actionable state from a human's perspective.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.jev_lead_decisions
  drop constraint jev_lead_decisions_proposed_outcome_check;
alter table public.jev_lead_decisions
  add constraint jev_lead_decisions_proposed_outcome_check
  check (proposed_outcome in ('new_lead', 'nurture', 'unclear', 'bad_number'));

create or replace function public.fn_promote_classifier_event_to_decision(
  p_classification_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_run public.sms_classification_runs%rowtype;
  v_existing public.jev_lead_decisions%rowtype;
  v_decision public.jev_lead_decisions%rowtype;
  v_placeholder_outcome text;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;

  select * into v_run
  from public.sms_classification_runs
  where id = p_classification_run_id
  for share;
  if not found then
    raise exception 'CLASSIFICATION_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_run.org_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_run.provider <> 'jev' then
    raise exception 'NOT_A_CLASSIFIER_EVENT' using errcode = '22023';
  end if;
  if v_run.fallback_reason is null
    and (v_run.resolved_outcome is null or v_run.resolved_outcome not in ('unclear', 'bad_number'))
  then
    -- This run produced an actual actionable decision (route/nurture/
    -- new_lead) — it already has its own review/decision row and does
    -- not belong in this promotion path.
    raise exception 'NOT_A_CLASSIFIER_EVENT' using errcode = '22023';
  end if;

  v_placeholder_outcome := coalesce(v_run.resolved_outcome, 'unclear');

  -- Race-safe via jev_lead_decisions' existing unique constraint on
  -- source_inbound_message_id: a concurrent double-promotion of the same
  -- inbound conflicts and this branch re-reads the winner instead.
  insert into public.jev_lead_decisions (
    org_id, property_id, conversation_id, source_inbound_message_id,
    classification_run_id, proposed_outcome, status
  ) values (
    v_run.org_id, v_run.property_id, v_run.conversation_id, v_run.source_inbound_message_id,
    p_classification_run_id, v_placeholder_outcome, 'pending'
  )
  on conflict (source_inbound_message_id) do nothing
  returning * into v_decision;

  if v_decision.id is null then
    select * into v_existing
    from public.jev_lead_decisions
    where source_inbound_message_id = v_run.source_inbound_message_id;
    return jsonb_build_object('status', 'already_promoted', 'decisionId', v_existing.id);
  end if;

  update public.properties
  set needs_human_attention = true, updated_at = now()
  where id = v_run.property_id and org_id = v_run.org_id;

  insert into public.lead_events (org_id, property_id, actor_type, actor_id, event_type, payload)
  values (
    v_run.org_id, v_run.property_id, 'user', v_actor, 'jev_classifier_event_promoted',
    jsonb_build_object(
      'classification_run_id', p_classification_run_id,
      'decision_id', v_decision.id,
      'placeholder_outcome', v_placeholder_outcome,
      'fallback_reason', v_run.fallback_reason
    )
  );

  return jsonb_build_object('status', 'promoted', 'decisionId', v_decision.id);
end;
$$;

revoke all on function public.fn_promote_classifier_event_to_decision(uuid)
  from public, anon, service_role;
grant execute on function public.fn_promote_classifier_event_to_decision(uuid) to authenticated;

commit;
