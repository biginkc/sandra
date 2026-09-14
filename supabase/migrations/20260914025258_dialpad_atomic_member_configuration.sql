begin;
create table public.dialpad_configuration_commands (
 org_id uuid not null references public.organizations(id) on delete restrict,
 request_id uuid not null,
 owner_user_id uuid not null,
 request_sha256 text not null check(request_sha256 ~ '^[0-9a-f]{64}$'),
 result jsonb not null,
 created_at timestamptz not null default statement_timestamp(),
 primary key(org_id,request_id),
 foreign key(owner_user_id,org_id) references public.memberships(user_id,org_id) on delete restrict
);
alter table public.dialpad_configuration_commands enable row level security;
revoke all on public.dialpad_configuration_commands from public,anon,authenticated,service_role;
grant select on public.dialpad_configuration_commands to service_role;
create function public.fn_configure_dialpad_member(
 p_org_id uuid,p_owner_user_id uuid,p_member_user_id uuid,p_connection_id uuid,
 p_expected_connection_version bigint,p_provider_company_id text,p_provider_user_id text,
 p_verified_at timestamptz,p_callers jsonb,p_selected_callers jsonb,
 p_expected_binding_revision bigint,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 c public.dialpad_org_connections%rowtype; b public.dialpad_member_bindings%rowtype;
 v public.dialpad_inventory_verifications%rowtype; command public.dialpad_configuration_commands%rowtype;
 request_hash text; selected jsonb; entry jsonb; binding_id uuid; grant_id uuid;
 binding_revision bigint; grants jsonb:='[]'; result jsonb;
begin
 if p_org_id is null or p_owner_user_id is null or p_member_user_id is null or p_connection_id is null
  or p_request_id is null or p_expected_connection_version is null or p_expected_binding_revision is null
  or p_expected_binding_revision<0 then raise exception 'DIALPAD_CONFIGURATION_INPUT_INVALID' using errcode='22023'; end if;
 -- Owner identity is derived by the authenticated server before service RPC use.
 -- Lock ordering is connection -> memberships -> settings -> existing revisions.
 select * into c from public.dialpad_org_connections where org_id=p_org_id and id=p_connection_id for update;
 if not found then raise exception 'DIALPAD_CONFIGURATION_CONNECTION_UNAVAILABLE' using errcode='42501'; end if;
 perform 1 from public.memberships where org_id=p_org_id and user_id in(p_owner_user_id,p_member_user_id) order by user_id for share;
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_owner_user_id and role='owner'
  and access_status='active' and deletion_prepared_at is null and (access_expires_at is null or access_expires_at>statement_timestamp())) then
  raise exception 'DIALPAD_CONFIGURATION_OWNER_REQUIRED' using errcode='42501'; end if;
 if jsonb_typeof(p_selected_callers) is distinct from 'array' then raise exception 'DIALPAD_CONFIGURATION_SELECTION_INVALID' using errcode='22023'; end if;
 select coalesce(jsonb_agg(value order by value::text),'[]'::jsonb) into selected from(select distinct value from jsonb_array_elements(p_selected_callers)) entries;
 if jsonb_array_length(selected)=0 then raise exception 'DIALPAD_CONFIGURATION_SELECTION_INVALID' using errcode='22023'; end if;
 -- Replay identity is the stable owner command, not a subsequent provider read.
 request_hash:=encode(extensions.digest(convert_to(jsonb_build_object(
  'owner',p_owner_user_id,'member',p_member_user_id,'connection',p_connection_id,'version',p_expected_connection_version,
  'company',p_provider_company_id,'user',p_provider_user_id,
  'selected',selected,'expected_binding',p_expected_binding_revision
 )::text,'UTF8'),'sha256'),'hex');
 select * into command from public.dialpad_configuration_commands where org_id=p_org_id and request_id=p_request_id;
 if found then
  if command.request_sha256<>request_hash then raise exception 'DIALPAD_CONFIGURATION_IDEMPOTENCY_CONFLICT' using errcode='23514'; end if;
  return command.result;
 end if;
 if not c.enabled or c.verified_at is null or c.config_version<>p_expected_connection_version
  or c.provider_company_id is distinct from p_provider_company_id then
  raise exception 'DIALPAD_CONFIGURATION_CONNECTION_UNAVAILABLE' using errcode='42501'; end if;
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_member_user_id and acquisitions_enabled
  and access_status='active' and deletion_prepared_at is null and (access_expires_at is null or access_expires_at>statement_timestamp())) then
  raise exception 'DIALPAD_CONFIGURATION_MEMBER_UNAVAILABLE' using errcode='42501'; end if;
 perform 1 from public.acquisition_org_settings where org_id=p_org_id and my_leads_enabled for share;
 if not found then raise exception 'DIALPAD_CONFIGURATION_ACQUISITIONS_DISABLED' using errcode='42501'; end if;
 select * into b from public.dialpad_member_bindings where org_id=p_org_id and member_user_id=p_member_user_id and revoked_at is null for update;
 if coalesce(b.revision,0)<>p_expected_binding_revision then raise exception 'DIALPAD_CONFIGURATION_BINDING_STALE' using errcode='23514'; end if;
 -- This attestation is populated only after actual server provider verification.
 -- The RPC checks its normalized shape/provenance; it cannot itself call Dialpad.
 insert into public.dialpad_inventory_verifications(org_id,connection_id,connection_version,provider_company_id,
  member_user_id,provider_user_id,member_email_matched,callers,verified_at)
 values(p_org_id,p_connection_id,p_expected_connection_version,p_provider_company_id,p_member_user_id,p_provider_user_id,true,p_callers,p_verified_at)
 returning * into v;
 for entry in select value from jsonb_array_elements(selected) loop
  -- Equality (not JSON containment) disallows partial/extra selected fields.
  if not exists(select 1 from jsonb_array_elements(v.callers) x where x.value=entry) then
   raise exception 'DIALPAD_CONFIGURATION_SELECTION_INVALID' using errcode='22023'; end if;
 end loop;
 if b.id is not null then
  update public.dialpad_number_grants g set revoked_at=statement_timestamp() where g.org_id=p_org_id and g.binding_id=b.id and g.revoked_at is null;
  update public.dialpad_member_bindings set revoked_at=statement_timestamp() where id=b.id;
 end if;
 select coalesce(max(revision),0)+1 into binding_revision from public.dialpad_member_bindings where org_id=p_org_id and member_user_id=p_member_user_id;
 insert into public.dialpad_member_bindings(org_id,connection_id,connection_version,member_user_id,revision,provider_user_id,
  verification_reference,verification_sha256,verified_at)
 values(p_org_id,p_connection_id,p_expected_connection_version,p_member_user_id,binding_revision,p_provider_user_id,v.id,v.verification_sha256,v.verified_at)
 returning id into binding_id;
 for entry in select value from jsonb_array_elements(selected) loop
  insert into public.dialpad_number_grants(org_id,binding_id,revision,identity_type,provider_identity_id,number_e164,
   verification_reference,verification_sha256,verified_at)
  values(p_org_id,binding_id,1,entry->>'identity_type',entry->>'provider_identity_id',entry->>'number_e164',v.id,v.verification_sha256,v.verified_at)
  returning id into grant_id;
  grants:=grants||jsonb_build_array(jsonb_build_object('id',grant_id,'revision',1));
 end loop;
 result:=jsonb_build_object('bindingId',binding_id,'bindingRevision',binding_revision,'verificationId',v.id,'grants',grants);
 insert into public.dialpad_configuration_commands(org_id,request_id,owner_user_id,request_sha256,result)
 values(p_org_id,p_request_id,p_owner_user_id,request_hash,result);
 return result;
