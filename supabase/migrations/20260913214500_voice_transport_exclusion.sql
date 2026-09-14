begin;
create table public.voice_jitter_start_reservations (
  org_id uuid not null, actor_user_id uuid not null, token text not null,
  property_id uuid, call_id text, dispatch_started boolean not null default false, released boolean not null default false,
  primary key(org_id,actor_user_id,token)
);
alter table public.voice_jitter_start_reservations enable row level security;
revoke all on public.voice_jitter_start_reservations from public,anon,authenticated,service_role;
create function public.fn_reserve_jitter_transport(p_org_id uuid,p_actor_id uuid,p_token text,p_property_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':voice-transport',0));
  if exists(select 1 from public.dialpad_voice_intents where org_id=p_org_id and status in ('prepared','initiation_unconfirmed','linked')
    and (actor_user_id=p_actor_id or property_id=p_property_id)) then
    raise exception 'VOICE_TRANSPORT_CONFLICT' using errcode='23514';
  end if;
  insert into public.voice_jitter_start_reservations(org_id,actor_user_id,token,property_id)
    values(p_org_id,p_actor_id,p_token,p_property_id) on conflict do nothing;
  if not exists(select 1 from public.voice_jitter_start_reservations where org_id=p_org_id and actor_user_id=p_actor_id and token=p_token and property_id is not distinct from p_property_id and not released) then
    raise exception 'VOICE_TRANSPORT_TOKEN_CONFLICT' using errcode='23514';
  end if;
end;
$$;
create function public.fn_mark_jitter_dispatch(p_org_id uuid,p_actor_id uuid,p_token text)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':voice-transport',0));
  update public.voice_jitter_start_reservations set dispatch_started=true
    where org_id=p_org_id and actor_user_id=p_actor_id and token=p_token and not released;
  if not found then raise exception 'VOICE_TRANSPORT_RESERVATION_LOST' using errcode='23514'; end if;
end;
$$;
revoke all on function public.fn_mark_jitter_dispatch(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_mark_jitter_dispatch(uuid,uuid,text) to service_role;
create function public.fn_finish_jitter_transport(p_org_id uuid,p_actor_id uuid,p_token text,p_call_id text default null,p_no_dispatch boolean default false)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':voice-transport',0));
  update public.voice_jitter_start_reservations set call_id=coalesce(call_id,p_call_id),released=case when p_no_dispatch and call_id is null and not dispatch_started then true else released end
    where org_id=p_org_id and actor_user_id=p_actor_id and token=p_token;
  update public.voice_jitter_start_reservations r set released=true
    where r.org_id=p_org_id and r.actor_user_id=p_actor_id and r.token=p_token and exists(
      select 1 from public.call_activities c where c.jitter_attempt_id='sandra-'||r.call_id and c.org_id=r.org_id
      and c.operator_user_id=r.actor_user_id and c.provider in ('sandra_softphone','jitter') and c.provider_ended_at is not null);
end;
$$;
create function public.dialpad_exclude_jitter_start() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status in ('prepared','initiation_unconfirmed','linked') then
    perform pg_advisory_xact_lock(hashtextextended(new.org_id::text||':voice-transport',0));
    if exists(select 1 from public.voice_jitter_start_reservations where org_id=new.org_id and not released and (actor_user_id=new.actor_user_id or property_id=new.property_id))
      or exists(select 1 from public.call_activities where org_id=new.org_id and provider in ('sandra_softphone','jitter') and provider_ended_at is null and started_at is not null and (operator_user_id=new.actor_user_id or property_id=new.property_id)) then
      raise exception 'VOICE_TRANSPORT_CONFLICT' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
-- Late authenticated evidence can reactivate a failed intent. Check that path
-- under the same lock; a conflict must be quarantined with its inbox receipt
-- retained for operator reconciliation, never silently treated as resolved.
create trigger dialpad_exclude_jitter_start before insert or update of status on public.dialpad_voice_intents for each row execute function public.dialpad_exclude_jitter_start();
create function public.release_jitter_transport_on_terminal() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.provider in ('sandra_softphone','jitter') and new.provider_ended_at is not null then
    update public.voice_jitter_start_reservations set released=true where org_id=new.org_id and actor_user_id=new.operator_user_id and 'sandra-'||call_id=new.jitter_attempt_id;
  end if;
  return new;
end;
$$;
create trigger release_jitter_transport_on_terminal after insert or update on public.call_activities for each row execute function public.release_jitter_transport_on_terminal();
revoke all on function public.fn_reserve_jitter_transport(uuid,uuid,text,uuid),public.fn_finish_jitter_transport(uuid,uuid,text,text,boolean),public.dialpad_exclude_jitter_start(),public.release_jitter_transport_on_terminal() from public,anon,authenticated;
grant execute on function public.fn_reserve_jitter_transport(uuid,uuid,text,uuid),public.fn_finish_jitter_transport(uuid,uuid,text,text,boolean) to service_role;
commit;
