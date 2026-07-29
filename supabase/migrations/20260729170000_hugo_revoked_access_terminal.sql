-- A revoked Sandra grant is terminal. An out-of-order suspend must not turn
-- revoked back into suspended, because a later reactivate could then restore
-- access.
-- Requires PostgreSQL 15 or newer for regexp_count().
-- The existing REVOKED_NOT_REACTIVATABLE receipt code is retained for connector
-- compatibility even though it now covers every changed terminal grant.

begin;

set local lock_timeout = '10s';

select pg_advisory_xact_lock(
  hashtextextended('hugo-sandra-privileged-lifecycle-v1', 0)
);

do $install_terminal_revocation$
declare
  v_signature regprocedure :=
    'public.hugo_apply_access(uuid,text,text,jsonb,text,timestamptz)'::regprocedure;
  v_definition text := pg_get_functiondef(v_signature);
  v_installed text;
  v_body_sha256 text;
  v_owner oid;
  v_preflight_owner oid;
  v_security_definer boolean;
  v_config text[];
  v_old_body_sha256 constant text :=
    '8037b3168964219172dc0c5607ef46e97dc2fad34dbda31c5204ed0042a68818';
  v_new_body_sha256 constant text :=
    'ce70f8c85614ec3bae4947e91068c55b8be02145603fa771fe9a18b9cc430e2d';
  v_old_pattern constant text :=
    $pattern$elsif[[:space:]]+v_membership\.access_status[[:space:]]*=[[:space:]]*'revoked'[[:space:]]+and[[:space:]]+p_status[[:space:]]*=[[:space:]]*'active'[[:space:]]+then$pattern$;
  v_new_pattern constant text :=
    $pattern$elsif[[:space:]]+v_membership\.access_status[[:space:]]*=[[:space:]]*'revoked'[[:space:]]+then$pattern$;
  v_old_message constant text :=
    'A revoked Sandra grant cannot be reactivated.';
  v_new_message constant text :=
    'A revoked Sandra grant is terminal and cannot be changed.';
begin
  -- prosrc is the body rendered inside pg_get_functiondef(). Normalize only
  -- line endings so every other byte remains covered by the fingerprint.
  select encode(
    extensions.digest(
      convert_to(
        replace(function_row.prosrc, E'\r\n', E'\n'),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
    into v_body_sha256
  from pg_catalog.pg_proc function_row
  where function_row.oid = v_signature;

  if v_body_sha256 = v_new_body_sha256 then
    null;
  else
    if v_body_sha256 is distinct from v_old_body_sha256
       or regexp_count(v_definition, v_old_pattern, 1, 'i') <> 1
       or regexp_count(v_definition, v_new_pattern, 1, 'i') <> 0
       or (
         length(v_definition) - length(replace(v_definition, v_old_message, ''))
       ) <> length(v_old_message) then
      raise exception 'HUGO_REVOKED_TERMINAL_INSTALL_STATE_CHANGED'
        using errcode = '55000';
    end if;

    v_definition := regexp_replace(
      v_definition,
      v_old_pattern,
      'elsif v_membership.access_status = ''revoked'' then',
      'i'
    );
    v_definition := replace(v_definition, v_old_message, v_new_message);
    execute v_definition;
  end if;

  select
    pg_get_functiondef(v_signature),
    encode(
      extensions.digest(
        convert_to(
          replace(function_row.prosrc, E'\r\n', E'\n'),
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    )
    into v_installed, v_body_sha256
  from pg_catalog.pg_proc function_row
  where function_row.oid = v_signature;

  if v_body_sha256 is distinct from v_new_body_sha256 then
    raise exception 'HUGO_REVOKED_TERMINAL_INSTALL_STATE_CHANGED'
      using errcode = '55000';
  end if;

  select function_row.proowner, function_row.prosecdef, function_row.proconfig
    into v_owner, v_security_definer, v_config
  from pg_catalog.pg_proc function_row
  where function_row.oid = v_signature;
  select function_row.proowner
    into v_preflight_owner
  from pg_catalog.pg_proc function_row
  where function_row.oid =
    'public.hugo_preflight_access_operation(uuid,text,text,jsonb,text,timestamptz)'::regprocedure;

  if regexp_count(v_installed, v_new_pattern, 1, 'i') <> 1
     or regexp_count(v_installed, v_old_pattern, 1, 'i') <> 0
     or position(v_new_message in v_installed) = 0
     or not v_security_definer
     or v_owner is distinct from v_preflight_owner
     or array_position(
       v_config,
       'search_path=public, auth, pg_temp'
     ) is null
     or regexp_count(
       v_installed,
       'hugo-sandra-privileged-lifecycle-v1',
       1,
       'i'
     ) <> 1
     or regexp_count(
       v_installed,
       $pattern$hugo_require_service_role\(\)$pattern$,
       1,
       'i'
     ) <> 1 then
    raise exception 'HUGO_REVOKED_TERMINAL_INSTALL_FAILED'
      using errcode = '55000';
  end if;
end
$install_terminal_revocation$;

revoke all on function public.hugo_apply_access(
  uuid, text, text, jsonb, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.hugo_apply_access(
  uuid, text, text, jsonb, text, timestamptz
) to service_role;

commit;
