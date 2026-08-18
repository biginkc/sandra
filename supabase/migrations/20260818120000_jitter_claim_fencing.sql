-- Atomic claim (compare-and-swap) with a 30-minute TTL takeover, plus
-- session-fenced item PATCHes, for the Jitter dialer bridge.
--
-- Sandra-side security hardening (contract build item 3,
-- .planning/claude-convergence/sandra-jitter-contract-draft.md §1.3.1):
-- the previous claim route was read-then-update — two concurrent claim
-- requests could both pass the "not already claimed by someone else"
-- check and both write success, and a crashed worker's batch stayed
-- claimed forever (no expiry). Fix: a single atomic UPDATE with the CAS
-- predicate baked into the WHERE clause, so only one caller ever wins a
-- given claim window, and a claim older than the TTL is eligible for
-- takeover by a new session without an intermediate "release" step.
--
-- The item PATCH route previously had NO fencing at all: once a batch's
-- claim moved to a new session (same-session re-claim, or TTL takeover
-- by a different worker), the OLD worker could still PATCH items with
-- reports the new owner never authorized. jitter_patch_dialer_batch_item
-- closes that by requiring the caller's session id to match the batch's
-- CURRENT jitter_session_id at update time, atomically.
--
-- Both functions are SECURITY DEFINER with search_path='' (every
-- reference below is schema-qualified) and are executable only by
-- service_role — the same trust boundary as the routes that call them
-- (authenticateJitterWriteback authenticates via webhook_consumers,
-- then uses the service-role client).

create or replace function public.jitter_claim_dialer_batch(
  p_batch_id uuid,
  p_org_id uuid,
  p_session_id text,
  p_ttl_minutes int default 30
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.dialer_batches%rowtype;
  v_existing public.dialer_batches%rowtype;
begin
  -- Single atomic compare-and-swap. A row is claimable when:
  --   - it is 'pending' (never claimed), OR
  --   - it is 'claimed' by THIS session already (idempotent re-claim,
  --     e.g. a retried request), OR
  --   - it is 'claimed' but the claim is older than the TTL (crashed or
  --     abandoned worker — eligible for takeover by a new session).
  -- claimed_at only advances when the session identity actually changes
  -- (fresh claim or TTL takeover); a same-session re-claim leaves it
  -- untouched so the TTL clock isn't reset by idempotent retries.
  update public.dialer_batches b
  set status = 'claimed',
      jitter_session_id = p_session_id,
      claimed_at = case
        when b.jitter_session_id is distinct from p_session_id then now()
        else b.claimed_at
      end,
      updated_at = now()
  where b.id = p_batch_id
    and b.org_id = p_org_id
    and (
      b.status = 'pending'
      or (
        b.status = 'claimed'
        and (
          b.jitter_session_id = p_session_id
          or b.claimed_at < now() - make_interval(mins => p_ttl_minutes)
        )
      )
    )
  returning b.* into v_row;

  if found then
    return jsonb_build_object(
      'outcome', 'claimed',
      'batch', jsonb_build_object(
        'id', v_row.id,
        'org_id', v_row.org_id,
        'status', v_row.status,
        'jitter_session_id', v_row.jitter_session_id,
        'claimed_at', v_row.claimed_at
      )
    );
  end if;

  -- Zero rows updated: distinguish "doesn't exist / wrong org" (404,
  -- don't leak existence) from "exists but currently held by someone
  -- else within the TTL window" (409 conflict).
  select * into v_existing
  from public.dialer_batches b
  where b.id = p_batch_id
    and b.org_id = p_org_id;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  return jsonb_build_object(
    'outcome', 'conflict',
    'status', v_existing.status,
    'jitter_session_id', v_existing.jitter_session_id
  );
end;
$$;

revoke all on function public.jitter_claim_dialer_batch(uuid, uuid, text, int)
  from public, anon, authenticated;
grant execute on function public.jitter_claim_dialer_batch(uuid, uuid, text, int)
  to service_role;

create or replace function public.jitter_patch_dialer_batch_item(
  p_item_id uuid,
  p_org_id uuid,
  p_session_id text,
  p_status text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.dialer_batch_items%rowtype;
  v_batch_id uuid;
  v_batch_org_id uuid;
begin
  -- Atomic, fenced update: only succeeds when the item's batch is
  -- currently claimed by THIS session, under THIS org. A stale worker
  -- (superseded by a TTL takeover or a fresher same-org claim) fails
  -- this predicate even though the item id and org are both valid.
  update public.dialer_batch_items dbi
  set status = p_status,
      updated_at = now()
  where dbi.id = p_item_id
    and exists (
      select 1
      from public.dialer_batches b
      where b.id = dbi.batch_id
        and b.org_id = p_org_id
        and b.jitter_session_id = p_session_id
    )
  returning dbi.* into v_row;

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

  -- Zero rows: figure out why, without leaking cross-org existence.
  select dbi.batch_id into v_batch_id
  from public.dialer_batch_items dbi
  where dbi.id = p_item_id;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select b.org_id into v_batch_org_id
  from public.dialer_batches b
  where b.id = v_batch_id;

  if not found or v_batch_org_id is distinct from p_org_id then
    -- Item exists but belongs to a different org (or its batch vanished)
    -- — treat identically to "doesn't exist" so a foreign-org caller
    -- learns nothing.
    return jsonb_build_object('outcome', 'not_found');
  end if;

  -- Item exists, org matches, but the batch's current session fence
  -- doesn't match the caller's session (stale claim, TTL takeover by
  -- someone else, or the batch was never claimed by this caller).
  return jsonb_build_object('outcome', 'stale_claim');
end;
$$;

revoke all on function public.jitter_patch_dialer_batch_item(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.jitter_patch_dialer_batch_item(uuid, uuid, text, text)
  to service_role;
