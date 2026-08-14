-- ============================================================================
-- Sandra Appointments — PR 1: schema
--
-- Extends `tasks` with an `appointment` type (start/end time, calendar chain,
-- outcome, reminder claim) so booking a call/showing is a task row instead of
-- a new entity. Adds a durable calendar-mutation ledger and a reminder
-- outbox, both tenant-locked to their owning task via composite foreign
-- keys — an outbox/ledger row's org (and, for the ledger, calendar chain)
-- can never disagree with its task, even for service-role writes.
--
-- A SECURITY DEFINER trigger enforces tenant + active-membership integrity
-- on every tasks insert/update, because `memberships_self_select` RLS
-- (20260728150000) hides teammates' rows from the invoking user — an
-- invoker-rights check would wrongly reject valid teammate assignment. The
-- trigger only fires on INSERT or when assignee/org/contact/property
-- actually changes, so an assignee whose membership later expires cannot
-- abort unrelated updates (reminder claims, generation bumps, snooze) on
-- their existing tasks.
--
-- A pre-install audit aborts the whole migration (single transaction) if any
-- existing task already violates the integrity the trigger is about to
-- start enforcing, so prod rehearsal surfaces violations for manual
-- remediation instead of the trigger silently going live over bad data.
--
-- Full plan: reactive-puzzling-crane.md v9 (Codex-approved, round 9,
-- BLOCKING: 0), PR 1 Migration section.
--
-- CI-only: applies on merge via .github/workflows/db-migrate-test.yml, then
-- db-migrate-prod.yml on the test workflow's success (migration guard #345).
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. tasks — appointment columns + coherence CHECKs
-- ----------------------------------------------------------------------------
alter table public.tasks
  alter column related_property_id drop not null;

alter table public.tasks
  add column contact_id uuid,
  add column description text,
  add column end_at timestamptz,
  add column outcome text,
  add column reminder_claimed_at timestamptz,
  add column calendar_chain_id uuid,
  add column calendar_generation integer not null default 0;

comment on column public.tasks.contact_id is
  'Optional contact this task/appointment concerns. Nullable — a personal block can have neither contact nor property.';
comment on column public.tasks.description is
  'Free-text note captured on the booking form. Persists what the assignee typed at booking time.';
comment on column public.tasks.end_at is
  'Appointment end time. NULL for non-appointment task types.';
comment on column public.tasks.outcome is
  'Post-appointment result: held, no_show, rescheduled, cancelled. Set on completion/cancellation of an appointment.';
comment on column public.tasks.reminder_claimed_at is
  'Stamped by fn_claim_appointment_reminders() (PR 3) when a reminder sweep claims this appointment for delivery. Appointment-only.';
comment on column public.tasks.calendar_chain_id is
  'Born at booking (gen_random_uuid()) and inherited by every reschedule successor of the same logical appointment. NULL for non-appointment tasks — see tasks_calendar_chain_invariant_check.';
comment on column public.tasks.calendar_generation is
  'Compare-and-set stamp bumped around Google Calendar mutations (PR 3). In-flight/retry state lives in task_calendar_mutations, not here.';

-- Widen the type CHECK (originally `tasks_type_check`, named by Postgres for
-- the unnamed inline CHECK in 051_tasks_table.sql) to add 'appointment'.
alter table public.tasks
  drop constraint tasks_type_check;
alter table public.tasks
  add constraint tasks_type_check
  check (type in ('follow_up', 'callback', 'custom', 'appointment'));

-- Every non-appointment task keeps requiring a property (preserves the
-- pre-migration NOT NULL behavior for follow_up/callback/custom). Appointment
-- tasks may carry a property, a contact, neither (personal block), or both.
alter table public.tasks
  add constraint tasks_related_property_linkage_check
  check ((type <> 'appointment' and related_property_id is not null) or type = 'appointment');

alter table public.tasks
  add constraint tasks_end_at_check
  check (end_at is null or (type = 'appointment' and end_at > due_at));

alter table public.tasks
  add constraint tasks_outcome_check
  check (
    outcome is null
    or (
      type = 'appointment'
      and status in ('completed', 'cancelled')
      and outcome in ('held', 'no_show', 'rescheduled', 'cancelled')
    )
  );

alter table public.tasks
  add constraint tasks_reminder_claimed_at_check
  check (reminder_claimed_at is null or type = 'appointment');

alter table public.tasks
  add constraint tasks_calendar_chain_invariant_check
  check ((type = 'appointment') = (calendar_chain_id is not null));

