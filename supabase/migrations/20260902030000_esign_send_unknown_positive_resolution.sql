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
     or (
       p_resolution_source = 'automatic'
       and coalesce(p_evidence ->> 'positiveControl', '') <> 'passed'
     )
     or (
       p_resolution_source = 'operator'
       and coalesce(p_evidence ->> 'acknowledgedFailure', '') <> p_error_message
     ) then
    raise exception 'invalid eSign send-not-found resolution'
      using errcode = '23514';
  end if;
  if p_resolution_source = 'operator' then
    perform public.esign_require_active_owner(p_org_id, p_actor_id);
  end if;
  v_event_type := case p_resolution_source
    when 'operator' then 'esign_send_not_found_operator'
    else 'esign_send_not_found_automatic'
  end;

  select request.* into v_request
  from public.esign_requests request
  where request.id = p_request_id
    and request.org_id = p_org_id
  for update;
  if not found then
    raise exception 'eSign request not found' using errcode = 'P0002';
  end if;
  if p_resolution_source = 'automatic'
     and (v_request.delivery_state <> 'send_unknown'
       or v_request.sign_request_id is not null) then
    raise exception 'eSign request is not an unresolved unknown send'
      using errcode = '55000';
  end if;
  if p_resolution_source = 'operator'
     and (v_request.delivery_state <> 'failed'
       or v_request.sign_request_id is not null
       or v_request.error_message is distinct from p_error_message) then
    raise exception 'eSign request is not an evidenced failed send'
      using errcode = '55000';
  end if;
  if p_resolution_source = 'operator'
     and exists (
       select 1
       from public.lead_events event
       where event.source_type = v_event_type
         and event.source_id = p_request_id
         and event.org_id = p_org_id
         and event.property_id = v_request.property_id
         and event.actor_type = 'user'
         and event.event_type = v_event_type
     ) then
    return;
  end if;

  if p_resolution_source = 'automatic' then
    update public.esign_requests
    set delivery_state = 'failed',
        status = 'error',
        completed_at = now(),
        error_message = p_error_message,
        updated_by = null,
        updated_at = now()
    where id = p_request_id
      and org_id = p_org_id
      and delivery_state = 'send_unknown'
      and sign_request_id is null;
    if not found then
      raise exception 'eSign request is not an unresolved unknown send'
        using errcode = '55000';
    end if;
  else
    update public.esign_requests
    set updated_by = p_actor_id,
        updated_at = now()
    where id = p_request_id
      and org_id = p_org_id
      and delivery_state = 'failed'
      and sign_request_id is null
      and error_message = p_error_message;
    if not found then
      raise exception 'eSign request is not an evidenced failed send'
        using errcode = '55000';
    end if;
  end if;

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
    v_event_type,
    p_request_id
  ) on conflict (source_type, source_id) where source_id is not null do nothing;
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
  'Service-role resolver for eSign sends proven not found. Automatic calls require provider positive-control evidence before marking failed; operator calls require an active owner and only acknowledge an already-evidenced failed request.';

create or replace function public.attach_esign_request_provider_delivery(
  p_org_id uuid,
  p_request_id uuid,
  p_provider_request_id text,
  p_resolution_source text,
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
  if btrim(coalesce(p_provider_request_id, '')) = ''
     or p_resolution_source not in ('automatic', 'webhook')
     or jsonb_typeof(coalesce(p_evidence, '{}'::jsonb)) <> 'object'
     or coalesce(p_evidence ->> 'providerRequestId', '') <> p_provider_request_id
     or coalesce(p_evidence ->> 'localRequestId', '') <> p_request_id::text
     or (
       p_resolution_source = 'automatic'
       and (
         coalesce(p_evidence ->> 'positiveControl', '') <> 'passed'
         or coalesce(p_evidence ->> 'source', '') <> 'dropbox_metadata_search_sandra_request_id'
       )
     )
     or (
       p_resolution_source = 'webhook'
       and coalesce(p_evidence ->> 'source', '') <> 'dropbox_provider_read_sandra_request_id'
     ) then
    raise exception 'invalid eSign provider delivery attachment'
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
  if v_request.sign_request_id is not null then
    if v_request.sign_request_id = p_provider_request_id then
      return;
    end if;
    raise exception 'conflicting eSign provider request id'
      using errcode = '23514';
  end if;
  if v_request.delivery_state not in ('sending', 'send_unknown') then
    raise exception 'eSign request is not awaiting provider attachment'
      using errcode = '55000';
  end if;

  update public.esign_requests
  set sign_request_id = p_provider_request_id,
      delivery_state = 'sent',
      status = case when status = 'error' then 'awaiting' else status end,
      sent_at = coalesce(sent_at, now()),
      error_message = null,
      updated_by = null,
      updated_at = now()
  where id = p_request_id
    and org_id = p_org_id
    and sign_request_id is null
    and delivery_state in ('sending', 'send_unknown');
  if not found then
    raise exception 'eSign request is not awaiting provider attachment'
      using errcode = '55000';
  end if;

  v_event_type := case p_resolution_source
    when 'webhook' then 'esign_send_provider_attached_webhook'
    else 'esign_send_provider_attached_automatic'
  end;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload,
    source_type, source_id
  ) values (
    p_org_id,
    v_request.property_id,
    'system',
    null,
    v_event_type,
    jsonb_build_object(
      'request_id', p_request_id,
      'provider_request_id', p_provider_request_id,
      'evidence', coalesce(p_evidence, '{}'::jsonb)
    ),
    null,
    null
  );
end;
$$;

revoke all on function public.attach_esign_request_provider_delivery(
  uuid, uuid, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.attach_esign_request_provider_delivery(
  uuid, uuid, text, text, jsonb
) to service_role;

comment on function public.attach_esign_request_provider_delivery(
  uuid, uuid, text, text, jsonb
) is
  'Service-role repair for provider-accepted eSign sends that timed out locally before Sandra stored the Dropbox Sign signature_request_id.';

commit;
