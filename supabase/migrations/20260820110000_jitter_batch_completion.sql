-- Sandra/Jitter bridge: batch completion endpoint.
--
-- Contract: sandra-jitter-contract-draft.md §1.3.5 / build item 5. Batch
-- completion is an idempotent mutation with defined semantics while item
-- reports/writebacks may still be retrying or dead-lettered:
-- `completed_with_pending_outcomes` lets the bridge close the batch out
-- without falsely claiming every outcome landed; Sandra reconciles later
-- when the stragglers arrive.

begin;

alter table public.dialer_batches
  drop constraint if exists dialer_batches_status_check;

alter table public.dialer_batches
  add constraint dialer_batches_status_check
  check (status in (
    'pending',
    'claimed',
    'in_progress',
    'completed',
    'canceled',
    'expired',
    'completed_with_pending_outcomes'
  ));

create or replace function public.jitter_complete_dialer_batch(
  p_batch_id uuid,
  p_org_id uuid,
  p_session_id text,
  p_claim_generation bigint,
  p_status text,
  p_external_id text,
  p_request_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.dialer_batches%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'jitter RPC is service-role only';
  end if;

  if p_status not in ('completed', 'completed_with_pending_outcomes') then
    raise exception 'jitter_complete_dialer_batch: invalid status %', p_status;
  end if;

  select b.* into v_batch
  from public.dialer_batches as b
  where b.id = p_batch_id
    and b.org_id = p_org_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  -- Same fencing idiom as jitter_patch_dialer_batch_item: only the current
  -- claim holder, at the current generation, may complete the batch.
  if v_batch.status <> 'claimed'
     or v_batch.jitter_session_id is distinct from p_session_id
     or v_batch.claim_generation is distinct from p_claim_generation then
    return jsonb_build_object('outcome', 'stale_claim');
  end if;

  update public.dialer_batches as b
  set status = p_status,
      completed_at = statement_timestamp(),
      updated_at = statement_timestamp()
  where b.id = v_batch.id
  returning b.* into v_batch;

  update public.webhook_events
  set payload = jsonb_build_object('batch', jsonb_build_object(
        'id', v_batch.id,
        'org_id', v_batch.org_id,
        'status', v_batch.status,
        'jitter_session_id', v_batch.jitter_session_id,
        'claimed_at', v_batch.claimed_at,
        'claim_generation', v_batch.claim_generation,
        'completed_at', v_batch.completed_at
      )),
      processing_status = 'processed',
      processed_at = statement_timestamp()
  where org_id = p_org_id
    and provider = 'jitter'
    and event_type = 'dialer_batch_complete'
    and external_id = p_external_id
    and processing_status = 'pending'
    and request_hash = p_request_hash;
  if not found then
    raise exception 'idempotency reservation missing or hash mismatch';
  end if;

  return jsonb_build_object(
    'outcome', 'completed',
    'batch', jsonb_build_object(
      'id', v_batch.id,
      'org_id', v_batch.org_id,
      'status', v_batch.status,
      'jitter_session_id', v_batch.jitter_session_id,
      'claimed_at', v_batch.claimed_at,
      'claim_generation', v_batch.claim_generation,
      'completed_at', v_batch.completed_at
    )
  );
end;
$$;

revoke all on function public.jitter_complete_dialer_batch(uuid, uuid, text, bigint, text, text, text)
  from public, anon, authenticated;
grant execute on function public.jitter_complete_dialer_batch(uuid, uuid, text, bigint, text, text, text)
  to service_role;

commit;