-- Composite uniques so the reminder outbox and calendar ledger can carry
-- tenant (and, for the ledger, chain) agreement directly in their FKs rather
-- than relying on writer discipline. `id` is already globally unique via the
-- primary key; these compose it with org_id (and calendar_chain_id) so a
-- referencing row's org/chain can never disagree with its task's.
alter table public.tasks
  add constraint tasks_id_org_id_key unique (id, org_id);
alter table public.tasks
  add constraint tasks_id_org_id_calendar_chain_id_key unique (id, org_id, calendar_chain_id);

-- Tenant agreement with PARENTS is structural, not trigger-only: composite
-- FKs pin a task's property/contact to the task's own org, so a dual-org
-- user cannot move a referenced parent's org_id out from under its tasks
-- (the FK blocks the parent move and the mismatched insert alike). The
-- trigger (section 3) remains as defense in depth and for the
-- active-assignee check, which no FK can express.
alter table public.properties
  add constraint properties_id_org_id_key unique (id, org_id);
alter table public.contacts
  add constraint contacts_id_org_id_key unique (id, org_id);

alter table public.tasks
  drop constraint tasks_related_property_id_fkey;
alter table public.tasks
  add constraint tasks_related_property_org_fkey
  foreign key (related_property_id, org_id)
  references public.properties (id, org_id) on delete cascade;

-- PG15+ column-list SET NULL: only contact_id is nulled on contact
-- deletion — org_id must survive (NOT NULL).
alter table public.tasks
  add constraint tasks_contact_org_fkey
  foreign key (contact_id, org_id)
  references public.contacts (id, org_id) on delete set null (contact_id);

-- ----------------------------------------------------------------------------
-- 2. Pre-install audit — abort the migration if existing tasks already
--    violate the integrity the trigger (section 3) is about to enforce.
--    Runs inside this migration's transaction: a violation here rolls back
--    every change above and below, surfacing offending ids for manual
--    remediation before the trigger (and its stricter posture) ever lands.
-- ----------------------------------------------------------------------------
do $$
declare
  v_property_offenders uuid[];
  v_assignee_offenders uuid[];
