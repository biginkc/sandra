-- 20261112120000_multi_number_sender_schema.sql
-- Multi-number SMS campaigns, PR 1 of 4 (plan: .planning/multi-number-campaigns-plan.md §3.2).
--
-- Additive only. No existing trigger or RPC is modified (reset_tenant_tables, a test-only
-- helper, gains the three new tables). Nothing here changes how any text is sent today:
-- `sms_sender_settings` starts with no rows (= pinning off, allocation off) and no
-- application path reads the new tables in PR 1.
--
--  * organizations.sendillo_brand_name           brand check for "sendable" (null = skipped)
--  * provider_sender_numbers.attached_campaign/_brand, backfilled from raw
--  * campaign_sender_numbers                      the campaign's number set (position 0 = primary)
--      + backfill from campaign_delivery_settings
--      + mirror trigger: the old single-sender persist keeps the set correct
--  * sms_sender_settings                          the only switch; ordering enforced by trigger
--  * sms_sender_assignments                       seller phone -> pinned business number
--  * two messages indexes for the evidence lookups (plain, transactional, with timeouts)
--
-- RPCs live in 20261112120100_multi_number_sender_rpcs.sql.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- Catalog + org brand
-- ---------------------------------------------------------------------------
alter table public.organizations
  add column if not exists sendillo_brand_name text;

comment on column public.organizations.sendillo_brand_name is
  'Sendillo brand a sender must be attached to, to be sendable. NULL = brand check skipped.';

alter table public.provider_sender_numbers
  add column if not exists attached_campaign text,
  add column if not exists attached_brand text;

-- Sendillo reports attachedCampaign / attachedBrand as strings (observed 2026-11-11);
-- accept an object with a name too, and snake_case, defensively.
update public.provider_sender_numbers p
set
  attached_campaign = coalesce(
    case jsonb_typeof(p.raw -> 'attachedCampaign')
      when 'string' then p.raw ->> 'attachedCampaign'
      when 'object' then p.raw -> 'attachedCampaign' ->> 'name'
    end,
    case jsonb_typeof(p.raw -> 'attached_campaign')
      when 'string' then p.raw ->> 'attached_campaign'
      when 'object' then p.raw -> 'attached_campaign' ->> 'name'
    end
  ),
  attached_brand = coalesce(
    case jsonb_typeof(p.raw -> 'attachedBrand')
      when 'string' then p.raw ->> 'attachedBrand'
      when 'object' then p.raw -> 'attachedBrand' ->> 'name'
    end,
    case jsonb_typeof(p.raw -> 'attached_brand')
      when 'string' then p.raw ->> 'attached_brand'
      when 'object' then p.raw -> 'attached_brand' ->> 'name'
    end
  )
where p.raw is not null
  and jsonb_typeof(p.raw) = 'object'
  and p.attached_campaign is null
  and p.attached_brand is null;

-- ---------------------------------------------------------------------------
-- campaign_sender_numbers
-- ---------------------------------------------------------------------------
create table if not exists public.campaign_sender_numbers (
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (length(trim(provider)) > 0),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  position int not null check (position >= 0),
  paused_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (campaign_id, phone_e164),
  unique (campaign_id, position)
);

create index if not exists idx_campaign_sender_numbers_org_phone
  on public.campaign_sender_numbers (org_id, phone_e164);

alter table public.campaign_sender_numbers enable row level security;

drop policy if exists campaign_sender_numbers_member_select on public.campaign_sender_numbers;
create policy campaign_sender_numbers_member_select on public.campaign_sender_numbers
  for select to authenticated
  using (org_id in (select m.org_id from public.memberships m where m.user_id = auth.uid()));

revoke all on table public.campaign_sender_numbers from public, anon, authenticated, service_role;
grant select on table public.campaign_sender_numbers to authenticated, service_role;

-- Backfill: one position-0 row per existing settings row with a usable sender.
insert into public.campaign_sender_numbers (campaign_id, org_id, provider, phone_e164, position, created_at)
select s.campaign_id, s.org_id, trim(s.provider), trim(s.sender_number), 0, s.created_at
from public.campaign_delivery_settings s
where trim(s.sender_number) ~ '^\+[1-9][0-9]{6,14}$'
on conflict do nothing;

-- Mirror: the settings sender is always the single position-0 row. Existing settings lock
-- triggers are untouched and still run first (they are BEFORE triggers), so a primary can
-- only change here while the campaign has no outbound rows.
create or replace function public.mirror_campaign_delivery_primary_sender()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text := trim(new.sender_number);
  v_provider text := trim(new.provider);
begin
  if v_phone is null or v_phone !~ '^\+[1-9][0-9]{6,14}$' then
    -- Not E.164: nothing to mirror (the old single-sender path still works unchanged).
    return null;
  end if;

  -- Old primary (a different number) leaves the set.
  delete from public.campaign_sender_numbers
  where campaign_id = new.campaign_id
    and position = 0
    and phone_e164 <> v_phone;

  -- New primary already a secondary: move it to position 0.
  update public.campaign_sender_numbers
  set position = 0, org_id = new.org_id, provider = v_provider
  where campaign_id = new.campaign_id
    and phone_e164 = v_phone;

  if not found then
    insert into public.campaign_sender_numbers (campaign_id, org_id, provider, phone_e164, position)
    values (new.campaign_id, new.org_id, v_provider, v_phone, 0);
  end if;

  return null;
