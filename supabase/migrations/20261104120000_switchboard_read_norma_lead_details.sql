-- switchboard_read.norma_lead_details: the lead Norma is calling, for Switchboard's Norma page.
--
-- Read-only data view. It adds no business rule and changes no row.
--
-- The switchboard_read schema, its owner role (switchboard_read_owner), the reader login
-- (sandra_switchboard_reader) and the org-scoped owner RLS policies are created by Switchboard's operator script
-- (Switchboard repo: db/sandra/0001_switchboard_read.sql). This migration follows that script's pattern exactly:
--   * the view is owned by switchboard_read_owner (nologin, no BYPASSRLS), so every base-table read runs as the owner
--     and is filtered by the owner's org-scoped RLS policy (switchboard_read_owner_select);
--   * security_barrier view with the org id baked in as a literal (defence in depth over RLS);
--   * the reader gets SELECT on the view only, never on a base table.
-- The org id is the one already pinned by the operator script's policy on public.properties, so this migration needs
-- no parameter.
--
-- On a database where the operator script was never run (fresh local/CI chains), this migration is a no-op.
--
-- New base-table access: SELECT on public.call_activities for switchboard_read_owner, scoped by the same
-- org policy.
--
-- Cross-repo contract: Switchboard's db/sandra/0001_switchboard_read.sql creates the identical view, grant and policy
-- (call_activities in its base-table list; norma_lead_details in its reader grant). Release order: that script update
-- merges first, then this migration, then a re-run of the script must succeed and keep the reader's grant. Keep the
-- view body byte-identical in both places (Switchboard pins its pg_get_viewdef md5).
do $migration$
declare
  v_org uuid;
  v_reader oid;
  v_bad text;
  v_table text;
  v_granted boolean := false;