end $$;
revoke all on function public.fn_configure_dialpad_member(uuid,uuid,uuid,uuid,bigint,text,text,timestamptz,jsonb,jsonb,bigint,uuid) from public,anon,authenticated;
grant execute on function public.fn_configure_dialpad_member(uuid,uuid,uuid,uuid,bigint,text,text,timestamptz,jsonb,jsonb,bigint,uuid) to service_role;
-- Read-only retry lookup: member/connection may since have been revoked. Only
-- the currently active authenticated owner can retrieve their exact command.
create function public.fn_replay_dialpad_member_configuration(
 p_org_id uuid,p_owner_user_id uuid,p_member_user_id uuid,p_provider_user_id text,
 p_expected_connection_version bigint,p_expected_binding_revision bigint,p_selected_callers jsonb,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare command public.dialpad_configuration_commands%rowtype; v public.dialpad_inventory_verifications%rowtype; selected jsonb; request_hash text;
begin
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_owner_user_id and role='owner'
  and access_status='active' and deletion_prepared_at is null and (access_expires_at is null or access_expires_at>statement_timestamp())) then
  raise exception 'DIALPAD_CONFIGURATION_OWNER_REQUIRED' using errcode='42501'; end if;
 select * into command from public.dialpad_configuration_commands where org_id=p_org_id and request_id=p_request_id;
 if not found then return null; end if;
 if command.owner_user_id<>p_owner_user_id or jsonb_typeof(p_selected_callers) is distinct from 'array' then
  raise exception 'DIALPAD_CONFIGURATION_IDEMPOTENCY_CONFLICT' using errcode='23514'; end if;
 select * into v from public.dialpad_inventory_verifications where org_id=p_org_id and id=(command.result->>'verificationId')::uuid;
 if not found then raise exception 'DIALPAD_CONFIGURATION_EVIDENCE_UNAVAILABLE' using errcode='23514'; end if;
 select coalesce(jsonb_agg(value order by value::text),'[]'::jsonb) into selected from(select distinct value from jsonb_array_elements(p_selected_callers)) entries;
 request_hash:=encode(extensions.digest(convert_to(jsonb_build_object(
  'owner',p_owner_user_id,'member',p_member_user_id,'connection',v.connection_id,'version',p_expected_connection_version,
  'company',v.provider_company_id,'user',p_provider_user_id,'selected',selected,'expected_binding',p_expected_binding_revision
 )::text,'UTF8'),'sha256'),'hex');
 if command.request_sha256 is distinct from request_hash then raise exception 'DIALPAD_CONFIGURATION_IDEMPOTENCY_CONFLICT' using errcode='23514'; end if;
 return command.result;
end $$;
revoke all on function public.fn_replay_dialpad_member_configuration(uuid,uuid,uuid,text,bigint,bigint,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.fn_replay_dialpad_member_configuration(uuid,uuid,uuid,text,bigint,bigint,jsonb,uuid) to service_role;
commit;
