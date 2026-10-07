-- 20261008150000_hold_alert_deliveries.sql
-- Messages v2 Phase 1 alerts (PLAN 4.7 / 4.11). Patches forward from 20261008143600.
--
-- hold_alert_deliveries: one durable row per (hold, recipient, channel, stage).
-- The cron route inserts the row first (on conflict do nothing), claims it with
-- an atomic update, then sends, so overlapping cron runs cannot double-send and
-- a failed send is visible and retried a bounded number of times. Rows carry ids
-- and status only: never seller message text.
--
-- hold_key is `${property_id}:${hold since}` for a hold (a hold that clears and
-- re-opens alerts again) or `digest:${org_id}:${YYYY-MM-DDTHH}` (UTC hour) for
-- the hourly email digest, whose property_id is null.
--
-- Select: owner || acquisitions (same uncorrelated readable-org subquery as the
-- other Messages v2 tables). No write for authenticated; service_role writes.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists public.hold_alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid references public.properties(id) on delete cascade,
  hold_key text not null,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('slack', 'sms', 'email')),
  stage text not null check (stage in ('first', 'nudge_1h', 'digest')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint hold_alert_deliveries_unique_key
    unique (hold_key, recipient_user_id, channel, stage)
);
comment on table public.hold_alert_deliveries is
  'Durable hold alert deliveries (Slack DM / SMS / email digest). Ids and status only, never message text. Insert/update: service role only.';

create index if not exists idx_hold_alert_deliveries_org_created
  on public.hold_alert_deliveries (org_id, created_at desc);
create index if not exists idx_hold_alert_deliveries_property
  on public.hold_alert_deliveries (property_id);
create index if not exists idx_hold_alert_deliveries_cap
  on public.hold_alert_deliveries (recipient_user_id, channel, sent_at)
  where status = 'sent';

alter table public.hold_alert_deliveries enable row level security;
drop policy if exists hold_alert_deliveries_org_select on public.hold_alert_deliveries;
create policy hold_alert_deliveries_org_select on public.hold_alert_deliveries
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and org_id in (select public.pipeline_runs_readable_org_ids())
  );

revoke all on table public.hold_alert_deliveries
  from public, anon, authenticated, service_role;
grant select on table public.hold_alert_deliveries to authenticated;
grant select, insert, update on table public.hold_alert_deliveries to service_role;

do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.reset_tenant_tables()'::regprocedure);
  v_new := replace(v_def, E'    public.ai_reply_dead_letters,', E'    public.ai_reply_dead_letters,\n    public.hold_alert_deliveries,');
  if v_new = v_def then raise exception 'reset_tenant_tables hold-alert patch not applied'; end if;
  execute v_new;
end $$;

commit;
