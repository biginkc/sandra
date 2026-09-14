begin;
alter table public.dialpad_inventory_verifications add constraint dialpad_inventory_org_identity unique(org_id,id);
create table public.dialpad_intent_configuration (
 org_id uuid not null,intent_id uuid not null,
 connection_id uuid not null,connection_version bigint not null,
 binding_id uuid not null,binding_revision bigint not null,
 grant_id uuid not null,grant_revision bigint not null,
 verification_id uuid not null,
 device_id text not null check(length(btrim(device_id)) between 1 and 512 and device_id !~ '[\r\n]'),
 device_type text not null default 'native' check(device_type='native'),
 device_verified_at timestamptz not null check(isfinite(device_verified_at)),
 created_at timestamptz not null default statement_timestamp(),
 primary key(org_id,intent_id),
 foreign key(intent_id,org_id) references public.dialpad_voice_intents(id,org_id) on delete restrict,
 foreign key(org_id,connection_id,connection_version) references public.dialpad_connection_revisions(org_id,connection_id,config_version) on delete restrict,
 foreign key(org_id,binding_id) references public.dialpad_member_bindings(org_id,id) on delete restrict,
 foreign key(org_id,grant_id) references public.dialpad_number_grants(org_id,id) on delete restrict,
 foreign key(org_id,verification_id) references public.dialpad_inventory_verifications(org_id,id) on delete restrict
);
create trigger dialpad_intent_configuration_immutable before update or delete on public.dialpad_intent_configuration for each row execute function public.dialpad_history_immutable();
alter table public.dialpad_intent_configuration enable row level security;
revoke all on public.dialpad_intent_configuration from public,anon,authenticated,service_role;
grant select on public.dialpad_intent_configuration to service_role;
-- Service caller must obtain actor from session, verify native device ownership,
-- and retain a fresh provider inventory receipt. No provider request is dispatched.
create function public.fn_prepare_dialpad_configured_intent(
 p_org_id uuid,p_actor_id uuid,p_property_id uuid,p_intent_id uuid,p_idempotency_key uuid,
 p_grant_id uuid,p_verification_id uuid,p_device_id text,p_device_verified_at timestamptz,p_destination_e164 text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.dialpad_org_connections%rowtype;b public.dialpad_member_bindings%rowtype;
 g public.dialpad_number_grants%rowtype;v public.dialpad_inventory_verifications%rowtype;
 existing public.dialpad_voice_intents%rowtype;s public.dialpad_intent_configuration%rowtype;
 context jsonb;binding_hash text;
begin
 if p_org_id is null or p_actor_id is null or p_property_id is null or p_intent_id is null or p_idempotency_key is null
 or p_grant_id is null or p_verification_id is null or p_device_id is null or length(btrim(p_device_id)) not between 1 and 512
 or p_device_id ~ '[\r\n]' or p_device_verified_at is null or not isfinite(p_device_verified_at)
 or p_device_verified_at>statement_timestamp() or p_device_verified_at<statement_timestamp()-interval '5 minutes' then
 raise exception 'DIALPAD_PREPARE_INPUT_INVALID' using errcode='22023'; end if;
 select * into c from public.dialpad_org_connections where org_id=p_org_id for update;
 if not found or not c.enabled or c.verified_at is null then raise exception 'DIALPAD_PREPARE_CONNECTION_UNAVAILABLE' using errcode='42501'; end if;
 perform 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and acquisitions_enabled and access_status='active'
 and deletion_prepared_at is null and (access_expires_at is null or access_expires_at>statement_timestamp()) for share;
 if not found then raise exception 'DIALPAD_PREPARE_MEMBER_UNAVAILABLE' using errcode='42501'; end if;
 perform 1 from public.acquisition_org_settings where org_id=p_org_id and my_leads_enabled for share;
 if not found then raise exception 'DIALPAD_PREPARE_ACQUISITIONS_DISABLED' using errcode='42501'; end if;
 select * into b from public.dialpad_member_bindings where org_id=p_org_id and member_user_id=p_actor_id
 and connection_id=c.id and connection_version=c.config_version and revoked_at is null for share;
 if not found then raise exception 'DIALPAD_PREPARE_BINDING_UNAVAILABLE' using errcode='42501'; end if;
 select * into g from public.dialpad_number_grants where org_id=p_org_id and id=p_grant_id and binding_id=b.id and revoked_at is null for share;
 if not found then raise exception 'DIALPAD_PREPARE_GRANT_UNAVAILABLE' using errcode='42501'; end if;
 select * into v from public.dialpad_inventory_verifications where id=p_verification_id and org_id=p_org_id;
 if not found or row(v.connection_id,v.connection_version,v.provider_company_id,v.member_user_id,v.provider_user_id)
 is distinct from row(c.id,c.config_version,c.provider_company_id,p_actor_id,b.provider_user_id)
 or v.verified_at<statement_timestamp()-interval '5 minutes'
 or not v.callers @> jsonb_build_array(jsonb_build_object('identity_type',g.identity_type,'provider_identity_id',g.provider_identity_id,'number_e164',g.number_e164)) then
 raise exception 'DIALPAD_PREPARE_VERIFICATION_UNAVAILABLE' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':voice-transport',0));
 select * into existing from public.dialpad_voice_intents where org_id=p_org_id and actor_user_id=p_actor_id and client_idempotency_key=p_idempotency_key for update;
 if found then
 select * into s from public.dialpad_intent_configuration where org_id=p_org_id and intent_id=existing.id;
 if existing.id<>p_intent_id or existing.property_id<>p_property_id or existing.destination_e164 is distinct from p_destination_e164 or s.grant_id is distinct from p_grant_id or s.device_id is distinct from p_device_id then
 raise exception 'DIALPAD_PREPARE_IDEMPOTENCY_CONFLICT' using errcode='23514'; end if;
 return jsonb_build_object('intentId',existing.id,'status',existing.status,'duplicate',true);
 end if;
 binding_hash:=encode(extensions.digest(p_intent_id::text,'sha256'),'hex');
 select result into context from public.acquisition_commands where org_id=p_org_id and operation='bind_call_context' and context_key_hash=binding_hash;
 if context is null or context->>'orgId' is distinct from p_org_id::text or context->>'propertyId' is distinct from p_property_id::text
 or context->>'actorUserId' is distinct from p_actor_id::text or context->>'assignmentEpisodeId' is null then
 raise exception 'DIALPAD_PREPARE_CONTEXT_UNAVAILABLE' using errcode='42501'; end if;
 perform 1 from public.properties where org_id=p_org_id and id=p_property_id and assigned_user_id=p_actor_id
 and deleted_at is null and not coalesce(is_dnc_locked,false) and status::text not in ('dnc','dead','closed') for update;
 if not found then raise exception 'DIALPAD_PREPARE_LEAD_UNAVAILABLE' using errcode='42501'; end if;
 perform 1 from public.acquisition_assignment_episodes where id=(context->>'assignmentEpisodeId')::uuid and org_id=p_org_id
 and property_id=p_property_id and assignee_user_id=p_actor_id and ended_at is null for share;
 if not found then raise exception 'DIALPAD_PREPARE_EPISODE_UNAVAILABLE' using errcode='42501'; end if;
 -- The call binding freezes attribution, not a phone. Server eligibility supplies
 -- a selected E.164; require it still belongs to the locked homeowner contact.
 if coalesce(p_destination_e164,'') !~ '^\+[1-9][0-9]{1,14}$' then raise exception 'DIALPAD_PREPARE_DESTINATION_UNAVAILABLE' using errcode='42501'; end if;
 perform 1 from public.contacts contact join public.properties p on p.homeowner_contact_id=contact.id and p.org_id=contact.org_id
 where p.id=p_property_id and p.org_id=p_org_id and not coalesce(contact.do_not_contact,false)
 and p_destination_e164 in(contact.phone_1,contact.phone_2,contact.phone_3) for share of contact;
 if not found then raise exception 'DIALPAD_PREPARE_DESTINATION_UNAVAILABLE' using errcode='42501'; end if;
 insert into public.dialpad_voice_intents(id,org_id,actor_user_id,property_id,assignment_episode_id,binding_token_hash,dialpad_user_id,destination_e164,caller_id_e164,client_idempotency_key)
 values(p_intent_id,p_org_id,p_actor_id,p_property_id,(context->>'assignmentEpisodeId')::uuid,binding_hash,b.provider_user_id,p_destination_e164,g.number_e164,p_idempotency_key);
 insert into public.dialpad_intent_configuration(org_id,intent_id,connection_id,connection_version,binding_id,binding_revision,grant_id,grant_revision,verification_id,device_id,device_verified_at)
 values(p_org_id,p_intent_id,c.id,c.config_version,b.id,b.revision,g.id,g.revision,v.id,p_device_id,p_device_verified_at);
 return jsonb_build_object('intentId',p_intent_id,'status','prepared','duplicate',false);
end $$;
revoke all on function public.fn_prepare_dialpad_configured_intent(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.fn_prepare_dialpad_configured_intent(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz,text) to service_role;
commit;
