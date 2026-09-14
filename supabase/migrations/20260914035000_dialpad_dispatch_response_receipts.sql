begin;
create table public.dialpad_dispatch_response_receipts (
 org_id uuid not null, intent_id uuid not null, actor_user_id uuid not null,
 candidate_call_id text not null check(candidate_call_id ~ '^[0-9]{1,40}$'),
 received_at timestamptz not null default clock_timestamp(),
 primary key(org_id,intent_id),
 foreign key(org_id,intent_id) references public.dialpad_intent_configuration(org_id,intent_id) on delete restrict
);
comment on table public.dialpad_dispatch_response_receipts is 'Authenticated successful POST response candidate only. No acquisition evidence or permission to redispatch. Frozen configuration remains on referenced intent sidecar.';
create trigger dialpad_dispatch_response_immutable before update or delete on public.dialpad_dispatch_response_receipts for each row execute function public.dialpad_history_immutable();
alter table public.dialpad_dispatch_response_receipts enable row level security;
revoke all on public.dialpad_dispatch_response_receipts from public,anon,authenticated,service_role;
grant select on public.dialpad_dispatch_response_receipts to service_role;
create function public.fn_record_dialpad_dispatch_response(p_org_id uuid,p_actor_id uuid,p_intent_id uuid,p_candidate_call_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.dialpad_voice_intents%rowtype; existing public.dialpad_dispatch_response_receipts%rowtype;
begin
 if p_org_id is null or p_actor_id is null or p_intent_id is null or p_candidate_call_id is null
 or p_candidate_call_id !~ '^[0-9]{1,40}$' then raise exception 'DIALPAD_RESPONSE_INPUT_INVALID' using errcode='22023'; end if;
 select * into i from public.dialpad_voice_intents where org_id=p_org_id and id=p_intent_id and actor_user_id=p_actor_id for update;
 if not found or not exists(select 1 from public.dialpad_intent_configuration where org_id=p_org_id and intent_id=p_intent_id)
 or not exists(select 1 from public.dialpad_sequence_pause_controls where intent_id=p_intent_id and dispatch_started) then
 raise exception 'DIALPAD_RESPONSE_DISPATCH_REQUIRED' using errcode='42501'; end if;
 -- Do not consult current grants/membership: a delayed response belongs to the
 -- frozen historical dispatcher, even if authorization has since been revoked.
 select * into existing from public.dialpad_dispatch_response_receipts where org_id=p_org_id and intent_id=p_intent_id;
 if found then
 if existing.candidate_call_id<>p_candidate_call_id or existing.actor_user_id<>p_actor_id then
 raise exception 'DIALPAD_RESPONSE_CANDIDATE_CONFLICT' using errcode='23514'; end if;
 return jsonb_build_object('recorded',true,'duplicate',true);
 end if;
 insert into public.dialpad_dispatch_response_receipts(org_id,intent_id,actor_user_id,candidate_call_id)
 values(p_org_id,p_intent_id,p_actor_id,p_candidate_call_id);
 return jsonb_build_object('recorded',true,'duplicate',false);
end $$;
revoke all on function public.fn_record_dialpad_dispatch_response(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_record_dialpad_dispatch_response(uuid,uuid,uuid,text) to service_role;
commit;
