-- 20261008210000_hold_alerts_new_only.sql
-- Hold alerts fire only for holds that START after alerts were enabled.
-- Patches forward from 20261008150300.
--
-- Incident: turning HOLD_ALERTS_ENABLED on made the cron treat all 2,504 holds
-- already open (some flagged since May) as new, and it Slack-DMed the owner 20
-- times in 30s before the hourly cap stopped it. Alerts are about NEW holds.
--
-- 1. properties.needs_human_attention_since: when the flag last went false -> true,
--    kept by a trigger (set on flip to true, cleared on flip to false). Existing
--    rows are left NULL on purpose: a NULL start is "unknown" and never alerts, so
--    the backlog is never eligible. The trigger is `before insert or update of
--    needs_human_attention` and writes only its own column, so it does not fire
--    trg_properties_bump_decision_context_revision (a column-list trigger on other
--    columns) and never moves decision_context_revision.
-- 2. hold_alert_settings: a per-org watermark (alerts_since). The first cron run
--    after enable inserts alerts_since = now() and sends nothing; only holds that
--    began at or after it can alert. service_role writes, owners read.
-- 3. Pending (and retryable failed) deliveries are discarded as skipped
--    'backlog_discarded' so re-enabling can never send them. skipped reasons live
--    in last_error; the status check already allows 'skipped'.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- 1. Hold start clock ---------------------------------------------------------
alter table public.properties
  add column if not exists needs_human_attention_since timestamptz;

comment on column public.properties.needs_human_attention_since is
  'When needs_human_attention last flipped false -> true (trigger-maintained). NULL = unknown (rows flagged before this column existed) or not flagged. Hold alerts treat NULL as "never alert".';

create or replace function public.properties_track_needs_attention_since()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.needs_human_attention_since :=
      case when coalesce(new.needs_human_attention, false) then clock_timestamp() else null end;
  elsif not coalesce(new.needs_human_attention, false) then
    new.needs_human_attention_since := null;
  elsif not coalesce(old.needs_human_attention, false) then
    new.needs_human_attention_since := clock_timestamp();
  else
    -- Still flagged: the start never moves, whatever the statement set.
    new.needs_human_attention_since := old.needs_human_attention_since;
  end if;
  return new;
end;
$$;

revoke all on function public.properties_track_needs_attention_since() from public, anon, authenticated;

drop trigger if exists trg_properties_track_needs_attention_since on public.properties;
create trigger trg_properties_track_needs_attention_since
  before insert or update of needs_human_attention on public.properties
  for each row execute function public.properties_track_needs_attention_since();

-- 2. Per-org watermark ----------------------------------------------------------
create table if not exists public.hold_alert_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  alerts_since timestamptz not null,
  created_at timestamptz not null default now()
);
comment on table public.hold_alert_settings is
  'Per-org hold alert watermark. Only holds that began at or after alerts_since may alert. Inserted by the first cron run after alerts are enabled. Write: service role only.';

alter table public.hold_alert_settings enable row level security;
drop policy if exists hold_alert_settings_owner_select on public.hold_alert_settings;
create policy hold_alert_settings_owner_select on public.hold_alert_settings
  for select to authenticated
  using (
    exists (
      select 1
      from public.memberships m
      where m.org_id = hold_alert_settings.org_id
        and m.user_id = (select auth.uid())
        and m.role = 'owner'
        and m.access_status = 'active'
        and m.deletion_prepared_at is null
        and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
    )
  );

revoke all on table public.hold_alert_settings from public, anon, authenticated, service_role;
grant select on table public.hold_alert_settings to authenticated;
grant select, insert, update on table public.hold_alert_settings to service_role;

-- 3. Discard the backlog of undelivered alerts ------------------------------------
update public.hold_alert_deliveries
   set status = 'skipped',
       last_error = 'backlog_discarded'
 where status = 'pending'
    or (status = 'failed' and attempts < 3);

-- Test reset helper must clear the new table too.
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.reset_tenant_tables()'::regprocedure);
  if position('public.hold_alert_settings' in v_def) > 0 then return; end if;
  v_new := replace(v_def, E'    public.hold_alert_deliveries,', E'    public.hold_alert_deliveries,\n    public.hold_alert_settings,');
  if v_new = v_def then raise exception 'reset_tenant_tables hold-alert-settings patch not applied'; end if;
  execute v_new;
end $$;

commit;
