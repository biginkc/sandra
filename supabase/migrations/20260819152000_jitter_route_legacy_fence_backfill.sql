-- Backfill safety metadata for installations that already applied the claim
-- fencing functions before the legacy-row hardening was added.

update public.dialer_batches
set claim_generation = 1
where status = 'claimed'
  and claim_generation = 0;

update public.webhook_events
set request_hash = encode(
  extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'),
  'hex'
)
where provider = 'jitter'
  and processing_status = 'pending'
  and request_hash is null;
