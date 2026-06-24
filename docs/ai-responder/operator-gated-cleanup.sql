-- Sandra AI responder cleanup prep
-- PREVIEW-FIRST. OPERATOR-GATED. DO NOT AUTO-RUN.
--
-- Purpose:
--   Collapse historical needs_human_attention rows that the new responder
--   would now auto-close or honor as opt-outs.
--
-- Hard rule:
--   These statements are SQL SHAPES ONLY. Do not run any UPDATE until the
--   operator has reviewed the snapshot + previews and explicitly approved
--   Gate 4 cleanup.
--
-- Guardrails:
--   Never auto-touch assigned rows, non-prospect rows, follow-up rows, or
--   human re-engage dispositions (nurture/callback_requested).
--   Use coalesce(outreach_dispo, ...) so existing dispositions are not
--   overwritten.

begin;

-- S0. Reversible snapshot: export this result before any update.
-- Save all columns shown here; updated_at is clobbered by cleanup updates.
select
  id,
  needs_human_attention,
  outreach_dispo,
  last_ai_escalation_reason,
  assigned_user_id,
  updated_at
from properties
where needs_human_attention = true
order by updated_at desc, id;

-- Shared protected-row predicate for previews/updates:
--   assigned_user_id is null
--   status = 'prospect'
--   follow_up_at is null
--   outreach_dispo is null or not in ('nurture', 'callback_requested')

-- A1 PREVIEW: wrong-number rows that would become property-level wrong_number.
select
  id,
  address,
  status,
  outreach_dispo,
  last_ai_escalation_reason,
  assigned_user_id,
  follow_up_at,
  updated_at
from properties
where needs_human_attention = true
  and assigned_user_id is null
  and status = 'prospect'
  and follow_up_at is null
  and coalesce(outreach_dispo, '') not in ('nurture', 'callback_requested')
  and last_ai_escalation_reason ilike 'model:wrong_number%';

-- A2 PREVIEW: not-selling / hostile / frustrated / non-serious rows that
-- would become not_interested unless promoted to DNC by the B1 preview.
select
  id,
  address,
  status,
  outreach_dispo,
  last_ai_escalation_reason,
  assigned_user_id,
  follow_up_at,
  updated_at
from properties
where needs_human_attention = true
  and assigned_user_id is null
  and status = 'prospect'
  and follow_up_at is null
  and coalesce(outreach_dispo, '') not in ('nurture', 'callback_requested')
  and (
    last_ai_escalation_reason ilike 'model:not_selling%'
    or last_ai_escalation_reason ilike 'model:not_interested%'
    or last_ai_escalation_reason ilike 'model:hostile%'
    or last_ai_escalation_reason ilike 'model:frustrated%'
    or last_ai_escalation_reason ilike 'model:non_serious%'
    or last_ai_escalation_reason ilike 'model:deescalate_close%'
  );

-- B1 PREVIEW: TCPA/DNC promotion rows. These must become dnc, not
-- not_interested, because the text contains a stop/removal/threat token.
select
  id,
  address,
  status,
  outreach_dispo,
  last_ai_escalation_reason,
  assigned_user_id,
  follow_up_at,
  updated_at
from properties
where needs_human_attention = true
  and assigned_user_id is null
  and status = 'prospect'
  and follow_up_at is null
  and coalesce(outreach_dispo, '') not in ('nurture', 'callback_requested')
  and (
    last_ai_escalation_reason ilike '%demand to stop%'
    or last_ai_escalation_reason ilike '%lose this number%'
    or last_ai_escalation_reason ilike '%never contact%'
    or last_ai_escalation_reason ilike '%violent%'
  );

-- OPT-OUT HONOR SHAPE: do not do this as a bare SQL update.
-- For model:opt_out and natural-language removal rows, use application code
-- that calls the same helper as the inbound STOP path:
--
--   applyPhoneLevelOptOut(serviceRoleClient, {
--     contactId,
--     fromPhone,
--     source: 'ai_responder_cleanup',
--     sourceDetail: { propertyId, reason: last_ai_escalation_reason },
--     occurredAt: approvedCleanupTimestamp,
--     providerId: 'ai_responder_cleanup',
--     surface: 'stop',
--     idempotencyKey: `ai-responder-cleanup:${propertyId}:${contactId}`,
--   })
--
-- Then, and only then, clear the human flag and set:
--   outreach_dispo = coalesce(outreach_dispo, 'opted_out')

-- DNC PROMOTION UPDATE SHAPE. OPERATOR-GATED: run only after B1 preview sign-off.
-- Review this shape, then copy into a separately approved execution script:
-- update properties
-- set
--   outreach_dispo = coalesce(outreach_dispo, 'dnc'),
--   needs_human_attention = false,
--   updated_at = now()
-- where needs_human_attention = true
--   and assigned_user_id is null
--   and status = 'prospect'
--   and follow_up_at is null
--   and coalesce(outreach_dispo, '') not in ('nurture', 'callback_requested')
--   and (
--     last_ai_escalation_reason ilike '%demand to stop%'
--     or last_ai_escalation_reason ilike '%lose this number%'
--     or last_ai_escalation_reason ilike '%never contact%'
--     or last_ai_escalation_reason ilike '%violent%'
--   );

-- U1 UPDATE SHAPE. OPERATOR-GATED: historical wrong-number rows become
-- property-level wrong_number only. The old rows cannot prove phone-level
-- wrongness reliably.
-- Review this shape, then copy into a separately approved execution script:
-- update properties
-- set
--   outreach_dispo = coalesce(outreach_dispo, 'wrong_number'),
--   needs_human_attention = false,
--   updated_at = now()
-- where needs_human_attention = true
--   and assigned_user_id is null
--   and status = 'prospect'
--   and follow_up_at is null
--   and coalesce(outreach_dispo, '') not in ('nurture', 'callback_requested')
--   and last_ai_escalation_reason ilike 'model:wrong_number%';

-- U2 UPDATE SHAPE. OPERATOR-GATED: dead-end non-seller rows become
-- not_interested (re-textable), except rows promoted to DNC above.
-- Review this shape, then copy into a separately approved execution script:
-- update properties
-- set
--   outreach_dispo = coalesce(outreach_dispo, 'not_interested'),
--   needs_human_attention = false,
--   updated_at = now()
-- where needs_human_attention = true
--   and assigned_user_id is null
--   and status = 'prospect'
--   and follow_up_at is null
--   and coalesce(outreach_dispo, '') not in ('nurture', 'callback_requested')
--   and coalesce(outreach_dispo, '') <> 'dnc'
--   and (
--     last_ai_escalation_reason ilike 'model:not_selling%'
--     or last_ai_escalation_reason ilike 'model:not_interested%'
--     or last_ai_escalation_reason ilike 'model:hostile%'
--     or last_ai_escalation_reason ilike 'model:frustrated%'
--     or last_ai_escalation_reason ilike 'model:non_serious%'
--     or last_ai_escalation_reason ilike 'model:deescalate_close%'
--   );

-- Residual review preview after the operator-gated updates.
select
  id,
  address,
  status,
  outreach_dispo,
  last_ai_escalation_reason,
  assigned_user_id,
  follow_up_at,
  updated_at
from properties
where needs_human_attention = true
order by updated_at desc, id;

rollback;
