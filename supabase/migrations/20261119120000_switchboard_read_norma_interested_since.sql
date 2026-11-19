-- switchboard_read.norma_interested_since: when each property last became Interested, for the "Date added to Interested"
-- filter on Switchboard's /norma page (Jarrad, 2026-11-19).
--
-- Read-only data view. It adds no business rule and changes no row.
--
-- The switchboard_read schema, its owner role (switchboard_read_owner), the reader login
-- (sandra_switchboard_reader) and the org-scoped owner RLS policies are created by Switchboard's operator script
-- (Switchboard repo: db/sandra/0001_switchboard_read.sql). This migration follows that script's pattern exactly, as
-- 20261104120000_switchboard_read_norma_lead_details did:
--   * the view is owned by switchboard_read_owner (nologin, no BYPASSRLS), so every base-table read runs as the owner
--     and is filtered by the owner's org-scoped RLS policy (switchboard_read_owner_select);
--   * security_barrier view with the org id baked in as a literal (defence in depth over RLS);
--   * the reader gets SELECT on the view only, never on a base table.
-- The org id is the one already pinned by the operator script's policy on public.properties, so this migration needs
-- no parameter.
--
-- On a database where the operator script was never run (fresh local/CI chains), this migration is a no-op.
--
-- New base-table access: SELECT on public.lead_events for switchboard_read_owner, scoped by the same org policy.
--
-- Cross-repo contract: Switchboard's db/sandra/0001_switchboard_read.sql creates the identical view, grant and policy
-- (lead_events in its base-table list; norma_interested_since in its reader grant). Release order: that script update
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
    raise notice 'switchboard_read is not provisioned on this database; skipping switchboard_read.norma_interested_since';
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
      raise exception 'switchboard_read_norma_interested_since needs PostgreSQL 16+ (role membership SET/INHERIT options)';
    end if;
    if exists (select 1 from pg_auth_members
                where roleid = 'switchboard_read_owner'::regrole and member = current_user::regrole
                  and grantor = current_user::regrole) then
      raise exception '% already holds a membership in switchboard_read_owner granted by itself, without USAGE and SET; fix it by hand', current_user;
    end if;
    -- The role is named explicitly: GRANT/REVOKE ... CURRENT_USER segfaults the backend under some supautils builds
    -- (reproduced on supabase/postgres 17.6.1.143), which restarts the whole server.
    execute format('grant switchboard_read_owner to %I with inherit true, set true', current_user);
    v_granted := true;
  end if;

  -- Owner access to the lead activity ledger, org-scoped exactly like the operator script's other base tables.
  revoke all on public.lead_events from switchboard_read_owner;
  grant select on public.lead_events to switchboard_read_owner;
  drop policy if exists switchboard_read_owner_select on public.lead_events;
  execute format('create policy switchboard_read_owner_select on public.lead_events for select to switchboard_read_owner using (org_id = %L::uuid)', v_org);

  -- When each property last became Interested. Sandra records the move in public.lead_events: a status_changed
  -- event with payload->>'to' = 'interested', or a my_leads_workflow event with payload->>'operation' =
  -- 'ready_acquisition_offer'. The latest such event wins. A property with no such event has no row.
  -- The property_id lookup uses lead_events' existing (property_id, created_at desc) index.
  execute format($view$
    create or replace view switchboard_read.norma_interested_since with (security_barrier = true) as
    select e.property_id::uuid as property_id,
           max(e.created_at)::timestamptz as interested_at
      from public.lead_events e
     where e.org_id = %1$L::uuid
       and ((e.event_type = 'status_changed' and e.payload ->> 'to' = 'interested')
            or (e.event_type = 'my_leads_workflow' and e.payload ->> 'operation' = 'ready_acquisition_offer'))
     group by e.property_id
  $view$, v_org);

  alter view switchboard_read.norma_interested_since owner to switchboard_read_owner;
  revoke all on switchboard_read.norma_interested_since from public;
  grant select on switchboard_read.norma_interested_since to sandra_switchboard_reader;

  -- Post-checks (same boundary as the operator script).
  select oid into v_reader from pg_roles where rolname = 'sandra_switchboard_reader';
  select string_agg(format('%I.%I', n.nspname, c.relname), ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'norma_private') and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and has_table_privilege(v_reader, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');
  if v_bad is not null then raise exception 'reader has privileges on base tables: %', v_bad; end if;
  if has_table_privilege(v_reader, 'switchboard_read.norma_interested_since', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
    raise exception 'reader has write privileges on switchboard_read.norma_interested_since';
  end if;

  if v_granted then
    execute format('revoke switchboard_read_owner from %1$I granted by %1$I', current_user);
  end if;
end
$migration$;