begin
  perform set_config('lock_timeout', '5s', true);
  if to_regnamespace('switchboard_read') is null
     or not exists (select 1 from pg_roles where rolname = 'switchboard_read_owner')
     or not exists (select 1 from pg_roles where rolname = 'sandra_switchboard_reader') then
    raise notice 'switchboard_read is not provisioned on this database; skipping switchboard_read.norma_lead_details';
    return;
  end if;

  -- The org pinned by the operator script. Every existing owner policy must agree on it.
  select (regexp_match(qual, '''([0-9a-fA-F-]{36})''::uuid'))[1]::uuid into v_org
    from pg_policies
   where schemaname = 'public' and tablename = 'properties' and policyname = 'switchboard_read_owner_select';
  if v_org is null then
    raise exception 'switchboard_read_owner_select policy on public.properties is missing or has no org literal';
  end if;
  foreach v_table in array array['contacts', 'messages', 'organizations'] loop
    if not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = v_table and policyname = 'switchboard_read_owner_select'
                      and qual = format('(%I = %L::uuid)', case v_table when 'organizations' then 'id' else 'org_id' end, v_org)) then
      raise exception 'switchboard_read_owner_select on public.% does not scope to org %', v_table, v_org;
    end if;
  end loop;

  -- Same owner-shape assertions as the operator script (asserted, never altered).
  if not exists (select 1 from pg_roles where rolname = 'switchboard_read_owner' and not rolcanlogin and not rolsuper
      and not rolcreatedb and not rolcreaterole and not rolinherit and not rolbypassrls and not rolreplication) then
    raise exception 'switchboard_read_owner exists with unexpected attributes';
  end if;
  -- Creating the view and handing it to the owner needs USAGE and SET on switchboard_read_owner. The operator script
  -- normally leaves that membership in place; if it is missing, grant it for this migration only and revoke it at the
  -- end, so the migration leaves role memberships exactly as it found them.
  if not (pg_has_role(current_user, 'switchboard_read_owner', 'USAGE')
          and pg_has_role(current_user, 'switchboard_read_owner', 'SET')) then
    if current_setting('server_version_num')::int < 160000 then
      raise exception 'switchboard_read_norma_lead_details needs PostgreSQL 16+ (role membership SET/INHERIT options)';
    end if;
    if exists (select 1 from pg_auth_members
                where roleid = 'switchboard_read_owner'::regrole and member = current_user::regrole
                  and grantor = current_user::regrole) then
      raise exception '% already holds a membership in switchboard_read_owner granted by itself, without USAGE and SET; fix it by hand', current_user;
    end if;
    execute 'grant switchboard_read_owner to current_user with inherit true, set true';
    v_granted := true;
  end if;

  -- Owner access to call activity, org-scoped exactly like the operator script's other base tables.
  revoke all on public.call_activities from switchboard_read_owner;
  grant select on public.call_activities to switchboard_read_owner;
  drop policy if exists switchboard_read_owner_select on public.call_activities;
  execute format('create policy switchboard_read_owner_select on public.call_activities for select to switchboard_read_owner using (org_id = %L::uuid)', v_org);

  -- One row per live, non-training property in the org. Lookups go by property_id; each lateral is a LIMIT 1 on an
  -- existing (property_id, ...) index: idx_messages_property_direction_created, idx_messages_property_created_id and
  -- call_activities_property_started_idx.
  execute format($view$
    create or replace view switchboard_read.norma_lead_details with (security_barrier = true) as
    select p.id::uuid as property_id,
           p.org_id::uuid as org_id,
           coalesce(nullif(btrim(concat_ws(' ', nullif(btrim(c.first_name), ''), nullif(btrim(c.last_name), ''))), ''),
                    nullif(btrim(c.entity_name), ''))::text as owner_full_name,
           p.address::text as address,
           p.city::text as city,
           p.state::text as state,
           p.zip::text as zip,
           p.beds::numeric as beds,
           p.baths::numeric as baths,
           p.sqft::numeric as sqft,
           p.year_built::integer as year_built,
           p.arv::numeric as arv,
           p.mortgage_balance::numeric as mortgage_balance,
           p.equity_estimate::numeric as equity_estimate,
           p.equity_pct::numeric as equity_pct,
           p.motivation_level::text as motivation_level,
           p.is_vacant::boolean as is_vacant,
           p.absentee_flag::boolean as absentee_flag,
           p.distress_flags::text[] as distress_flags,
           p.notes::text as notes,
           li.body::text as last_inbound_text,
           li.created_at::timestamptz as last_inbound_at,
           lc.at::timestamptz as last_contact_at,
           lc.kind::text as last_contact_kind
      from public.properties p
      left join public.contacts c on c.id = p.homeowner_contact_id and c.org_id = p.org_id
      -- Latest inbound seller text (same choice as switchboard_read.lead_last_sms).
      left join lateral (
        select m.body, m.created_at
          from public.messages m
         where m.org_id = p.org_id and m.property_id = p.id and m.channel = 'sms' and m.direction = 'inbound'
         order by m.created_at desc, m.id desc
         limit 1) li on true
      -- Latest contact of any kind: inbound text, outbound text that actually went out, or a call. Outbound is ordered by
      -- the time it reports (when it went out), so a text created early but sent late still counts as the latest; the
      -- per-property scan stays on the property_id index (a property's outbound history is small).
      left join lateral (
        select x.at, x.kind
          from (
            select li.created_at as at, 'text'::text as kind
             where li.created_at is not null
            union all
            (select coalesce(m.sent_at, m.created_at), 'text'::text
               from public.messages m
              where m.org_id = p.org_id and m.property_id = p.id and m.channel = 'sms' and m.direction = 'outbound'
                and m.status in ('sent', 'delivered')
              order by coalesce(m.sent_at, m.created_at) desc, m.id desc
              limit 1)
            union all
            (select ca.started_at, 'call'::text
               from public.call_activities ca
              where ca.org_id = p.org_id and ca.property_id = p.id and ca.started_at is not null
              order by ca.started_at desc nulls last
              limit 1)
          ) x
         order by x.at desc, x.kind
         limit 1) lc on true
     where p.org_id = %1$L::uuid
       and p.deleted_at is null
       and not p.is_training
  $view$, v_org);

  alter view switchboard_read.norma_lead_details owner to switchboard_read_owner;
  revoke all on switchboard_read.norma_lead_details from public;
  grant select on switchboard_read.norma_lead_details to sandra_switchboard_reader;

  -- Post-checks (same boundary as the operator script).
  select oid into v_reader from pg_roles where rolname = 'sandra_switchboard_reader';
  select string_agg(format('%I.%I', n.nspname, c.relname), ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'norma_private') and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and has_table_privilege(v_reader, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');
  if v_bad is not null then raise exception 'reader has privileges on base tables: %', v_bad; end if;
  if has_table_privilege(v_reader, 'switchboard_read.norma_lead_details', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
    raise exception 'reader has write privileges on switchboard_read.norma_lead_details';
  end if;

  if v_granted then
    execute 'revoke switchboard_read_owner from current_user granted by current_user';
  end if;
end
$migration$;
