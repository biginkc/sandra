-- ============================================================================
-- Feature 5a — Sequences V1
--
-- Automated, multi-step outreach over time. V1 ships with:
--   - Manual enrollment only (no auto-triggers yet)
--   - Two action types: send_sms, change_status
--     (assign_task deferred until Feature 4c `lead_tasks` ships)
--   - Per-step delays (0–months, authored as minutes)
--   - Sequence-level opt-out auto-append setting
--   - Live-read templates (edits apply at next fire, no snapshot)
--   - Cron tick every 5 min via Vercel cron
--   - Pause on inbound reply / terminal status / acquisition status / STOP
--
-- Four tables, mirroring the plan:
--   - sequences             : the recipe (org-scoped)
--   - sequence_steps        : ordered steps per sequence
--   - sequence_enrollments  : per-lead instance
--   - sequence_step_runs    : audit log + double-fire guard
--
-- Idempotency: sequence_step_runs has a unique (enrollment_id, step_id)
-- index so a duplicate cron tick can't resend the same step. Combined
-- with `INSERT ... ON CONFLICT DO NOTHING` this gives us claim semantics
-- without a separate advisory lock.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- sequences
-- ----------------------------------------------------------------------------
create table sequences (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null check (length(trim(name)) > 0 and length(name) <= 120),
  description text,
  audience_type text not null default 'property' check (audience_type in ('property', 'contact')),
  trigger text not null default 'manual' check (trigger = 'manual'),
  -- When true, the send path ensures each send_sms body ends with a
  -- rotated opt-out phrase unless the template already handles opt-out
  -- (contains "STOP" or the {{opt_out}} variable).
  append_opt_out boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  archived_at timestamptz
);

-- Case-insensitive unique name per org among active (non-archived) sequences.
create unique index idx_sequences_name_per_org
  on sequences (org_id, lower(name))
  where archived_at is null;

create index idx_sequences_active
  on sequences (org_id)
  where archived_at is null and active;

alter table sequences enable row level security;
create policy sequences_authenticated_all on sequences
  for all to authenticated using (true) with check (true);