begin
  select array_agg(t.id order by t.id)
  into v_property_offenders
  from public.tasks t
  join public.properties p on p.id = t.related_property_id
  where t.related_property_id is not null
    and p.org_id <> t.org_id;

  if v_property_offenders is not null then
    raise exception
      'appointments_schema pre-install audit: % task(s) reference a property outside their org: %',
      array_length(v_property_offenders, 1), v_property_offenders
      using errcode = 'P0001';
  end if;

  -- Live (open/snoozed) tasks with an inactive assignee would break claim and
  -- reassign flows the moment the trigger lands — hard abort. Historical
  -- (completed/cancelled) tasks legitimately keep long-gone assignees; the
  -- scope-gated trigger never revalidates them on unrelated updates, so they
  -- are surfaced as a NOTICE for optional cleanup, never a migration abort.
  select array_agg(t.id order by t.id)
  into v_assignee_offenders
  from public.tasks t
  where t.status in ('open', 'snoozed')
    and not exists (
      select 1
      from public.memberships m
      where m.user_id = t.assignee_id
        and m.org_id = t.org_id
        and m.access_status = 'active'
        and m.deletion_prepared_at is null
        and (m.access_expires_at is null or m.access_expires_at > now())
    );

  if v_assignee_offenders is not null then
    raise exception
      'appointments_schema pre-install audit: % live task(s) assigned to a missing/inactive membership: %',
      array_length(v_assignee_offenders, 1), v_assignee_offenders
      using errcode = 'P0001';
  end if;

  select array_agg(t.id order by t.id)
  into v_assignee_offenders
  from public.tasks t
  where t.status in ('completed', 'cancelled')
    and not exists (
      select 1
      from public.memberships m
      where m.user_id = t.assignee_id
        and m.org_id = t.org_id
        and m.access_status = 'active'
        and m.deletion_prepared_at is null
        and (m.access_expires_at is null or m.access_expires_at > now())
    );

  if v_assignee_offenders is not null then
    raise notice
      'appointments_schema pre-install audit: % historical task(s) reference an inactive assignee (no action required): %',
      array_length(v_assignee_offenders, 1), v_assignee_offenders;
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. Tenant-integrity trigger
--
-- SECURITY DEFINER (bypasses memberships_self_select so a teammate
-- assignment can be validated even though the inviting caller cannot SELECT
-- the assignee's own membership row) with a pinned search_path. Plain
-- BEFORE INSERT OR UPDATE FOR EACH ROW — applies to every writer, including
-- service_role, since it is not an RLS policy.
--
-- Scope-gated firing: on UPDATE, skip validation entirely unless org_id,
-- assignee_id, contact_id, or related_property_id actually changed. This is
-- what makes an assignee's later-expiring membership harmless to unrelated
-- updates (reminder claims, generation bumps, snooze) on their existing
-- tasks — only identity-relevant writes re-validate.
--
-- When org_id changes, ALL THREE relations (contact, property, assignee)
-- are revalidated against the new org, not just whichever column changed —
-- the checks below run unconditionally once the trigger proceeds past the
-- early return, so a bare org_id change still catches a contact/property
-- that silently no longer matches.
-- ----------------------------------------------------------------------------
create or replace function public.tasks_tenant_integrity_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- OLD is unassigned in INSERT triggers and plpgsql does not guarantee
  -- boolean short-circuiting, so every OLD access lives inside the
  -- explicit UPDATE branch below.
  v_org_changed boolean := true;
  v_contact_changed boolean := true;
  v_property_changed boolean := true;
  v_assignee_changed boolean := true;
begin
  if tg_op = 'UPDATE' then
    v_org_changed := new.org_id is distinct from old.org_id;
    v_contact_changed := new.contact_id is distinct from old.contact_id;
    v_property_changed := new.related_property_id is distinct from old.related_property_id;
    v_assignee_changed := new.assignee_id is distinct from old.assignee_id;

    -- Appointment time moves are lifecycle-owned: an authenticated member
    -- updating due_at/end_at directly (or via the legacy snooze path)
    -- would shift Sandra's window without the calendar reschedule
    -- machinery, desyncing the external event. Lifecycle RPCs (PR 3) opt
    -- in with a transaction-local flag; nothing else may move an
    -- appointment's times.
    if old.type = 'appointment'
       and (new.due_at is distinct from old.due_at
            or new.end_at is distinct from old.end_at)
       and coalesce(current_setting('sandra.allow_appointment_time_move', true), '') <> 'on'
    then
      raise exception
        'tasks_tenant_integrity_guard: appointment times move only through the reschedule lifecycle'
        using errcode = 'P0001';
    end if;

    -- Appointment identity is immutable: without this, a member could flip
    -- an appointment to 'custom' (clearing its chain), move due_at while
    -- the time guard is blind, and flip it back — resynchronizing nothing.
    -- Type transitions across the appointment boundary and any
    -- calendar_chain_id change are lifecycle-only operations.
    if ((old.type = 'appointment') <> (new.type = 'appointment')
        or new.calendar_chain_id is distinct from old.calendar_chain_id)
       and coalesce(current_setting('sandra.allow_appointment_time_move', true), '') <> 'on'
    then
      raise exception
        'tasks_tenant_integrity_guard: appointment identity (type/calendar chain) is immutable outside the lifecycle'
        using errcode = 'P0001';
    end if;
  end if;

  -- Each relation validates independently, only when it (or the org)
  -- actually changed. Side-effect UPDATEs stay harmless: the contact FK's
  -- ON DELETE SET NULL changes contact_id on historical tasks whose
  -- assignee may be long-inactive — that write must not drag the assignee
  -- re-check along with it.
  if not (v_org_changed or v_contact_changed or v_property_changed or v_assignee_changed) then
    return new;
  end if;

  if (v_org_changed or v_contact_changed) and new.contact_id is not null then
    if not exists (
      select 1
      from public.contacts c
      where c.id = new.contact_id
        and c.org_id = new.org_id
    ) then
      raise exception
        'tasks_tenant_integrity_guard: contact % is not in org %', new.contact_id, new.org_id
        using errcode = 'P0001';
    end if;
  end if;

  if (v_org_changed or v_property_changed) and new.related_property_id is not null then
    if not exists (
      select 1
      from public.properties p
      where p.id = new.related_property_id
        and p.org_id = new.org_id
    ) then
      raise exception
        'tasks_tenant_integrity_guard: property % is not in org %', new.related_property_id, new.org_id
        using errcode = 'P0001';
    end if;
  end if;

  if v_org_changed or v_assignee_changed then
    -- FOR SHARE serializes this check against concurrent membership
    -- lifecycle UPDATEs (suspension, expiry-stamping): under READ
    -- COMMITTED an unlocked EXISTS could observe the still-active row
    -- while a parallel transaction suspends it, letting both commit. The
    -- share lock makes the suspender wait for this insert/reassign (or
    -- vice versa), so one of the two orders wins cleanly.
    perform 1
    from public.memberships m
    where m.user_id = new.assignee_id
      and m.org_id = new.org_id
      and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > now())
    for share of m;

    if not found then
      raise exception
        'tasks_tenant_integrity_guard: assignee % has no active membership in org %', new.assignee_id, new.org_id
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.tasks_tenant_integrity_guard()
  from public, anon, authenticated;

