-- switchboard_read.norma_lead_thread: every SMS on a property, for the text thread the operator opens under a seller
-- row on Switchboard's /norma page (Jarrad, 2026-11-22).
--
-- Read-only data view. It adds no business rule and changes no row.
--
-- The switchboard_read schema, its owner role (switchboard_read_owner), the reader login
-- (sandra_switchboard_reader) and the org-scoped owner RLS policies are created by Switchboard's operator script
-- (Switchboard repo: db/sandra/0001_switchboard_read.sql). This migration follows that script's pattern exactly, as
-- 20261119120000_switchboard_read_norma_interested_since did:
--   * the view is owned by switchboard_read_owner (nologin, no BYPASSRLS), so every base-table read runs as the owner
--     and is filtered by the owner's org-scoped RLS policy (switchboard_read_owner_select);
--   * security_barrier view with the org id baked in as a literal (defence in depth over RLS);
--   * the reader gets SELECT on the view only, never on a base table.
-- The org id is the one already pinned by the operator script's policy on public.properties, so this migration needs
-- no parameter.
--
-- On a database where the operator script was never run (fresh local/CI chains), this migration is a no-op.
--
-- No new base-table access: the view reads public.messages, which switchboard_read_owner already reads under the
-- operator script's org policy (asserted below, never changed). Message bodies already left Sandra in the transferred
-- Slack alert (switchboard_read.lead_last_sms); this view also shows them on Switchboard's operator-only /norma page.
-- Switchboard never stores or logs them.
--
-- Rows: inbound = every inbound SMS; outbound = only texts that actually went out (status sent/delivered, the same rule
-- as lead_last_sms), timed by coalesce(sent_at, created_at). Lookups by property_id use the existing
-- idx_messages_property_created_id (property_id, created_at desc, id desc) index.
--
-- Cross-repo contract: Switchboard's db/sandra/0001_switchboard_read.sql creates the identical view and reader grant.
-- Keep the view body byte-identical in both places (Switchboard pins its pg_get_viewdef md5).
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
    raise notice 'switchboard_read is not provisioned on this database; skipping switchboard_read.norma_lead_thread';
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
      raise exception 'switchboard_read_norma_lead_thread needs PostgreSQL 16+ (role membership SET/INHERIT options)';
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

  -- The owner must already read public.messages (operator script); this migration never grants base-table access.
  if not has_table_privilege('switchboard_read_owner', 'public.messages', 'SELECT') then
    raise exception 'switchboard_read_owner cannot read public.messages; re-run the Switchboard operator script first';
  end if;

  execute format($view$
    create or replace view switchboard_read.norma_lead_thread with (security_barrier = true) as
    select m.property_id::uuid as property_id,
           m.id::uuid as message_id,
           m.direction::text as direction,
           m.body::text as body,
           (case when m.direction = 'outbound' then coalesce(m.sent_at, m.created_at) else m.created_at end)::timestamptz as at
      from public.messages m
     where m.org_id = %1$L::uuid
       and m.property_id is not null
       and m.channel = 'sms'
       and (m.direction = 'inbound' or (m.direction = 'outbound' and m.status in ('sent', 'delivered')))
  $view$, v_org);

  alter view switchboard_read.norma_lead_thread owner to switchboard_read_owner;
  revoke all on switchboard_read.norma_lead_thread from public;
  grant select on switchboard_read.norma_lead_thread to sandra_switchboard_reader;

  -- Post-checks (same boundary as the operator script).
  select oid into v_reader from pg_roles where rolname = 'sandra_switchboard_reader';
  select string_agg(format('%I.%I', n.nspname, c.relname), ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'norma_private') and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and has_table_privilege(v_reader, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');
  if v_bad is not null then raise exception 'reader has privileges on base tables: %', v_bad; end if;
  if has_table_privilege(v_reader, 'switchboard_read.norma_lead_thread', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
    raise exception 'reader has write privileges on switchboard_read.norma_lead_thread';
  end if;

  if v_granted then
    execute format('revoke switchboard_read_owner from %1$I granted by %1$I', current_user);
  end if;
end
$migration$;
