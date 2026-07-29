-- A revoked Sandra grant is terminal. An out-of-order suspend must not turn
-- revoked back into suspended, because a later reactivate could then restore
-- access.

begin;

select pg_advisory_xact_lock(
  hashtextextended('hugo-sandra-privileged-lifecycle-v1', 0)
);

do $install_terminal_revocation$
declare
  v_signature regprocedure :=
    'public.hugo_apply_access(uuid,text,text,jsonb,text,timestamptz)'::regprocedure;
  v_definition text := pg_get_functiondef(v_signature);
  v_installed text;
  v_old_pattern constant text :=
    $pattern$elsif[[:space:]]+v_membership\.access_status[[:space:]]*=[[:space:]]*'revoked'[[:space:]]+and[[:space:]]+p_status[[:space:]]*=[[:space:]]*'active'[[:space:]]+then$pattern$;
  v_new_pattern constant text :=
    $pattern$elsif[[:space:]]+v_membership\.access_status[[:space:]]*=[[:space:]]*'revoked'[[:space:]]+and[[:space:]]+p_status[[:space:]]*<>[[:space:]]*'revoked'[[:space:]]+then$pattern$;
  v_old_message constant text :=
    'A revoked Sandra grant cannot be reactivated.';
  v_new_message constant text :=
    'A revoked Sandra grant is terminal and cannot change status.';
begin
  if regexp_count(v_definition, v_new_pattern, 1, 'i') = 1
     and regexp_count(v_definition, v_old_pattern, 1, 'i') = 0
     and position(v_new_message in v_definition) > 0 then
    return;
  end if;

  if regexp_count(v_definition, v_old_pattern, 1, 'i') <> 1
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
    E'elsif v_membership.access_status = ''revoked''\n    and p_status <> ''revoked'' then',
    'i'
  );
  v_definition := replace(v_definition, v_old_message, v_new_message);
  execute v_definition;

  v_installed := pg_get_functiondef(v_signature);
  if regexp_count(v_installed, v_new_pattern, 1, 'i') <> 1
     or regexp_count(v_installed, v_old_pattern, 1, 'i') <> 0
     or position(v_new_message in v_installed) = 0 then
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
