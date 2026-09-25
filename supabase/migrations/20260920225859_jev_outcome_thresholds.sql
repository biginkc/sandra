-- Editable per-outcome native-confidence thresholds for the Jev automatic
-- classifier. Defaults are provisional operational choices, not claimed
-- accuracy. Threshold edits take effect at the next classification with no
-- deployment (read live from this table by the dispatch bridge) and are
-- never applied retroactively to already-persisted sms_classification_runs.
--
-- dnc and unclear are deliberately absent from the outcome check constraint
-- below — they are always human-gated regardless of any threshold, same as
-- the existing DB-level dnc/auto_accepted block in
-- 20260920120000_sms_classification_runs.sql. Missing/invalid native
-- confidence is handled in application code as human-gated (there is no
-- confidence value to compare against a threshold).
--
-- Authorization model: no direct authenticated INSERT/UPDATE grant on
-- either table (root PR-review finding, 2026-09-20: an earlier draft used
-- the pre-hugo 054_memberships_and_rls_rewrite.sql any-member RLS shape,
-- which let any active-or-inactive member write cutoffs while the app
-- claimed an admin-only gate — a bypassable authorization). Every write
-- instead goes through fn_set_jev_outcome_threshold, a SECURITY DEFINER
-- RPC that captures the actor from auth.uid() itself (never a client-
-- supplied value), requires an owner-role ACTIVE membership (same
-- role/active-status/expiry/deletion shape as
-- fn_set_acquisition_settings in 20260912090000_acquisition_settings.sql),
-- and enforces optimistic-concurrency + idempotency exactly like that
-- function. Reads use hugo_has_active_org_access (20260728150000), the
-- current helper — not the older any-membership-row check.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table public.jev_outcome_thresholds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  outcome text not null,
  min_confidence numeric(4,3) not null,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete restrict,
  constraint jev_outcome_thresholds_outcome_check
    check (outcome in ('new_lead', 'wrong_number', 'not_interested', 'nurture', 'opted_out')),
  constraint jev_outcome_thresholds_confidence_range
    check (min_confidence >= 0 and min_confidence <= 1),
  constraint jev_outcome_thresholds_version_positive
    check (version >= 1),
  constraint jev_outcome_thresholds_org_outcome_unique
    unique (org_id, outcome)
);

comment on table public.jev_outcome_thresholds is
  'Per-org, per-outcome native-confidence cutoff for automatic Jev application. Read live at classification time. dnc/unclear/missing-score are never here — always human-gated. Writable only via fn_set_jev_outcome_threshold.';
comment on column public.jev_outcome_thresholds.min_confidence is
  'Native TypeSafe outcome confidence must be >= this value for the outcome to auto-apply. Provisional operational default, not a claimed accuracy figure.';
comment on column public.jev_outcome_thresholds.updated_by is
  'Set only by fn_set_jev_outcome_threshold from auth.uid() — never a client-supplied value.';

