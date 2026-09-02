begin;

create or replace function public.resolve_esign_send_unknown_not_sent(
  p_org_id uuid,
  p_request_id uuid,
  p_actor_id uuid,
  p_resolution_source text,
  p_error_message text,
  p_evidence jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.esign_requests%rowtype;
  v_event_type text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_resolution_source not in ('automatic', 'operator')
     or (p_resolution_source = 'operator' and p_actor_id is null)
     or (p_resolution_source = 'automatic' and p_actor_id is not null)
     or coalesce(p_error_message, '') !~ '^[A-Z][A-Z0-9_]{0,127}$'
     or jsonb_typeof(coalesce(p_evidence, '{}'::jsonb)) <> 'object'
     or coalesce(p_evidence ->> 'positiveControl', '') <> 'passed' then
    raise exception 'invalid eSign send-not-found resolution'
      using errcode = '23514';
  end if;

  select request.* into v_request
  from public.esign_requests request
  where request.id = p_request_id
    and request.org_id = p_org_id
  for update;
  if not found then
    raise exception 'eSign request not found' using errcode = 'P0002';
  end if;
  if v_request.delivery_state <> 'send_unknown'
     or v_request.sign_request_id is not null then
    raise exception 'eSign request is not an unresolved unknown send'
      using errcode = '55000';
  end if;

  update public.esign_requests
  set delivery_state = 'failed',
      status = 'error',
      completed_at = now(),
      error_message = p_error_message,
      updated_by = p_actor_id,
      updated_at = now()
  where id = p_request_id
    and org_id = p_org_id
    and delivery_state = 'send_unknown'
    and sign_request_id is null;
  if not found then
    raise exception 'eSign request is not an unresolved unknown send'
      using errcode = '55000';
  end if;

  v_event_type := case p_resolution_source
    when 'operator' then 'esign_send_not_found_operator'
    else 'esign_send_not_found_automatic'
  end;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload,
    source_type, source_id
  ) values (
    p_org_id,
    v_request.property_id,
    case when p_resolution_source = 'operator' then 'user' else 'system' end,
    p_actor_id,
    v_event_type,
    jsonb_build_object(
      'request_id', p_request_id,
      'error_message', p_error_message,
      'evidence', coalesce(p_evidence, '{}'::jsonb)
    ),
    null,
    null
  );
end;
$$;

revoke all on function public.resolve_esign_send_unknown_not_sent(
  uuid, uuid, uuid, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.resolve_esign_send_unknown_not_sent(
  uuid, uuid, uuid, text, text, jsonb
) to service_role;

comment on function public.resolve_esign_send_unknown_not_sent(
  uuid, uuid, uuid, text, text, jsonb
) is
  'Service-role positive-evidence resolver for eSign sends stuck in send_unknown. Requires a passing provider positive control and records either operator or automatic audit evidence before making the request retryable.';

commit;
