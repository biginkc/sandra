-- Tighten the claim-fencing functions after the initial route hardening
-- migration has already been applied in environments that track migrations
-- by version.

alter table public.webhook_events
  add column if not exists request_hash text;

update public.dialer_batches
set claim_generation = 1
where status = 'claimed'
  and claim_generation = 0;

-- Pending legacy reservations still contain the original request in payload;
-- processed rows do not, because payload is their cached response.
update public.webhook_events
set request_hash = encode(
  extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'),
  'hex'
)
where provider = 'jitter'
  and processing_status = 'pending'
  and request_hash is null;

create or replace function public.jitter_claim_dialer_batch(
  p_batch_id uuid,
  p_org_id uuid,
  p_session_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.dialer_batches%rowtype;
  v_existing public.dialer_batches%rowtype;
begin
  update public.dialer_batches as b
  set status = 'claimed',
      jitter_session_id = p_session_id,
      claimed_at = statement_timestamp(),
      claim_generation = b.claim_generation + 1,
      updated_at = statement_timestamp()
  where b.id = p_batch_id
    and b.org_id = p_org_id
    and b.status = 'pending'
  returning b.* into v_row;

  if found then
    return jsonb_build_object(
      'outcome', 'claimed',
      'batch', jsonb_build_object(
        'id', v_row.id,
        'org_id', v_row.org_id,
        'status', v_row.status,
        'jitter_session_id', v_row.jitter_session_id,
        'claimed_at', v_row.claimed_at,
        'claim_generation', v_row.claim_generation
      )
    );
  end if;

  select * into v_existing
  from public.dialer_batches as b
  where b.id = p_batch_id
    and b.org_id = p_org_id;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  -- Recover a committed claim when the process crashed before recording the
  -- idempotency response. The worker session and generation identify it.
  if v_existing.status = 'claimed'
     and v_existing.jitter_session_id = p_session_id then
    return jsonb_build_object(
      'outcome', 'claimed',
      'batch', jsonb_build_object(
        'id', v_existing.id,
        'org_id', v_existing.org_id,
        'status', v_existing.status,
        'jitter_session_id', v_existing.jitter_session_id,
        'claimed_at', v_existing.claimed_at,
        'claim_generation', v_existing.claim_generation
      )
    );
  end if;

  return jsonb_build_object(
    'outcome', 'conflict',
    'status', v_existing.status,
    'jitter_session_id', v_existing.jitter_session_id,
    'claim_generation', v_existing.claim_generation
  );
end;
$$;

revoke all on function public.jitter_claim_dialer_batch(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.jitter_claim_dialer_batch(uuid, uuid, text)
  to service_role;

create or replace function public.jitter_patch_dialer_batch_item(
  p_item_id uuid,
  p_org_id uuid,
  p_session_id text,
  p_claim_generation bigint,
  p_status text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.dialer_batch_items%rowtype;
  v_batch public.dialer_batches%rowtype;
begin
  -- Lock the parent claim before validating its fence. This serializes a
  -- late item report with a concurrent reclaim of the same batch.
  select b.* into v_batch
  from public.dialer_batches as b
  join public.dialer_batch_items as i on i.batch_id = b.id
  where i.id = p_item_id
    and b.org_id = p_org_id
  for update of b;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_batch.status <> 'claimed'
     or v_batch.jitter_session_id is distinct from p_session_id
     or v_batch.claim_generation is distinct from p_claim_generation then
    return jsonb_build_object('outcome', 'stale_claim');
  end if;

  update public.dialer_batch_items as i
  set status = p_status,
      updated_at = statement_timestamp()
  where i.id = p_item_id
    and i.batch_id = v_batch.id
  returning i.* into v_row;

  if found then
    return jsonb_build_object(
      'outcome', 'updated',
      'item', jsonb_build_object(
        'id', v_row.id,
        'batch_id', v_row.batch_id,
        'property_id', v_row.property_id,
        'contact_id', v_row.contact_id,
        'phone_e164', v_row.phone_e164,
        'status', v_row.status
      )
    );
  end if;

  return jsonb_build_object('outcome', 'not_found');
end;
$$;

revoke all on function public.jitter_patch_dialer_batch_item(uuid, uuid, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.jitter_patch_dialer_batch_item(uuid, uuid, text, bigint, text)
  to service_role;
