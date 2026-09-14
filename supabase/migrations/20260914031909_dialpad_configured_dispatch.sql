begin;
-- Service-only claim; a successful return authorizes one external dispatch, not
-- a completed call. Never retry HTTP merely because the caller lost its response.
create function public.fn_dispatch_configured_dialpad_intent(p_org_id uuid,p_actor_id uuid,p_intent_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.dialpad_intent_configuration%rowtype;c public.dialpad_org_connections%rowtype;
 b public.dialpad_member_bindings%rowtype;g public.dialpad_number_grants%rowtype;
 i public.dialpad_voice_intents%rowtype;v public.dialpad_inventory_verifications%rowtype;
 control public.dialpad_sequence_pause_controls%rowtype;
begin
 if p_org_id is null or p_actor_id is null or p_intent_id is null then raise exception 'DIALPAD_DISPATCH_INPUT_INVALID' using errcode='22023'; end if;
 -- Sidecar is immutable: read it to establish lock targets before acquiring locks.
 select * into s from public.dialpad_intent_configuration where org_id=p_org_id and intent_id=p_intent_id;
 if not found then raise exception 'DIALPAD_DISPATCH_CONFIGURATION_MISSING' using errcode='42501'; end if;
 select * into c from public.dialpad_org_connections where org_id=p_org_id and id=s.connection_id for update;
 if not found or not c.enabled or c.verified_at is null or c.config_version<>s.connection_version then raise exception 'DIALPAD_DISPATCH_CONNECTION_CHANGED' using errcode='42501'; end if;
 perform 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and acquisitions_enabled and access_status='active'
 and deletion_prepared_at is null and (access_expires_at is null or access_expires_at>statement_timestamp()) for share;
 if not found then raise exception 'DIALPAD_DISPATCH_MEMBER_UNAVAILABLE' using errcode='42501'; end if;
 perform 1 from public.acquisition_org_settings where org_id=p_org_id and my_leads_enabled for share;
 if not found then raise exception 'DIALPAD_DISPATCH_ACQUISITIONS_DISABLED' using errcode='42501'; end if;
 select * into b from public.dialpad_member_bindings where org_id=p_org_id and id=s.binding_id and member_user_id=p_actor_id
 and connection_id=c.id and connection_version=c.config_version and revision=s.binding_revision and revoked_at is null for share;
 if not found then raise exception 'DIALPAD_DISPATCH_BINDING_CHANGED' using errcode='42501'; end if;
 select * into g from public.dialpad_number_grants where org_id=p_org_id and id=s.grant_id and binding_id=b.id and revision=s.grant_revision and revoked_at is null for share;
 if not found then raise exception 'DIALPAD_DISPATCH_GRANT_CHANGED' using errcode='42501'; end if;
 select * into v from public.dialpad_inventory_verifications where org_id=p_org_id and id=s.verification_id;
 if not found or row(v.connection_id,v.connection_version,v.member_user_id,v.provider_user_id,v.provider_company_id)
 is distinct from row(c.id,c.config_version,p_actor_id,b.provider_user_id,c.provider_company_id)
 or v.verified_at<statement_timestamp()-interval '5 minutes' or s.device_verified_at<statement_timestamp()-interval '5 minutes'
 or s.device_type<>'native' or not v.callers @> jsonb_build_array(jsonb_build_object('identity_type',g.identity_type,'provider_identity_id',g.provider_identity_id,'number_e164',g.number_e164)) then
 raise exception 'DIALPAD_DISPATCH_VERIFICATION_STALE' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':voice-transport',0));
 select * into i from public.dialpad_voice_intents where org_id=p_org_id and id=p_intent_id and actor_user_id=p_actor_id for update;
 if not found or i.dialpad_user_id<>b.provider_user_id or i.caller_id_e164<>g.number_e164 then raise exception 'DIALPAD_DISPATCH_INTENT_MISMATCH' using errcode='42501'; end if;
 select * into control from public.dialpad_sequence_pause_controls where intent_id=i.id for update;
 if i.status<>'prepared' or control.prepared is distinct from true or control.dispatch_started or control.released then return jsonb_build_object('dispatched',false); end if;
 if exists(select 1 from public.dialer_batches where org_id=p_org_id and status in ('claimed','in_progress'))
 or exists(select 1 from public.voice_jitter_start_reservations where org_id=p_org_id and not released and (actor_user_id=p_actor_id or property_id=i.property_id)) then
 raise exception 'VOICE_TRANSPORT_CONFLICT' using errcode='23514'; end if;
 perform public.dialpad_require_start_eligibility(i);
 perform 1 from public.contacts contact join public.properties p on p.homeowner_contact_id=contact.id and p.org_id=contact.org_id
 where p.id=i.property_id and p.org_id=i.org_id and not coalesce(contact.do_not_contact,false)
 and i.destination_e164 in(contact.phone_1,contact.phone_2,contact.phone_3) for share of contact;
 if not found then raise exception 'DIALPAD_DISPATCH_DESTINATION_CHANGED' using errcode='42501'; end if;
 -- Earlier checks may have waited on row/advisory locks. Wall-clock expiry
 -- must be evaluated after all blocking locks, immediately before the claim.
 if v.verified_at<clock_timestamp()-interval '5 minutes'
 or s.device_verified_at<clock_timestamp()-interval '5 minutes'
 or exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id
   and access_expires_at is not null and access_expires_at<=clock_timestamp()) then
 raise exception 'DIALPAD_DISPATCH_VERIFICATION_EXPIRED' using errcode='42501'; end if;
 update public.dialpad_sequence_pause_controls set dispatch_started=true where intent_id=i.id;
 update public.dialpad_voice_intents set status='initiation_unconfirmed' where id=i.id;
 return jsonb_build_object('dispatched',true,'intentId',i.id,'connectionId',s.connection_id,'connectionVersion',s.connection_version,
 'credentialReference',c.credential_reference,'providerCompanyId',c.provider_company_id,'providerUserId',i.dialpad_user_id,
 'deviceId',s.device_id,'phoneNumber',i.destination_e164,'outboundCallerId',i.caller_id_e164,'identityType',g.identity_type,'identityId',g.provider_identity_id,'customData',i.id::text);
end $$;
revoke all on function public.fn_dispatch_configured_dialpad_intent(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_dispatch_configured_dialpad_intent(uuid,uuid,uuid) to service_role;
commit;