create table public.jev_outcome_threshold_history (
  id uuid primary key default gen_random_uuid(),
  threshold_id uuid references public.jev_outcome_thresholds(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  outcome text not null,
  previous_min_confidence numeric(4,3),
  new_min_confidence numeric(4,3) not null,
  version integer not null,
  changed_by uuid references auth.users(id) on delete restrict,
  changed_at timestamptz not null default now(),
  idempotency_key uuid,
  constraint jev_outcome_threshold_history_version_positive
    check (version >= 1)
);

comment on table public.jev_outcome_threshold_history is
  'Immutable append-only audit trail of every jev_outcome_thresholds change, including the initial creation. Written only by fn_set_jev_outcome_threshold — never updated or deleted.';
comment on column public.jev_outcome_threshold_history.idempotency_key is
  'Caller-supplied replay key. A retried identical request (same org/outcome/key) returns the recorded result instead of writing a duplicate history row.';

create index idx_jev_outcome_threshold_history_org_outcome
  on public.jev_outcome_threshold_history (org_id, outcome, changed_at desc);

-- Replay detection is keyed on (org_id, outcome, idempotency_key), not
-- threshold_id, because the very first write for an org/outcome pair races
-- with row creation — threshold_id does not exist yet when the idempotency
-- check needs to run.
create unique index idx_jev_outcome_threshold_history_idempotency
  on public.jev_outcome_threshold_history (org_id, outcome, idempotency_key)
  where idempotency_key is not null;

alter table public.jev_outcome_thresholds enable row level security;
alter table public.jev_outcome_threshold_history enable row level security;

-- Read access: current active-membership helper (hugo_has_active_org_access),
-- not the older 054_memberships_and_rls_rewrite.sql any-row-in-memberships
-- shape, which does not check access_status/deletion_prepared_at/expiry.
create policy jev_outcome_thresholds_org_select on public.jev_outcome_thresholds
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id));
create policy jev_outcome_threshold_history_org_select on public.jev_outcome_threshold_history
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id));

-- Root PR-review findings (2026-09-20, confirmed with has_table_privilege
-- against an applied local PG17): every role's privileges on both tables
-- must be revoked and re-granted EXPLICITLY, one role at a time, in the
-- same statement group — including service_role, which is NOT covered by
-- `revoke all ... from public, anon, authenticated` and would otherwise
-- keep whatever broad default privilege it has as a superuser-adjacent
-- role in this local/hosted setup (it had implicit INSERT on
-- jev_outcome_thresholds before this fix, contradicting the "read-only"
-- comment below). No authenticated write path at all — every mutation
-- goes through fn_set_jev_outcome_threshold, which performs its own
-- owner-role + active-membership authorization check before writing.
revoke all on table public.jev_outcome_thresholds
  from public, anon, authenticated, service_role;
