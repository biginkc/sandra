-- Canonical campaign delivery settings.
--
-- 20260701160000_provider_delivery_setup.sql was already applied to
-- production before this table existed. Keep that applied migration immutable
-- and create the new table/policies/functions here so `supabase db push`
-- actually applies the delivery-settings schema in every environment.

begin;

create table if not exists public.campaign_delivery_settings (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (length(trim(provider)) > 0),
  sender_number text not null check (length(trim(sender_number)) > 0),
  from_address text not null check (length(trim(from_address)) > 0),
  provider_campaign_id text,
  provider_campaign_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id)
);

create index if not exists idx_campaign_delivery_settings_org_provider
  on public.campaign_delivery_settings (org_id, provider);

-- Backfill campaigns created by earlier branch iterations. Whitespace-only
-- legacy values cannot satisfy the table checks, so skip them instead of
-- aborting the whole migration.
insert into public.campaign_delivery_settings (
  campaign_id,
  org_id,
  provider,
  sender_number,
  from_address,
  provider_campaign_id,
  provider_campaign_name,
  created_at,
  updated_at
)
select
  c.id,
  c.org_id,
  trim(c.sender_provider),
  trim(c.sender_number),
  trim(c.sender_number),
  c.provider_campaign_external_id,
  c.provider_campaign_name,
  c.created_at,
  c.updated_at
from public.campaigns c
where c.sender_provider is not null
  and c.sender_number is not null
  and length(trim(c.sender_provider)) > 0
  and length(trim(c.sender_number)) > 0
on conflict (campaign_id) do update
set
  org_id = excluded.org_id,
  provider = excluded.provider,
  sender_number = excluded.sender_number,
  from_address = excluded.from_address,
  provider_campaign_id = excluded.provider_campaign_id,
  provider_campaign_name = excluded.provider_campaign_name,
  updated_at = excluded.updated_at;

-- Durable legacy queue repair: rows already queued/paused before Delivery
-- settings existed can safely inherit their campaign's canonical sender. Rows
-- with no campaign snapshot remain queued and are deferred at runtime.
update public.messages m
set
  from_address = cds.from_address
from public.campaign_delivery_settings cds
where m.campaign_id = cds.campaign_id
  and m.direction = 'outbound'
  and m.status in ('queued', 'paused')
  and m.from_address is null
  and length(trim(cds.from_address)) > 0;

alter table public.campaign_delivery_settings enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'campaign_delivery_settings'
      and policyname = 'campaign_delivery_settings_org_select'
  ) then
    create policy campaign_delivery_settings_org_select on public.campaign_delivery_settings
      for select to authenticated
      using (
        exists (
          select 1
          from public.campaigns c
          join public.memberships m
            on m.org_id = c.org_id
          where c.id = campaign_delivery_settings.campaign_id
            and c.org_id = campaign_delivery_settings.org_id
            and m.user_id = auth.uid()
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'campaign_delivery_settings'
      and policyname = 'campaign_delivery_settings_org_insert'
  ) then
    create policy campaign_delivery_settings_org_insert on public.campaign_delivery_settings
      for insert to authenticated
      with check (
        exists (
          select 1
          from public.campaigns c
          join public.memberships m
            on m.org_id = c.org_id
          where c.id = campaign_delivery_settings.campaign_id
            and c.org_id = campaign_delivery_settings.org_id
            and m.user_id = auth.uid()
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'campaign_delivery_settings'
      and policyname = 'campaign_delivery_settings_org_update'
  ) then
    create policy campaign_delivery_settings_org_update on public.campaign_delivery_settings
      for update to authenticated
      using (
        exists (
          select 1
          from public.campaigns c
          join public.memberships m
            on m.org_id = c.org_id
          where c.id = campaign_delivery_settings.campaign_id
            and c.org_id = campaign_delivery_settings.org_id
            and m.user_id = auth.uid()
        )
      )
      with check (
        exists (
          select 1
          from public.campaigns c
          join public.memberships m
            on m.org_id = c.org_id
          where c.id = campaign_delivery_settings.campaign_id
            and c.org_id = campaign_delivery_settings.org_id
            and m.user_id = auth.uid()
        )
      );
  end if;
end $$;

create or replace function public.reject_locked_campaign_delivery_sender_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (
    old.provider is distinct from new.provider or
    old.sender_number is distinct from new.sender_number or
    old.from_address is distinct from new.from_address
  ) and exists (
    select 1
    from public.messages m
    where m.campaign_id = old.campaign_id
      and m.direction = 'outbound'
    limit 1
  ) then
    raise exception
      'campaign delivery sender is locked after outbound messages exist'
      using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists campaign_delivery_settings_sender_lock
  on public.campaign_delivery_settings;

create trigger campaign_delivery_settings_sender_lock
before update on public.campaign_delivery_settings
for each row
execute function public.reject_locked_campaign_delivery_sender_update();

create or replace function public.persist_campaign_delivery_settings(
  p_campaign_id uuid,
  p_org_id uuid,
  p_provider text,
  p_sender_number text,
  p_from_address text,
  p_provider_campaign_id text default null,
  p_provider_campaign_name text default null
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_provider text := trim(p_provider);
  v_sender_number text := trim(p_sender_number);
  v_from_address text := trim(p_from_address);
begin
  if length(v_provider) = 0 or length(v_sender_number) = 0 or length(v_from_address) = 0 then
    raise exception 'campaign delivery settings require provider, sender_number, and from_address'
      using errcode = '23514';
  end if;

  insert into public.campaign_delivery_settings (
    campaign_id,
    org_id,
    provider,
    sender_number,
    from_address,
    provider_campaign_id,
    provider_campaign_name,
    updated_at
  )
  values (
    p_campaign_id,
    p_org_id,
    v_provider,
    v_sender_number,
    v_from_address,
    nullif(trim(coalesce(p_provider_campaign_id, '')), ''),
    p_provider_campaign_name,
    v_now
  )
  on conflict (campaign_id) do update
  set
    org_id = excluded.org_id,
    provider = excluded.provider,
    sender_number = excluded.sender_number,
    from_address = excluded.from_address,
    provider_campaign_id = excluded.provider_campaign_id,
    provider_campaign_name = excluded.provider_campaign_name,
    updated_at = excluded.updated_at;

  update public.campaigns
  set
    sender_provider = v_provider,
    sender_number = v_sender_number,
    provider_campaign_external_id = nullif(trim(coalesce(p_provider_campaign_id, '')), ''),
    provider_campaign_name = p_provider_campaign_name,
    updated_at = v_now
  where id = p_campaign_id
    and org_id = p_org_id;

  if not found then
    raise exception 'campaign delivery settings campaign/org mismatch'
      using errcode = '23503';
  end if;
end;
$$;

revoke execute on function public.persist_campaign_delivery_settings(
  uuid, uuid, text, text, text, text, text
) from public;
grant execute on function public.persist_campaign_delivery_settings(
  uuid, uuid, text, text, text, text, text
) to authenticated;
grant execute on function public.persist_campaign_delivery_settings(
  uuid, uuid, text, text, text, text, text
) to service_role;

-- Keep the integration-test reset in step with the new settings table.
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
    public.metric_snapshots,
    public.memberships,
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
  on conflict (user_id, org_id) do nothing;
end;
$$;

revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;

commit;