drop trigger if exists trg_tasks_tenant_integrity_guard on public.tasks;
create trigger trg_tasks_tenant_integrity_guard
  before insert or update on public.tasks
  for each row execute function public.tasks_tenant_integrity_guard();

-- ----------------------------------------------------------------------------
-- 4. properties.outreach_dispo — widen with 'booked_appointment'
--
-- Named `properties_outreach_dispo_check` since 045; every existing value
-- carried forward verbatim from 20260622145423, plus the new one.
-- ----------------------------------------------------------------------------
alter table public.properties
  drop constraint if exists properties_outreach_dispo_check;

alter table public.properties
  add constraint properties_outreach_dispo_check
  check (outreach_dispo is null or outreach_dispo in (
    'wrong_number',
    'bad_number',
    'not_interested',
    'opted_out',
    'dnc',
    'nurture',
    'callback_requested',
    'needs_sequence',
    'booked_appointment'
  ));

-- ----------------------------------------------------------------------------
-- 5. task_reminder_deliveries — reminder outbox
--
-- Composite FK (task_id, org_id) -> tasks (id, org_id) makes an outbox row's
-- org agree with its task's org in the DB, not by writer discipline.
-- ----------------------------------------------------------------------------
create table public.task_reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  task_id uuid not null,
  channel text not null check (channel in ('bell', 'slack', 'sms')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  provider_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (task_id, channel),
  constraint task_reminder_deliveries_task_org_fkey
    foreign key (task_id, org_id) references public.tasks (id, org_id) on delete cascade
);

comment on table public.task_reminder_deliveries is
  'Per-channel appointment reminder outbox. One row per (task, channel), written by fn_claim_appointment_reminders() (PR 3). Bell is exactly-once (see notifications partial unique index); Slack/SMS are at-least-once, bounded by attempts.';

create index idx_task_reminder_deliveries_org_id
  on public.task_reminder_deliveries (org_id);

alter table public.task_reminder_deliveries enable row level security;

-- Server-owned table: org members may READ their org's rows (owner views,
-- diagnostics) but never write — a member who could insert/update/delete
-- here could pre-occupy the (task_id, channel) unique key, mark deliveries
-- sent, or delete pending work, suppressing teammates' reminders. All
-- writes go through service-role sweeps (PR 3), which bypass RLS; the
-- explicit REVOKE below is defense in depth on top of the absent write
-- policies.
create policy task_reminder_deliveries_org_select on public.task_reminder_deliveries
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id));

revoke insert, update, delete on public.task_reminder_deliveries
  from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 6. task_calendar_mutations — durable calendar mutation ledger
--
-- Composite FKs carry org AND chain agreement in one constraint: a ledger
-- row cannot reference tasks from a different chain or supply an arbitrary
-- chain id. `target_task_id` is nullable; Postgres's default MATCH SIMPLE
-- skips FK enforcement entirely when any referencing column (here,
-- target_task_id) is NULL, so a mutation with no successor task yet is
-- unconstrained on that FK until a target is assigned.
--
-- `client_event_id` and `result_reason` are included now (rather than only
-- when PR 3 lifecycle RPCs start writing them) so the table's shape is
-- final in PR 1 and PR 3 never needs a follow-up ALTER TABLE — both are
-- nullable and inert until PR 3's RPCs populate them.
-- ----------------------------------------------------------------------------
create table public.task_calendar_mutations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  calendar_chain_id uuid not null,
  operation text not null check (operation in ('create', 'reschedule', 'reassign', 'cancel')),
  phase text not null default 'pending' check (phase in ('pending', 'provider_done', 'finalized', 'failed')),
  source_task_id uuid not null,
  target_task_id uuid,
  old_assignee_id uuid not null references auth.users(id) on delete cascade,
  new_assignee_id uuid references auth.users(id) on delete cascade,
  event_id text,
  new_event_id text,
  client_event_id text,
  result_reason text,
  expected_generation integer not null,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task_calendar_mutations_source_task_fkey
    foreign key (source_task_id, org_id, calendar_chain_id)
    references public.tasks (id, org_id, calendar_chain_id) on delete cascade,
  constraint task_calendar_mutations_target_task_fkey
    foreign key (target_task_id, org_id, calendar_chain_id)
    references public.tasks (id, org_id, calendar_chain_id) on delete cascade
);

comment on table public.task_calendar_mutations is
  'Durable ledger for Google Calendar mutations on appointment tasks (PR 3 lifecycle RPCs write it). Full lineage per calendar_chain_id: which task owns which event, under whose account, at what generation. Retry sweeps read phase IN (pending, provider_done); the chain-scoped partial unique index below serializes concurrent mutations on the same logical appointment.';
