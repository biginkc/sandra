begin;

alter table public.message_threads
  add column if not exists ai_responder_debounce_until timestamptz,
  add column if not exists ai_responder_debounce_token uuid;

create or replace function public.claim_ai_responder_thread_debounce(
  p_conversation_id uuid,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim_token uuid := gen_random_uuid();
  v_claimed_token uuid;
  v_thread_exists boolean := false;
begin
  if p_window_seconds <= 0 then
    raise exception 'p_window_seconds must be positive'
      using errcode = '22023';
  end if;

  with thread_source as (
    select
      m.org_id,
      m.contact_id,
      m.property_id,
      m.created_at
    from public.messages m
    where m.channel = 'sms'
      and m.conversation_id = p_conversation_id
      and m.contact_id is not null
      and m.property_id is not null
    order by m.created_at asc, m.id asc
    limit 1
  )
  insert into public.message_threads (
    org_id,
    channel,
    contact_id,
    property_id,
    conversation_id,
    created_at,
    updated_at
  )
  select
    ts.org_id,
    'sms',
    ts.contact_id,
    ts.property_id,
    p_conversation_id,
    ts.created_at,
    now()
  from thread_source ts
  on conflict (channel, contact_id, property_id) do update
  set
    updated_at = now();

  if exists (
    select 1
    from public.messages m
    where m.channel = 'sms'
      and m.conversation_id = p_conversation_id
      and m.direction = 'outbound'
      and m.status in ('sent', 'queued')
      and m.metadata ->> 'generated_by' = 'ai_responder_v1'
      and m.created_at >= now() - make_interval(secs => p_window_seconds)
  ) then
    return jsonb_build_object('status', 'duplicate');
  end if;

  select exists (
    select 1
    from public.message_threads mt
    where mt.conversation_id = p_conversation_id
  ) into v_thread_exists;

  if not v_thread_exists then
    return jsonb_build_object('status', 'unavailable');
  end if;

  update public.message_threads mt
  set
    ai_responder_debounce_until = now() + make_interval(secs => p_window_seconds),
    ai_responder_debounce_token = v_claim_token,
    updated_at = now()
  where mt.conversation_id = p_conversation_id
    and coalesce(
      mt.ai_responder_debounce_until,
      '-infinity'::timestamptz
    ) < now()
  returning mt.ai_responder_debounce_token into v_claimed_token;

  if not found or v_claimed_token is null then
    return jsonb_build_object('status', 'busy');
  end if;

  return jsonb_build_object(
    'status', 'claimed',
    'token', v_claimed_token::text
  );
end;
$$;

create or replace function public.release_ai_responder_thread_debounce(
  p_conversation_id uuid,
  p_claim_token uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.message_threads mt
  set
    ai_responder_debounce_until = null,
    ai_responder_debounce_token = null,
    updated_at = now()
  where mt.conversation_id = p_conversation_id
    and mt.ai_responder_debounce_token = p_claim_token;
end;
$$;

revoke execute on function public.claim_ai_responder_thread_debounce(uuid, integer) from public;
revoke execute on function public.claim_ai_responder_thread_debounce(uuid, integer) from anon;
revoke execute on function public.claim_ai_responder_thread_debounce(uuid, integer) from authenticated;
grant execute on function public.claim_ai_responder_thread_debounce(uuid, integer) to service_role;

revoke execute on function public.release_ai_responder_thread_debounce(uuid, uuid) from public;
revoke execute on function public.release_ai_responder_thread_debounce(uuid, uuid) from anon;
revoke execute on function public.release_ai_responder_thread_debounce(uuid, uuid) from authenticated;
grant execute on function public.release_ai_responder_thread_debounce(uuid, uuid) to service_role;

commit;
