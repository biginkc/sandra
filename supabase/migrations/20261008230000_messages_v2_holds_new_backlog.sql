-- 20261008230000_messages_v2_holds_new_backlog.sql
-- Messages v2 Holds rail: split "New" from "Backlog".
--
-- messages_v2_settings: one row per org. backlog_before is the fixed cutover:
-- holds whose effective start is before it are Backlog ("Flagged before
-- Messages v2 went live"); the rest are New. The page seeds the row to now()
-- on first load (insert ... on conflict do nothing), so the cutover never moves.
--
-- messages_v2_hold_buckets(org, bucket, limit, offset): classifies every open
-- hold property in one pass and returns exact counts plus one page of ids.
-- Effective start = newest of: the flag's last_ai_escalation_at, the newest
-- pending Jev decision / disposition review / reply draft created_at, and the
-- newest inbound message at or after the cutover. SECURITY INVOKER: the
-- caller's RLS applies to every table it reads.
--
-- Select: owner || acquisitions. Write: service_role, or an org owner.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists public.messages_v2_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  backlog_before timestamptz not null,
  created_at timestamptz not null default now()
);
comment on table public.messages_v2_settings is
  'Per-org Messages v2 settings. backlog_before: holds with an effective start before this are shown as Backlog, not New.';

alter table public.messages_v2_settings enable row level security;

drop policy if exists messages_v2_settings_org_select on public.messages_v2_settings;
create policy messages_v2_settings_org_select on public.messages_v2_settings
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and org_id in (select public.pipeline_runs_readable_org_ids())
  );

drop policy if exists messages_v2_settings_owner_insert on public.messages_v2_settings;
create policy messages_v2_settings_owner_insert on public.messages_v2_settings
  for insert to authenticated
  with check (
    public.hugo_has_active_org_access(org_id)
    and exists (
      select 1 from public.memberships m
      where m.org_id = messages_v2_settings.org_id
        and m.user_id = (select auth.uid())
        and m.access_status = 'active'
        and m.role = 'owner'
    )
  );

drop policy if exists messages_v2_settings_owner_update on public.messages_v2_settings;
create policy messages_v2_settings_owner_update on public.messages_v2_settings
  for update to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and exists (
      select 1 from public.memberships m
      where m.org_id = messages_v2_settings.org_id
        and m.user_id = (select auth.uid())
        and m.access_status = 'active'
        and m.role = 'owner'
    )
  )
  with check (
    public.hugo_has_active_org_access(org_id)
    and exists (
      select 1 from public.memberships m
      where m.org_id = messages_v2_settings.org_id
        and m.user_id = (select auth.uid())
        and m.access_status = 'active'
        and m.role = 'owner'
    )
  );

revoke all on table public.messages_v2_settings
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.messages_v2_settings to authenticated;
grant select, insert, update on table public.messages_v2_settings to service_role;

create or replace function public.messages_v2_hold_buckets(
  p_org_id uuid,
  p_bucket text,
  p_limit integer default 300,
  p_offset integer default 0
) returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_cutover timestamptz;
  v_result jsonb;
begin
  if p_bucket not in ('new', 'backlog') then
    raise exception 'messages_v2_hold_buckets: bucket must be new or backlog' using errcode = '22023';
  end if;
  select s.backlog_before into v_cutover
  from public.messages_v2_settings s where s.org_id = p_org_id;
  if v_cutover is null then
    raise exception 'messages_v2_settings missing for org' using errcode = 'P0002';
  end if;

  with src as (
    select p.id as property_id, p.last_ai_escalation_at as ts
    from public.properties p
    where p.org_id = p_org_id and p.needs_human_attention = true
    union all
    select d.property_id, d.created_at
    from public.jev_lead_decisions d
    where d.org_id = p_org_id and d.status = 'pending'
    union all
    select r.property_id, r.created_at
    from public.ai_disposition_reviews r
    where r.org_id = p_org_id and r.status = 'pending'
    union all
    select a.property_id, a.created_at
    from public.ai_reply_drafts a
    where a.org_id = p_org_id and a.status = 'pending' and a.property_id is not null
  ),
  agg as (
    select property_id, max(ts) as ts
    from src
    where property_id is not null
    group by property_id
  ),
  eff as (
    select
      a.property_id,
      greatest(
        a.ts,
        (select max(m.created_at)
           from public.messages m
          where m.property_id = a.property_id
            and m.org_id = p_org_id
            and m.direction = 'inbound'
            and m.created_at >= v_cutover)
      ) as effective_start
    from agg a
  ),
  classified as (
    select e.property_id, e.effective_start,
           coalesce(e.effective_start >= v_cutover, false) as is_new
    from eff e
  ),
  counts as (
    select count(*) filter (where is_new) as new_total,
           count(*) filter (where not is_new) as backlog_total
    from classified
  ),
  page as (
    select c.property_id, c.effective_start
    from classified c
    where c.is_new = (p_bucket = 'new')
    order by c.effective_start asc nulls first, c.property_id asc
    limit greatest(p_limit, 0) offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'cutover', v_cutover,
    'new_total', (select new_total from counts),
    'backlog_total', (select backlog_total from counts),
    'rows', coalesce(
      (select jsonb_agg(jsonb_build_object(
          'property_id', pg.property_id, 'effective_start', pg.effective_start)
          order by pg.effective_start asc nulls first, pg.property_id asc)
         from page pg),
      '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.messages_v2_hold_buckets(uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.messages_v2_hold_buckets(uuid, text, integer, integer)
  to authenticated, service_role;

do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.reset_tenant_tables()'::regprocedure);
  v_new := replace(v_def, E'    public.hold_alert_deliveries,', E'    public.hold_alert_deliveries,\n    public.messages_v2_settings,');
  if v_new = v_def then raise exception 'reset_tenant_tables messages_v2_settings patch not applied'; end if;
  execute v_new;
end $$;

commit;