comment on column public.task_calendar_mutations.result_reason is
  'Nullable terminal-phase diagnostic (PR 3): e.g. pref_disabled, no_token, auth_permanent, event_created, reconciled_409.';
comment on column public.task_calendar_mutations.client_event_id is
  'Deterministic client-supplied Google event id (PR 3), persisted before the provider call so a crash-and-retry reconciles via 409 instead of creating a duplicate event.';

-- One in-flight Google mutation per logical appointment, regardless of
-- which row (predecessor or successor) a second request targets.
create unique index idx_task_calendar_mutations_chain_serialization
  on public.task_calendar_mutations (calendar_chain_id)
  where phase in ('pending', 'provider_done');

create index idx_task_calendar_mutations_org_id
  on public.task_calendar_mutations (org_id);
create index idx_task_calendar_mutations_source_task
  on public.task_calendar_mutations (source_task_id, org_id, calendar_chain_id);
create index idx_task_calendar_mutations_target_task
  on public.task_calendar_mutations (target_task_id, org_id, calendar_chain_id)
  where target_task_id is not null;

alter table public.task_calendar_mutations enable row level security;

-- Server-owned ledger: readable by org members, writable only through the
-- PR 3 lifecycle RPCs (SECURITY DEFINER / service role, with explicit
-- caller, task, generation, and state-transition checks). A member who
-- could write here directly could forge ledger phases or event ids and
-- corrupt provider retry/reconciliation state.
create policy task_calendar_mutations_org_select on public.task_calendar_mutations
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id));

revoke insert, update, delete on public.task_calendar_mutations
  from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 7. notifications — widen event_type, bell exactly-once
--
-- `notifications_event_type_check` last touched in 076; every existing
-- value carried forward verbatim, plus the new one.
-- ----------------------------------------------------------------------------
alter table public.notifications
  drop constraint notifications_event_type_check;
alter table public.notifications
  add constraint notifications_event_type_check check (event_type = any (array[
    'owner_message_added'::text,
    'property_assigned'::text,
    'bulk_action_completed'::text,
    'skip_trace_requested'::text,
    'task_assigned'::text,
    'ai_responder_provider_failure'::text,
    'task_appointment_reminder'::text
  ]));

-- Exactly-once bell delivery: reminder insert uses ON CONFLICT DO NOTHING
-- (PR 3) against this partial unique index.
create unique index idx_notifications_task_appointment_reminder_unique
  on public.notifications (user_id, entity_id)
  where event_type = 'task_appointment_reminder';

-- ----------------------------------------------------------------------------
-- 8. user_integration_prefs — SMS reminder channel, fail-closed phone
--
-- `user_integration_prefs_channel_check` unchanged since 061; widened here.
-- Contract change (loadIntegrationPrefs: absent row = disabled) lands with
-- the settings UI in a later PR — this migration only adds the DB shape.
-- ----------------------------------------------------------------------------
alter table public.user_integration_prefs
  drop constraint user_integration_prefs_channel_check;
alter table public.user_integration_prefs
  add constraint user_integration_prefs_channel_check
  check (channel in ('slack', 'google_calendar', 'sms_reminder'));

alter table public.user_integration_prefs
  add column reminder_phone text;

comment on column public.user_integration_prefs.reminder_phone is
  'E.164 number for the sms_reminder channel. Fail-closed by design: an absent row or NULL phone means SMS reminders are disabled, never inferred-enabled.';

alter table public.user_integration_prefs
  add constraint user_integration_prefs_reminder_phone_format_check
  check (reminder_phone is null or reminder_phone ~ '^\+[1-9][0-9]{6,14}$');

alter table public.user_integration_prefs
  add constraint user_integration_prefs_reminder_phone_channel_check
  check (reminder_phone is null or channel = 'sms_reminder');

-- ----------------------------------------------------------------------------
-- 9. Indexes
-- ----------------------------------------------------------------------------

-- "This contact's tasks by status" — booking form + lead detail widget.
create index idx_tasks_contact_status
  on public.tasks (contact_id, status)
  where contact_id is not null;

-- Serves double-book overlap checks and the reminder claim sweep (PR 2/3).
create index idx_tasks_appointment_overlap
  on public.tasks (org_id, assignee_id, due_at)
  where type = 'appointment' and status = 'open';

-- ----------------------------------------------------------------------------
-- 10. reset_tenant_tables() — add the two new tables
-- ----------------------------------------------------------------------------
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

revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
grant execute on function public.reset_tenant_tables() to service_role;

commit;
