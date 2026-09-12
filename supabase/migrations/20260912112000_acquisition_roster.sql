begin;
create or replace function public.fn_get_acquisition_roster(p_org_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_owner boolean;
  v_members jsonb;
  v_settings jsonb;
begin
  select role='owner' into v_owner from public.memberships
    where org_id=p_org_id and user_id=auth.uid() and access_status='active' and deletion_prepared_at is null
      and (access_expires_at is null or access_expires_at>statement_timestamp());
  if not found then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',m.user_id,
    'label',coalesce(nullif(btrim(u.raw_user_meta_data->>'full_name'),''),nullif(btrim(u.raw_user_meta_data->>'name'),''),u.email,m.user_id::text),
    'role',m.role,'acquisitionsEnabled',m.acquisitions_enabled,
    'active',m.access_status='active' and m.deletion_prepared_at is null and (m.access_expires_at is null or m.access_expires_at>statement_timestamp()),
    'hasHistory',exists(select 1 from public.acquisition_assignment_episodes e where e.org_id=p_org_id and e.assignee_user_id=m.user_id and (e.eligible or e.episode_kind='launch'))
  ) order by m.user_id),'[]') into v_members
    from public.memberships m join auth.users u on u.id=m.user_id
    where m.org_id=p_org_id and (v_owner or m.user_id=auth.uid());
  -- Keep the owner-only recipientId for settings mutation/UI compatibility.  A
  -- member must still be able to render the lifecycle handoff selector, but
  -- receives only the configured recipient (never the full same-org roster).
  select jsonb_build_object(
    'enabled',s.my_leads_enabled,
    'recipientId',case when v_owner then s.needs_sequence_owner_id end,
    'recipient',case when rm.user_id is null then null else jsonb_build_object(
      'id',rm.user_id,
      'label',coalesce(nullif(btrim(ru.raw_user_meta_data->>'full_name'),''),nullif(btrim(ru.raw_user_meta_data->>'name'),''),ru.email,rm.user_id::text)
    ) end,
    'revision',s.settings_revision
  )
    into v_settings
    from public.acquisition_org_settings s
    left join public.memberships rm on rm.org_id=s.org_id
      and rm.user_id=s.needs_sequence_owner_id
      and rm.access_status='active'
      and rm.deletion_prepared_at is null
      and (rm.access_expires_at is null or rm.access_expires_at>statement_timestamp())
    left join auth.users ru on ru.id=rm.user_id
    where s.org_id=p_org_id;
  return jsonb_build_object('isOwner',v_owner,'members',v_members,
    'settings',coalesce(v_settings,jsonb_build_object('enabled',false,'recipientId',null,'recipient',null,'revision',0)));
end;
$$;
revoke all on function public.fn_get_acquisition_roster(uuid) from public,anon;
grant execute on function public.fn_get_acquisition_roster(uuid) to authenticated;
commit;
