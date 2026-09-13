begin;
alter table public.dialpad_voice_intents drop constraint dialpad_voice_intents_status_check;
alter table public.dialpad_voice_intents add constraint dialpad_voice_intents_status_check
  check (status in ('prepared','initiation_unconfirmed','linked','completed','failed','cancelled'));
create unique index dialpad_voice_one_active_intent_per_actor_idx
  on public.dialpad_voice_intents(org_id,actor_user_id) where status in ('prepared','initiation_unconfirmed','linked');

-- A terminal call activity is written only by trusted receipt normalization.
-- This trigger also handles replay enrichment; an earlier event cannot reopen it.
create function public.dialpad_complete_terminal_intent()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.provider='dialpad' and new.provider_ended_at is not null and new.provider_ended_at>=new.started_at then
    update public.dialpad_voice_intents set status='completed' where org_id=new.org_id
      and provider_call_id=new.provider_call_id and status in ('prepared','initiation_unconfirmed','linked');
  end if;
  return new;
end;
$$;
revoke all on function public.dialpad_complete_terminal_intent() from public,anon,authenticated,service_role;
create trigger dialpad_complete_terminal_intent after insert or update of provider_ended_at on public.call_activities
  for each row execute function public.dialpad_complete_terminal_intent();

create function public.dialpad_guard_completed_intent()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.status='completed' and new.status<>'completed' then
    raise exception 'DIALPAD_COMPLETED_INTENT_IMMUTABLE' using errcode='23514';
  end if;
  if new.status='completed' and old.status<>'completed' and not exists(
    select 1 from public.call_activities c where c.org_id=new.org_id and c.provider='dialpad'
      and c.provider_call_id=new.provider_call_id and c.operator_user_id=new.actor_user_id
      and c.property_id=new.property_id and c.provider_ended_at is not null and c.provider_ended_at>=c.started_at
  ) then raise exception 'DIALPAD_TERMINAL_EVIDENCE_REQUIRED' using errcode='23514'; end if;
  -- No cancellation producer exists yet. Keep ambiguous calls reserved.
  if old.status in ('prepared','initiation_unconfirmed','linked') and new.status='cancelled' then
    raise exception 'DIALPAD_CANCELLATION_EVIDENCE_REQUIRED' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function public.dialpad_guard_completed_intent() from public,anon,authenticated,service_role;
create trigger dialpad_guard_completed_intent before update on public.dialpad_voice_intents
  for each row execute function public.dialpad_guard_completed_intent();
commit;
