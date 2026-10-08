-- 20261008300000_jev_opted_out_human_only.sql
-- Jarrad (2026-10-07, verbatim): "I don't want you making any DNC decisions.
-- I don't want Jev making any DNC decisions."
--
-- Server-side hard rule: jev_outcome_thresholds.automation_enabled can never
-- be true for opted_out (dnc is not a thresholdable outcome at all).
--   1. Force any row still true to false (production was already flipped by
--      hand; this makes every other environment match) and write a history
--      row so the change is auditable.
--   2. CHECK constraint so no writer can set it back.
--   3. fn_set_jev_outcome_threshold refuses p_automation_enabled = true for
--      opted_out (HUMAN_ONLY_OUTCOME) and never defaults/keeps it on.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

with flipped as (
  update public.jev_outcome_thresholds t
  set automation_enabled = false,
      version = t.version + 1,
      updated_at = now()
  where t.outcome = 'opted_out' and t.automation_enabled = true
  returning t.id, t.org_id, t.min_confidence, t.version
)
insert into public.jev_outcome_threshold_history (
  threshold_id, org_id, outcome, previous_min_confidence, new_min_confidence,
  previous_automation_enabled, new_automation_enabled, version
)
select id, org_id, 'opted_out', min_confidence, min_confidence, true, false, version
from flipped;

alter table public.jev_outcome_thresholds
  drop constraint if exists jev_outcome_thresholds_opted_out_human_only;
alter table public.jev_outcome_thresholds
  add constraint jev_outcome_thresholds_opted_out_human_only
  check (outcome <> 'opted_out' or automation_enabled = false);

create or replace function public.fn_set_jev_outcome_threshold(
  p_org_id uuid,
  p_outcome text,
  p_min_confidence numeric,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_automation_enabled boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_threshold_id uuid;
  v_current_version integer;
  v_previous_confidence numeric(4,3);
  v_previous_automation boolean;
  v_new_automation boolean;
  v_new_version integer;
  v_existing_history public.jev_outcome_threshold_history%rowtype;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_org_id is null or p_outcome is null or p_min_confidence is null
     or p_expected_version is null or p_expected_version < 0
     or p_idempotency_key is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if p_outcome not in ('new_lead', 'wrong_number', 'not_interested', 'nurture', 'opted_out') then
    raise exception 'INVALID_OUTCOME' using errcode = '22023';
  end if;
  if p_min_confidence < 0 or p_min_confidence > 1 then
    raise exception 'INVALID_CONFIDENCE' using errcode = '22023';
  end if;
  p_min_confidence := round(p_min_confidence, 3);
  -- HARD RULE (Jarrad, 2026-10-07: "I don't want Jev making any DNC
  -- decisions."): opted_out can never be automated, whatever the caller asks.
  if p_outcome = 'opted_out' and p_automation_enabled is true then
    raise exception 'HUMAN_ONLY_OUTCOME' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.memberships m
    where m.user_id = v_actor
      and m.org_id = p_org_id
      and m.role = 'owner'
      and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    format('jev-outcome-threshold:%s:%s', p_org_id, p_outcome), 0
  ));

  select * into v_existing_history
  from public.jev_outcome_threshold_history h
  where h.org_id = p_org_id
    and h.outcome = p_outcome
    and h.idempotency_key = p_idempotency_key;
  if found then
    if v_existing_history.new_min_confidence is distinct from p_min_confidence
       or (p_automation_enabled is not null
           and v_existing_history.new_automation_enabled is distinct from p_automation_enabled) then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '40001';
    end if;
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'orgId', p_org_id,
      'outcome', p_outcome,
      'minConfidence', v_existing_history.new_min_confidence,
      'automationEnabled', v_existing_history.new_automation_enabled,
      'version', v_existing_history.version
    );
  end if;

  select id, version, min_confidence, automation_enabled
  into v_threshold_id, v_current_version, v_previous_confidence, v_previous_automation
  from public.jev_outcome_thresholds
  where org_id = p_org_id and outcome = p_outcome
  for update;

  if not found then
    v_current_version := 0;
    v_previous_confidence := null;
    v_previous_automation := null;
  end if;

  if v_current_version is distinct from p_expected_version then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  -- null = leave unchanged (or, for a brand-new row, the production-
  -- preserving default: on for everything except new_lead).
  v_new_automation := coalesce(p_automation_enabled, v_previous_automation, p_outcome not in ('new_lead', 'opted_out'));
  if p_outcome = 'opted_out' then
    v_new_automation := false;
  end if;
  v_new_version := v_current_version + 1;

  if v_threshold_id is null then
    insert into public.jev_outcome_thresholds (
      org_id, outcome, min_confidence, automation_enabled, version, updated_at, updated_by
    ) values (
      p_org_id, p_outcome, p_min_confidence, v_new_automation, v_new_version, statement_timestamp(), v_actor
    )
    returning id into v_threshold_id;
  else
    update public.jev_outcome_thresholds
    set min_confidence = p_min_confidence,
        automation_enabled = v_new_automation,
        version = v_new_version,
        updated_at = statement_timestamp(),
        updated_by = v_actor
    where id = v_threshold_id;
  end if;

  insert into public.jev_outcome_threshold_history (
    threshold_id, org_id, outcome, previous_min_confidence,
    new_min_confidence, previous_automation_enabled, new_automation_enabled,
    version, changed_by, idempotency_key
  ) values (
    v_threshold_id, p_org_id, p_outcome, v_previous_confidence,
    p_min_confidence, v_previous_automation, v_new_automation,
    v_new_version, v_actor, p_idempotency_key
  );

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'orgId', p_org_id,
    'outcome', p_outcome,
    'minConfidence', p_min_confidence,
    'automationEnabled', v_new_automation,
    'version', v_new_version
  );
end;
$$;

revoke all on function public.fn_set_jev_outcome_threshold(uuid, text, numeric, integer, uuid, boolean)
  from public, anon, service_role;
grant execute on function public.fn_set_jev_outcome_threshold(uuid, text, numeric, integer, uuid, boolean)
  to authenticated;

commit;