grant select on table public.jev_outcome_thresholds to authenticated;
-- The classify path runs under service_role (dispatch is invoked from the
-- Dialpad webhook's service-role client) and only ever needs to read the
-- live threshold, never write it.
grant select on table public.jev_outcome_thresholds to service_role;

revoke all on table public.jev_outcome_threshold_history
  from public, anon, authenticated, service_role;
grant select on table public.jev_outcome_threshold_history to authenticated;
-- History is audit-only; service_role has no reason to read or write it
-- directly (dispatch never touches it) — intentionally no grant here.

-- ----------------------------------------------------------------------------
-- fn_set_jev_outcome_threshold — the only writer.
--
-- p_expected_version: 0 means "no row exists yet for this org/outcome"
-- (optimistic-concurrency create). Any other value must match the current
-- row's version exactly or the call fails STALE_STATE, surfacing a visible
-- conflict in the settings UI instead of silently overwriting a concurrent
-- edit.
-- ----------------------------------------------------------------------------
create or replace function public.fn_set_jev_outcome_threshold(
  p_org_id uuid,
  p_outcome text,
  p_min_confidence numeric,
  p_expected_version integer,
  p_idempotency_key uuid
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
  v_new_version integer;
  v_existing_history public.jev_outcome_threshold_history%rowtype;
  v_result jsonb;
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

  -- Root PR-review finding (2026-09-20): normalize BEFORE any comparison
  -- or storage, not just at the column type. The column is numeric(4,3),
  -- so a caller-supplied value with more precision (e.g. 0.9555) would
  -- otherwise be compared against its own future re-round on replay —
  -- the idempotency check below would see the raw 0.9555 not-equal to
  -- the stored, already-rounded 0.956 and wrongly raise
  -- IDEMPOTENCY_CONFLICT on a genuine identical-request replay. Rounding
  -- once, here, means every later reference to p_min_confidence (the
  -- idempotency comparison, the insert/update, the returned result) is
  -- already the exact value that will be stored.
  p_min_confidence := round(p_min_confidence, 3);

  -- Owner-role, active-membership authorization — the actual boundary.
  -- App-side admin-email checks are UX only; this is what actually gates
  -- the write, and it cannot be bypassed by a client that skips the app
  -- layer (a direct RPC call still hits this same check).
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

  -- Serialize concurrent edits to the same org/outcome cutoff.
  perform pg_advisory_xact_lock(hashtextextended(
    format('jev-outcome-threshold:%s:%s', p_org_id, p_outcome), 0
  ));

  -- Idempotent replay: an identical request (same org/outcome/key) already
  -- recorded — return that result rather than writing again. A caller that
  -- reuses the key with a different requested value gets a hard conflict
  -- instead of a silently-wrong "success".
  select * into v_existing_history
  from public.jev_outcome_threshold_history h
  where h.org_id = p_org_id
    and h.outcome = p_outcome
    and h.idempotency_key = p_idempotency_key;
  if found then
    if v_existing_history.new_min_confidence is distinct from p_min_confidence then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = '40001';
    end if;
    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'orgId', p_org_id,
      'outcome', p_outcome,
      'minConfidence', v_existing_history.new_min_confidence,
      'version', v_existing_history.version
    );
  end if;

  select id, version, min_confidence
  into v_threshold_id, v_current_version, v_previous_confidence
  from public.jev_outcome_thresholds
  where org_id = p_org_id and outcome = p_outcome
  for update;

  if not found then
    v_current_version := 0;
    v_previous_confidence := null;
  end if;

  if v_current_version is distinct from p_expected_version then
    raise exception 'STALE_STATE' using errcode = '40001';
  end if;

  v_new_version := v_current_version + 1;

  if v_threshold_id is null then
    insert into public.jev_outcome_thresholds (
      org_id, outcome, min_confidence, version, updated_at, updated_by
    ) values (
      p_org_id, p_outcome, p_min_confidence, v_new_version, statement_timestamp(), v_actor
    )
    returning id into v_threshold_id;
  else
    update public.jev_outcome_thresholds
    set min_confidence = p_min_confidence,
        version = v_new_version,
        updated_at = statement_timestamp(),
        updated_by = v_actor
    where id = v_threshold_id;
  end if;

  insert into public.jev_outcome_threshold_history (
    threshold_id, org_id, outcome, previous_min_confidence,
    new_min_confidence, version, changed_by, idempotency_key
  ) values (
    v_threshold_id, p_org_id, p_outcome, v_previous_confidence,
    p_min_confidence, v_new_version, v_actor, p_idempotency_key
  );

  v_result := jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'orgId', p_org_id,
    'outcome', p_outcome,
    'minConfidence', p_min_confidence,
    'version', v_new_version
  );
  return v_result;
end;
$$;

revoke all on function public.fn_set_jev_outcome_threshold(uuid, text, numeric, integer, uuid)
  from public, anon, service_role;
grant execute on function public.fn_set_jev_outcome_threshold(uuid, text, numeric, integer, uuid)
  to authenticated;

-- Seed provisional defaults for every existing org. fn_set_jev_outcome_threshold
-- cannot be used here — it requires auth.uid(), which is null in a migration
-- (no authenticated session) — so this inserts directly into both tables,
-- with updated_by/changed_by left null (system/migration, distinguishable
-- from any human edit, all of which carry a real auth.uid()).
do $$
declare
  v_org record;
  v_outcome record;
  v_new_id uuid;
begin
  for v_org in select id from public.organizations loop
    for v_outcome in select * from (values
      ('new_lead', 0.90),
      ('wrong_number', 0.90),
      ('not_interested', 0.95),
      ('nurture', 0.95),
      ('opted_out', 0.95)
    ) as v(outcome, min_confidence) loop
      if not exists (
        select 1 from public.jev_outcome_thresholds t
        where t.org_id = v_org.id and t.outcome = v_outcome.outcome
      ) then
        insert into public.jev_outcome_thresholds (
          org_id, outcome, min_confidence, version, updated_by
        ) values (
          v_org.id, v_outcome.outcome, v_outcome.min_confidence, 1, null
        )
        returning id into v_new_id;

        insert into public.jev_outcome_threshold_history (
          threshold_id, org_id, outcome, previous_min_confidence,
          new_min_confidence, version, changed_by
        ) values (
          v_new_id, v_org.id, v_outcome.outcome, null,
          v_outcome.min_confidence, 1, null
        );
      end if;
    end loop;
  end loop;
