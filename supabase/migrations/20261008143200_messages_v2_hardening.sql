-- 20261008143200_messages_v2_hardening.sql
-- Messages v2 fix round 2 (Astra review). Four independent changes:
--
-- 1. jev_outcome_thresholds.automation_enabled: an explicit per-outcome
--    on/off switch. A numeric cutoff cannot be an off switch (confidence 1.0
--    clears any cutoff). Seeded to PRESERVE production behaviour: origin/main
--    auto-applied not_interested / wrong_number / nurture / opted_out in
--    automatic mode and ALWAYS escalated new_lead to a human, so those four
--    seed true and new_lead seeds false. No business rule is added.
-- 2. ai_responder_configs.outbound_mode ('send' | 'hold'): rollback switch to
--    draft-only. Default 'send' = what production does today.
-- 3. ai_reply_drafts: held AI replies (outbound_mode='hold' or
--    AI_RESPONDER_LLM_AUTOSEND=0). Select for owner||acquisitions; insert
--    service_role only.
-- 4. Access parity (D7 = owner || acquisitions): jev_lead_decisions SELECT and
--    the decision confirm/correct RPCs move from "any active member" to
--    pipeline_runs_can_read(org_id). Also re-states the pipeline_runs policies
--    as (select pipeline_runs_can_read(org_id)) so the planner caches per org,
--    and adds a partial index for the stale-run sweep.
--
-- Conversation-level claim index (finding 3) deliberately NOT added: a
-- partial unique index cannot reference lease expiry (now() is not
-- immutable), so an abandoned 'processing' row would lock a conversation
-- forever; and rejecting the newer inbound's claim while the older one is in
-- flight would leave NOBODY replying (the older run is superseded at the
-- pre-send check by the newer inbound). The pre-send re-check in
-- sendResponderMessage is the chokepoint instead.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. automation_enabled
-- ---------------------------------------------------------------------------
alter table public.jev_outcome_thresholds
  add column if not exists automation_enabled boolean not null default false;
comment on column public.jev_outcome_thresholds.automation_enabled is
  'Explicit per-outcome switch. false = always held for a human regardless of confidence. Seeded true for not_interested/wrong_number/nurture/opted_out and false for new_lead to preserve pre-Messages-v2 production behaviour.';

update public.jev_outcome_thresholds
set automation_enabled = true
where outcome in ('not_interested', 'wrong_number', 'nurture', 'opted_out')
  and automation_enabled = false
  and updated_by is null
  and version = 1;
-- Rows already edited by a human (version > 1 or updated_by set) are the
-- org's own choice; they get the same preserving default (true) because the
-- switch did not exist when they were edited.
update public.jev_outcome_thresholds
set automation_enabled = true
where outcome in ('not_interested', 'wrong_number', 'nurture', 'opted_out')
  and automation_enabled = false;

alter table public.jev_outcome_threshold_history
  add column if not exists previous_automation_enabled boolean,
  add column if not exists new_automation_enabled boolean;
update public.jev_outcome_threshold_history
set new_automation_enabled = (outcome <> 'new_lead')
where new_automation_enabled is null;
alter table public.jev_outcome_threshold_history
  alter column new_automation_enabled set not null;

drop function if exists public.fn_set_jev_outcome_threshold(uuid, text, numeric, integer, uuid);

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
  v_new_automation := coalesce(p_automation_enabled, v_previous_automation, p_outcome <> 'new_lead');
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

-- ---------------------------------------------------------------------------
-- 2. ai_responder_configs.outbound_mode (owner-only write via existing RLS)
-- ---------------------------------------------------------------------------
alter table public.ai_responder_configs
  add column if not exists outbound_mode text not null default 'send';
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_responder_configs_outbound_mode_check'
  ) then
    alter table public.ai_responder_configs
      add constraint ai_responder_configs_outbound_mode_check
      check (outbound_mode in ('send', 'hold'));
  end if;
end $$;
comment on column public.ai_responder_configs.outbound_mode is
  'send (default, today''s behaviour) or hold (draft-only: AI replies are stored in ai_reply_drafts instead of sent). Env AI_RESPONDER_OUTBOUND_MODE overrides when set.';

-- ---------------------------------------------------------------------------
-- 3. ai_reply_drafts
-- ---------------------------------------------------------------------------
create table if not exists public.ai_reply_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid references public.pipeline_runs(id) on delete set null,
  conversation_id uuid,
  property_id uuid references public.properties(id) on delete cascade,
  inbound_message_id uuid references public.messages(id) on delete cascade,
  body text not null,
  source text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  constraint ai_reply_drafts_source_check
    check (source in ('approved_template', 'llm', 'human')),
  constraint ai_reply_drafts_status_check
    check (status in ('pending', 'sent', 'discarded'))
);
create index if not exists idx_ai_reply_drafts_org_status
  on public.ai_reply_drafts (org_id, status, created_at desc);
