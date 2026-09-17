begin;

-- A browser retry after a lost response must be able to prove that it is the
-- same rep SMS submission. The transport ledger is the durable authority:
-- one tenant-scoped key can reserve at most one outbound SMS row, including
-- while that row is still pending at the provider boundary.
alter table public.messages
  add column if not exists idempotency_key uuid;

create unique index if not exists messages_outbound_sms_idempotency_idx
  on public.messages(org_id,idempotency_key)
  where channel='sms' and direction='outbound' and idempotency_key is not null;

comment on column public.messages.idempotency_key is
  'Tenant-scoped client submission key. Rep SMS retries replay this row and never create a second provider request.';

commit;
