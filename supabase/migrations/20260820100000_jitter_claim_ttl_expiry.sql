-- Sandra/Jitter bridge: claim TTL + expire transition.
--
-- Contract: sandra-jitter-contract-draft.md §1.2 step 2 / §7 (claim TTL
-- LOCKED at 30 minutes). A batch `claimed` longer than the TTL with no
-- item PATCHes may be re-claimed, so a crashed bridge worker's new session
-- id is never permanently 409'd. The status enum already includes
-- 'expired' but nothing transitions to it: staying in 'claimed' with an
-- advanced claim_generation is the actual expire transition here — the
-- generation bump is what fences out the old (crashed) worker's writes via
-- the existing check in jitter_patch_dialer_batch_item, so a distinct
-- 'expired' status is not needed to make expiry effective.
--
-- This is a narrow CAS-condition change to jitter_claim_dialer_batch. Every
-- other clause (coherence checks, idempotency-receipt finalize inside the
-- same transaction, security definer / search_path / service-role grants)
-- is unchanged from
-- supabase/migrations/20260819210000_jitter_round3_coherence_and_grants.sql
-- — do not re-derive this function from scratch when editing it again;
-- diff against that file.

begin;

create or replace function public.jitter_claim_dialer_batch(
  p_batch_id uuid,
  p_org_id uuid,
  p_session_id text,
  p_external_id text,
  p_request_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.dialer_batches%rowtype;
  v_claim_ttl constant interval := interval '30 minutes';
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'jitter RPC is service-role only';
  end if;

  -- Lock and validate the complete parent/item/property/contact chain before
  -- changing the batch.  Unknown and foreign batches remain indistinguishable
  -- to the route; malformed tenant graphs fail closed with one error.
  select b.* into v_batch
  from public.dialer_batches as b
  where b.id = p_batch_id
    and b.org_id = p_org_id
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if exists (
    select 1
    from public.dialer_batch_items as i
    left join public.dialer_batches as b on b.id = i.batch_id
    left join public.properties as p on p.id = i.property_id
    left join public.contacts as c on c.id = i.contact_id
    where i.batch_id = v_batch.id
      and (
        b.org_id is distinct from p_org_id
        or p.org_id is distinct from p_org_id
        or c.org_id is distinct from p_org_id
      )
  ) then
    raise exception 'jitter coherence check failed';
  end if;

  -- Idempotent replay: the current holder retrying with the same session id
  -- gets the same success without bumping the generation, UNCONDITIONALLY
  -- (no TTL check here) — a live worker's own retries must never be fenced
  -- out just because its own claim happens to have aged past the TTL. Once
  -- a *different* session has reclaimed a stale batch, this branch no
  -- longer matches (jitter_session_id has moved on) and the old worker
  -- falls through to the conflict branch below, same as today.
  if v_batch.status = 'claimed'
     and v_batch.jitter_session_id = p_session_id then
    update public.webhook_events
    set payload = jsonb_build_object('batch', jsonb_build_object(
          'id', v_batch.id,
          'org_id', v_batch.org_id,
          'status', v_batch.status,
          'jitter_session_id', v_batch.jitter_session_id,
          'claimed_at', v_batch.claimed_at,
          'claim_generation', v_batch.claim_generation
        )),
        processing_status = 'processed',
        processed_at = statement_timestamp()
    where org_id = p_org_id
      and provider = 'jitter'
      and event_type = 'dialer_batch_claim'
      and external_id = p_external_id
      and processing_status = 'pending'
      and request_hash = p_request_hash;
    if not found then
      raise exception 'idempotency reservation missing or hash mismatch';
    end if;

    return jsonb_build_object(
      'outcome', 'claimed',
      'batch', jsonb_build_object(
        'id', v_batch.id,
        'org_id', v_batch.org_id,
        'status', v_batch.status,
        'jitter_session_id', v_batch.jitter_session_id,
        'claimed_at', v_batch.claimed_at,
        'claim_generation', v_batch.claim_generation
      )
    );
  end if;

  -- Claimable when never claimed, OR when the existing claim has gone
  -- stale: claimed longer ago than the TTL, by any session (including a
  -- different one from the requester). Either way this runs the same CAS
  -- update as the original 'pending' branch, bumping claim_generation.
  if v_batch.status = 'pending'
     or (
       v_batch.status = 'claimed'
       and v_batch.claimed_at < statement_timestamp() - v_claim_ttl
     ) then
    update public.dialer_batches as b
    set status = 'claimed',
        jitter_session_id = p_session_id,
        claimed_at = statement_timestamp(),
        claim_generation = b.claim_generation + 1,
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
          'claim_generation', v_batch.claim_generation
        )),
        processing_status = 'processed',
        processed_at = statement_timestamp()
    where org_id = p_org_id
      and provider = 'jitter'
      and event_type = 'dialer_batch_claim'
      and external_id = p_external_id
      and processing_status = 'pending'
      and request_hash = p_request_hash;
    if not found then
      raise exception 'idempotency reservation missing or hash mismatch';
    end if;

    return jsonb_build_object(
      'outcome', 'claimed',
      'batch', jsonb_build_object(
        'id', v_batch.id,
        'org_id', v_batch.org_id,
        'status', v_batch.status,
        'jitter_session_id', v_batch.jitter_session_id,
        'claimed_at', v_batch.claimed_at,
        'claim_generation', v_batch.claim_generation
      )
    );
  end if;

  return jsonb_build_object(
    'outcome', 'conflict',
    'status', v_batch.status,
    'jitter_session_id', v_batch.jitter_session_id,
    'claim_generation', v_batch.claim_generation
  );
end;
$$;

revoke all on function public.jitter_claim_dialer_batch(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.jitter_claim_dialer_batch(uuid, uuid, text, text, text)
  to service_role;

commit;