end $$;

-- reset_tenant_tables() (last redefined in 20260827110000_ai_disposition_reviews.sql)
-- must truncate the two new tables too — they FK to organizations, which is
-- not itself truncated, so TRUNCATE ... CASCADE would not reach them.
-- sms_classification_runs (20260920120000) has the same gap and was not
-- added here; out of scope for this migration to fix retroactively.
create or replace function public.reset_tenant_tables()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  create temp table _memberships_snapshot on commit drop as
    select * from public.memberships;

  truncate table
    public.jev_outcome_threshold_history,
    public.jev_outcome_thresholds,
    public.user_integration_prefs,
    public.user_oauth_tokens,
    public.call_recordings,
    public.call_transcripts,
    public.call_activities,
    public.dialer_batch_items,
    public.dialer_batches,
    public.dashboard_snapshots,
    public.metric_snapshots,
    public.memberships,
    public.task_reminder_deliveries,
    public.task_calendar_mutations,
    public.tasks,
    public.job_items,
    public.ai_response_claims,
    public.sms_inbound_deliveries,
    public.sms_inbound_intents,
    public.campaign_recipients,
    public.campaign_delivery_settings,
    public.campaigns,
    public.provider_sender_numbers,
    public.provider_campaigns,
    public.ai_disposition_reviews,
    public.message_threads,
    public.messages,
    public.consent_events,
    public.sms_phone_suppressions,
    public.property_merges,
    public.jobs,
    public.csv_imports,
    public.webhook_events,
    public.webhook_consumers,
    public.notifications,
    public.lead_events,
    public.lead_notes,
    public.sequence_step_runs,
    public.sequence_enrollments,
    public.sequence_steps,
    public.sequences,
    public.ai_responder_configs,
    public.property_lists,
    public.property_tags,
    public.tags,
    public.test_sms_log,
    public.closer_practice_outcomes,
    public.institute_course_outcomes,
    public.properties,
    public.homeowner_details,
    public.agent_details,
    public.contacts,
    public.cass_cache,
    public.skip_trace_cache
  restart identity cascade;

  -- Re-seed the provisional default thresholds for every remaining org,
  -- same as this migration's initial backfill, so a reset test project
  -- always starts from the documented defaults.
  insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, version, updated_by)
  select o.id, v.outcome, v.min_confidence, 1, null
  from public.organizations o
  cross join (values
    ('new_lead', 0.90),
    ('wrong_number', 0.90),
    ('not_interested', 0.95),
    ('nurture', 0.95),
    ('opted_out', 0.95)
  ) as v(outcome, min_confidence)
  on conflict (org_id, outcome) do nothing;

  delete from public.lists where coalesce(system_managed, false) = false;

  delete from public.sms_templates
  where coalesce(system_managed, false) = false
    and deleted_at is null;

  delete from public.saved_filters
  where coalesce(is_base, false) = false;

  insert into public.memberships
  select * from _memberships_snapshot
  where role = 'owner'
    and access_status = 'active'
    and deletion_prepared_at is null
    and access_expires_at is null
  order by org_id, user_id, id
  on conflict (user_id, org_id) do nothing;

  insert into public.memberships
  select * from _memberships_snapshot
  where role <> 'owner'
     or access_status <> 'active'
     or deletion_prepared_at is not null
     or access_expires_at is not null
  order by org_id, user_id, id
  on conflict (user_id, org_id) do nothing;
end;
$$;

commit;