-- ----------------------------------------------------------------------------
-- sequence_steps
-- ----------------------------------------------------------------------------
create table sequence_steps (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references sequences(id) on delete cascade,
  -- 0-based ordering. Step 0 fires immediately (or after its delay) on enroll.
  step_index integer not null check (step_index >= 0),
  -- Minutes since the previous step's run_at. Step 0's delay is from enrollment time.
  delay_after_previous_minutes integer not null default 0 check (delay_after_previous_minutes >= 0),
  action_type text not null check (action_type in ('send_sms', 'change_status')),
  -- Populated when action_type = 'send_sms'. Handlebars-subset:
  -- {{variable}} substitution + {{#if variable}}...{{/if}} conditionals.
  template_body text,
  -- Populated when action_type = 'change_status' — target PropertyStatus value.
  target_status text,
  created_at timestamptz not null default now()
);

create unique index idx_sequence_steps_seq_index
  on sequence_steps (sequence_id, step_index);

create index idx_sequence_steps_sequence on sequence_steps (sequence_id);

alter table sequence_steps enable row level security;
create policy sequence_steps_authenticated_all on sequence_steps
  for all to authenticated using (true) with check (true);

-- ----------------------------------------------------------------------------
-- sequence_enrollments
-- ----------------------------------------------------------------------------
create table sequence_enrollments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  sequence_id uuid not null references sequences(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  -- Optional — for contact-audience sequences. Property-audience sequences
  -- thread via the property's homeowner_contact_id at send time.
  contact_id uuid references contacts(id) on delete set null,
  status text not null default 'active'
    check (status in ('active', 'paused', 'completed', 'opted_out')),
  current_step_index integer not null default 0 check (current_step_index >= 0),
  next_run_at timestamptz,
  enrolled_at timestamptz not null default now(),
  enrolled_by_user_id uuid references auth.users(id) on delete set null,
  -- Set when status flips to paused. Values: 'inbound_reply',
  -- 'status_terminal', 'status_acquisition_active', 'consent_revoked',
  -- 'manual'.
  pause_reason text,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

-- A given (sequence, property) pair can only have ONE active-or-paused
-- enrollment at a time. Completed / opted_out rows don't count, so a
-- VA can re-enroll a lead in the same sequence after a previous run
-- wraps up.
create unique index idx_enrollments_unique_active
  on sequence_enrollments (sequence_id, property_id)
  where status in ('active', 'paused');

-- Cron tick's hot query: rows due to advance.
create index idx_enrollments_due
  on sequence_enrollments (next_run_at)
  where status = 'active' and next_run_at is not null;

-- Lead detail / kanban drip chip query.
create index idx_enrollments_property on sequence_enrollments (property_id);

alter table sequence_enrollments enable row level security;
create policy sequence_enrollments_authenticated_all on sequence_enrollments
  for all to authenticated using (true) with check (true);

-- Publish to Realtime so the drip chip + sequences panel update live.
alter publication supabase_realtime add table sequence_enrollments;

-- ----------------------------------------------------------------------------
-- sequence_step_runs
--
-- Audit log of every step execution + the anti-double-fire claim record.
-- The cron tick inserts (enrollment_id, step_id) with ON CONFLICT DO
-- NOTHING before executing the action. If the insert succeeded, the
-- tick owns this fire. If it violated the unique index, another tick
-- already claimed it and we skip.
-- ----------------------------------------------------------------------------
create table sequence_step_runs (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references sequence_enrollments(id) on delete cascade,
  step_id uuid not null references sequence_steps(id) on delete cascade,
  -- FK to messages when action_type = 'send_sms' and the send succeeded.
  message_id uuid references messages(id) on delete set null,
  scheduled_for timestamptz not null,
  run_at timestamptz,
  skipped_reason text
    check (skipped_reason is null or skipped_reason in
      ('quiet_hours','consent_revoked','paused','escalated','no_phone','provider_failed')),
  created_at timestamptz not null default now()
);

-- Claim index — prevents double-fire.
create unique index idx_step_runs_unique_enrollment_step
  on sequence_step_runs (enrollment_id, step_id);

create index idx_step_runs_enrollment on sequence_step_runs (enrollment_id);

alter table sequence_step_runs enable row level security;
create policy sequence_step_runs_authenticated_all on sequence_step_runs
  for all to authenticated using (true) with check (true);

-- ----------------------------------------------------------------------------
-- Rebuild reset_tenant_tables to include the new sequence tables.
-- ----------------------------------------------------------------------------
create or replace function reset_tenant_tables()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  truncate table
    job_items,
    messages,
    consent_events,
    property_merges,
    jobs,
    csv_imports,
    webhook_events,
    notifications,
    lead_notes,
    sequence_step_runs,
    sequence_enrollments,
    sequence_steps,
    sequences,
    property_lists,
    property_tags,
    tags,
    lists,
    test_sms_log,
    properties,
    homeowner_details,
    agent_details,
    contacts,
    cass_cache
  restart identity cascade;
end;
$$;

revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;

-- ----------------------------------------------------------------------------
-- Starter library (4 sequences).
--
-- The 5th starter from the original plan ("Hot lead handoff") used
-- action_type='assign_task', which depends on the `lead_tasks` table
-- from Feature 4c. It'll land as a one-line seed append once that
-- table exists.
--
-- Templates use {{#if first_name}} conditionals because skip-trace
-- doesn't always capture first_name; this way the SMS reads cleanly
-- for both known and unknown leads.
-- ----------------------------------------------------------------------------
do $$
declare
  org_id_val uuid;
  seq_id uuid;
begin
  for org_id_val in select id from organizations loop

    -- 1. First touch new lead — 3 steps, 0 / +2d / +5d.
    insert into sequences (org_id, name, description)
      values (org_id_val, 'First touch new lead',
        '3-step nurture for newly-qualified leads, spaced over ~7 days.')
      returning id into seq_id;
    insert into sequence_steps (sequence_id, step_index, delay_after_previous_minutes, action_type, template_body) values
      (seq_id, 0, 0, 'send_sms',
        '{{#if first_name}}Hi {{first_name}}, {{/if}}this is {{my_first_name}} with {{company_name}}. I saw your property at {{property_address}}. Would you consider a cash offer? {{opt_out}}'),
      (seq_id, 1, 60 * 24 * 2, 'send_sms',
        '{{#if first_name}}Hi {{first_name}}, {{/if}}following up on {{property_address}}. Still open to a quick conversation? {{opt_out}}'),
      (seq_id, 2, 60 * 24 * 5, 'send_sms',
        '{{#if first_name}}Hi {{first_name}}, {{/if}}one more try on {{property_address}} — happy to send an offer if you''re interested. {{opt_out}}');

    -- 2. Nurture cold lead — 4 quarterly check-ins over 12 months.
    insert into sequences (org_id, name, description)
      values (org_id_val, 'Nurture cold lead',
        'Quarterly check-ins over 12 months for leads who went quiet.')
      returning id into seq_id;
    insert into sequence_steps (sequence_id, step_index, delay_after_previous_minutes, action_type, template_body) values
      (seq_id, 0, 0, 'send_sms',
        '{{#if first_name}}Hi {{first_name}}, {{/if}}checking in on {{property_address}} — any change in plans? {{opt_out}}'),
      (seq_id, 1, 60 * 24 * 90, 'send_sms',
        '{{#if first_name}}Hi {{first_name}}, {{/if}}quarterly check-in on {{property_address}}. Still in your plans? {{opt_out}}'),
      (seq_id, 2, 60 * 24 * 90, 'send_sms',
        '{{#if first_name}}Hi {{first_name}}, {{/if}}another touch on {{property_address}}. Still curious if selling is on the table. {{opt_out}}'),
      (seq_id, 3, 60 * 24 * 90, 'send_sms',
        '{{#if first_name}}Hope all''s well, {{first_name}}. {{/if}}Any reason to chat about {{property_address}}? {{opt_out}}');

    -- 3. Nurture not-interested — semi-annual over 24 months.
    insert into sequences (org_id, name, description)
      values (org_id_val, 'Nurture not-interested',
        'Semi-annual revisit over 24 months for leads who said "not now".')
      returning id into seq_id;
    insert into sequence_steps (sequence_id, step_index, delay_after_previous_minutes, action_type, template_body) values
      (seq_id, 0, 60 * 24 * 180, 'send_sms',
        '{{#if first_name}}Hi {{first_name}}, {{/if}}circling back on {{property_address}}. Circumstances change — still not a fit? {{opt_out}}'),
      (seq_id, 1, 60 * 24 * 180, 'send_sms',
        '{{#if first_name}}Hi {{first_name}}, {{/if}}6-month check-in on {{property_address}}. Anything new on your end? {{opt_out}}'),
      (seq_id, 2, 60 * 24 * 180, 'send_sms',
        '{{#if first_name}}Hi {{first_name}}, {{/if}}annual note on {{property_address}}. Any shift? {{opt_out}}'),
      (seq_id, 3, 60 * 24 * 180, 'send_sms',
        '{{#if first_name}}Hi {{first_name}}, {{/if}}final touch on {{property_address}}. Reply anytime if you want to chat. {{opt_out}}');

    -- 4. Dead lead requalify — single touch at 90 days.
    insert into sequences (org_id, name, description)
      values (org_id_val, 'Dead lead requalify',
        '90-day re-touch to check if a "dead" lead is ready to revisit.')
      returning id into seq_id;
    insert into sequence_steps (sequence_id, step_index, delay_after_previous_minutes, action_type, template_body) values
      (seq_id, 0, 60 * 24 * 90, 'send_sms',
        '{{#if first_name}}Hi {{first_name}}, {{/if}}it''s been a few months since we chatted about {{property_address}}. Anything change on your end? {{opt_out}}');

  end loop;
end $$;