end;
$$;

revoke execute on function public.mirror_campaign_delivery_primary_sender() from public, anon, authenticated;

drop trigger if exists campaign_delivery_settings_mirror_sender_numbers on public.campaign_delivery_settings;
create trigger campaign_delivery_settings_mirror_sender_numbers
after insert or update on public.campaign_delivery_settings
for each row
execute function public.mirror_campaign_delivery_primary_sender();

-- ---------------------------------------------------------------------------
-- sms_sender_assignments
-- ---------------------------------------------------------------------------
create table if not exists public.sms_sender_assignments (
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider = 'sendillo'),
  seller_phone_e164 text not null check (seller_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  sender_phone_e164 text not null check (sender_phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  source text not null check (source in (
    'evidence_inbound', 'evidence_outbound', 'commitment', 'campaign', 'user_pick', 'default', 'admin'
  )),
  source_campaign_id uuid references public.campaigns(id) on delete set null,
  source_message_id uuid,
  assigned_at timestamptz not null default now(),
  primary key (org_id, provider, seller_phone_e164)
);

create index if not exists idx_sms_sender_assignments_org_sender
  on public.sms_sender_assignments (org_id, sender_phone_e164);

alter table public.sms_sender_assignments enable row level security;

drop policy if exists sms_sender_assignments_member_select on public.sms_sender_assignments;
create policy sms_sender_assignments_member_select on public.sms_sender_assignments
  for select to authenticated
  using (org_id in (select m.org_id from public.memberships m where m.user_id = auth.uid()));

-- No insert/update/delete grant to any API role: rows are written only by the
-- security-definer RPCs (resolution, admin_reassign_sms_sender).
revoke all on table public.sms_sender_assignments from public, anon, authenticated, service_role;
grant select on table public.sms_sender_assignments to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- sms_sender_settings (missing row = pinning off)
-- ---------------------------------------------------------------------------
create table if not exists public.sms_sender_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  pinning_enabled boolean not null default false,
  pinning_enabled_at timestamptz,
  allocation_enabled boolean not null default false,
  default_sender_phone text check (default_sender_phone is null or default_sender_phone ~ '^\+[1-9][0-9]{6,14}$'),
  admission_paused_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.sms_sender_settings enable row level security;

drop policy if exists sms_sender_settings_member_select on public.sms_sender_settings;
create policy sms_sender_settings_member_select on public.sms_sender_settings
  for select to authenticated
  using (org_id in (select m.org_id from public.memberships m where m.user_id = auth.uid()));

revoke all on table public.sms_sender_settings from public, anon, authenticated, service_role;
grant select on table public.sms_sender_settings to authenticated;
grant select, insert, update on table public.sms_sender_settings to service_role;

-- Messages indexes for the phone-wide evidence lookups (§3.2). Plain, inside this
-- transaction: a lock/statement timeout rolls the whole migration back, never leaving an
-- invalid index.
create index if not exists idx_messages_org_to_sms_outbound_created
  on public.messages (org_id, to_address, created_at desc, id desc)
  where direction = 'outbound' and channel = 'sms';

create index if not exists idx_messages_org_from_sms_inbound_created
  on public.messages (org_id, from_address, created_at desc, id desc)
  where direction = 'inbound' and channel = 'sms';

-- reset_tenant_tables() (test helper; last redefined in 20261008140000_jev_outcome_thresholds.sql),
-- now also clearing the three new tenant tables.
create or replace function public.reset_tenant_tables()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  create temp table _memberships_snapshot on commit drop as
    select * from public.memberships;
  truncate table
    public.ai_reply_drafts,
    public.ai_send_reservations,
    public.ai_reply_dead_letters,
    public.hold_alert_deliveries,
    public.messages_v2_settings,
    public.hold_alert_settings,
    public.luna_suggestions,
    public.jev_lead_decisions,
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
    public.auto_reply_templates,
    public.sms_template_approval_events,
    public.ai_response_claims,
    public.sms_inbound_deliveries,
    public.sms_inbound_intents,
    public.campaign_recipients,
    public.sms_sender_assignments,
    public.sms_sender_settings,
    public.campaign_sender_numbers,
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
  insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, version, updated_by, automation_enabled)
  select o.id, v.outcome, v.min_confidence, 1, null, (v.outcome not in ('new_lead', 'opted_out'))
  from public.organizations o
  cross join (values
    ('new_lead', 0.90),
    ('wrong_number', 0.90),
    ('not_interested', 0.90),
    ('nurture', 0.95),
    ('opted_out', 0.95)
  ) as v(outcome, min_confidence)
  on conflict (org_id, outcome) do nothing;
  delete from public.lists where coalesce(system_managed, false) = false;
  perform set_config('sandra.template_approval', 'on', true);
  update public.sms_templates set approved_for_auto_send = false, approved_by = null, approved_at = null, approved_content = null where approved_for_auto_send;
  perform set_config('sandra.template_approval', 'off', true);
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
$function$;

commit;