create index if not exists idx_ai_reply_drafts_inbound
  on public.ai_reply_drafts (inbound_message_id);

alter table public.ai_reply_drafts enable row level security;
drop policy if exists ai_reply_drafts_org_select on public.ai_reply_drafts;
create policy ai_reply_drafts_org_select on public.ai_reply_drafts
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and (select public.pipeline_runs_can_read(org_id))
  );

revoke all on table public.ai_reply_drafts
  from public, anon, authenticated, service_role;
grant select on table public.ai_reply_drafts to authenticated;
grant select, insert, update on table public.ai_reply_drafts to service_role;

-- ---------------------------------------------------------------------------
-- 4. Access parity
-- ---------------------------------------------------------------------------
drop policy if exists jev_lead_decisions_org_select on public.jev_lead_decisions;
create policy jev_lead_decisions_org_select on public.jev_lead_decisions
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and (select public.pipeline_runs_can_read(org_id))
  );

drop policy if exists pipeline_runs_org_select on public.pipeline_runs;
create policy pipeline_runs_org_select on public.pipeline_runs
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and (select public.pipeline_runs_can_read(org_id))
  );
drop policy if exists pipeline_run_steps_org_select on public.pipeline_run_steps;
create policy pipeline_run_steps_org_select on public.pipeline_run_steps
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and (select public.pipeline_runs_can_read(org_id))
  );

create index if not exists idx_pipeline_runs_running_started
  on public.pipeline_runs (started_at)
  where status = 'running';

-- The decision RPCs are SECURITY DEFINER and ran the any-active-member check.
-- Re-state exactly that check as AND pipeline_runs_can_read(org) in the
-- CURRENT definition of each user-callable decision RPC (CREATE OR REPLACE
-- keeps grants). Fails the migration loudly if a function is missing or its
-- check was not found, so a silent no-op is impossible.
do $$
declare
  v_fn record;
  v_def text;
  v_new text;
  v_old constant text := 'if not public.hugo_has_active_org_access(v_decision.org_id) then';
  v_repl constant text :=
    'if not (public.hugo_has_active_org_access(v_decision.org_id) and public.pipeline_runs_can_read(v_decision.org_id)) then';
begin
  for v_fn in
    select p.oid, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'fn_confirm_jev_lead_decision',
        'fn_correct_jev_lead_decision',
        'fn_apply_and_record_jev_lead_decision_correction',
        'fn_mark_jev_lead_decision_reviewed',
        'fn_begin_jev_lead_decision_correction',
        'fn_record_jev_lead_decision_correction'
      )
  loop
    v_def := pg_get_functiondef(v_fn.oid);
    v_new := replace(v_def, v_old, v_repl);
    if v_new = v_def then
      raise exception 'access-parity patch found no check in %', v_fn.proname;
    end if;
    execute v_new;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Latest run per property (replaces ~600 limit-1 queries per page load).
-- SECURITY INVOKER: RLS on pipeline_runs applies to the caller.
-- ---------------------------------------------------------------------------
create or replace function public.pipeline_runs_latest_for_properties(
  p_org_id uuid,
  p_property_ids uuid[]
)
returns setof public.pipeline_runs
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select distinct on (r.property_id) r.*
  from public.pipeline_runs r
  where r.org_id = p_org_id
    and r.property_id = any(p_property_ids)
  order by r.property_id, r.started_at desc, r.id desc;
$$;

revoke all on function public.pipeline_runs_latest_for_properties(uuid, uuid[])
  from public, anon;
grant execute on function public.pipeline_runs_latest_for_properties(uuid, uuid[])
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- reset_tenant_tables: truncate ai_reply_drafts, reseed automation_enabled.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.reset_tenant_tables()'::regprocedure);
  v_new := replace(v_def, E'    public.jev_lead_decisions,', E'    public.ai_reply_drafts,\n    public.jev_lead_decisions,');
  if v_new = v_def then raise exception 'reset_tenant_tables truncate patch not applied'; end if;
  v_def := v_new;
  v_new := replace(v_def, '(org_id, outcome, min_confidence, version, updated_by)',
    '(org_id, outcome, min_confidence, version, updated_by, automation_enabled)');
  if v_new = v_def then raise exception 'reset_tenant_tables column patch not applied'; end if;
  v_def := v_new;
  v_new := replace(v_def, 'select o.id, v.outcome, v.min_confidence, 1, null',
    'select o.id, v.outcome, v.min_confidence, 1, null, (v.outcome <> ''new_lead'')');
  if v_new = v_def then raise exception 'reset_tenant_tables seed patch not applied'; end if;
  execute v_new;
end $$;

commit;
