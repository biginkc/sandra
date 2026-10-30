-- 20261030180000_routing_v2_dealmachine_value_cache.sql
-- SMS reply routing v2, PR-E (BUILD-PLAN §15): DealMachine estimated-value cache with an
-- atomic claim, 30-day expiry, negative cache, retry backoff, and per-call spend accounting.
--
-- Additive only. Nothing reads these until routing_v2_flags.price_check is on (and the
-- cutover PR wires the price check into live dispatch). No caps (Jarrad 2026-10-30).
--
-- Concurrency: a unique key alone does not stop two replies from both calling the
-- provider. fn_dealmachine_value_claim takes the claim with
--   INSERT ... ON CONFLICT (property_id) DO UPDATE ... WHERE <reclaimable> RETURNING
-- so exactly one caller wins a claim per property; losers see the current row (in_flight,
-- cached ok/negative, or backoff) and never call the provider.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists public.dealmachine_value_cache (
  property_id uuid primary key references public.properties(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  state text not null check (state in ('in_flight', 'ok', 'negative', 'failed_retryable')),
  estimated_value numeric(14, 2),
  claim_token uuid,
  claim_expires_at timestamptz,
  valid_until timestamptz,
  retry_after timestamptz,
  claims integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dealmachine_value_cache_ok_has_value
    check (state <> 'ok' or (estimated_value is not null and estimated_value > 0 and valid_until is not null)),
  constraint dealmachine_value_cache_negative_has_expiry
    check (state <> 'negative' or valid_until is not null),
  constraint dealmachine_value_cache_in_flight_has_claim
    check (state <> 'in_flight' or (claim_token is not null and claim_expires_at is not null))
);

create index if not exists dealmachine_value_cache_org_idx on public.dealmachine_value_cache (org_id);

alter table public.dealmachine_value_cache enable row level security;
revoke all on public.dealmachine_value_cache from public, anon, authenticated;
grant select, insert, update, delete on public.dealmachine_value_cache to service_role;

comment on table public.dealmachine_value_cache is
  'Routing v2 PR-E: DealMachine estimated_value per property. ok/negative valid 30 days; failed_retryable honors retry_after; in_flight is a claim that expires (crashed worker).';

-- One row per provider HTTP request (BUILD-PLAN §15 spend accounting). No cap, no reservation.
create table if not exists public.provider_spend_ledger (
  call_id uuid primary key,
  provider text not null check (provider in ('dealmachine')),
  day date not null default ((now() at time zone 'utc')::date),
  org_id uuid references public.organizations(id) on delete set null,
  property_id uuid references public.properties(id) on delete set null,
  http_status integer,
  -- Provider-reported cost (DealMachine: credits.used). NULL = not reported (error/timeout).
  cost numeric(12, 4),
  cost_unit text not null default 'credits',
  created_at timestamptz not null default now()
);

create index if not exists provider_spend_ledger_provider_day_idx on public.provider_spend_ledger (provider, day);

alter table public.provider_spend_ledger enable row level security;
revoke all on public.provider_spend_ledger from public, anon, authenticated;
grant select, insert on public.provider_spend_ledger to service_role;

comment on table public.provider_spend_ledger is
  'Routing v2: one row per paid-provider HTTP request (DealMachine). Accounting only: no cap, no kill switch (Jarrad 2026-10-30).';

-- Claim. Outcomes:
--   claimed          caller won the claim and must call the provider, then settle
--   cached_ok        a valid value exists (estimated_value set)
--   cached_negative  no-match/no-value cached; no provider call in the window
--   in_flight        another caller holds an unexpired claim
--   backoff          a retryable failure is waiting for retry_after
create or replace function public.fn_dealmachine_value_claim(
  p_property_id uuid,
  p_org_id uuid,
  p_claim_ttl_seconds integer default 60
)
returns table (outcome text, claim_token uuid, estimated_value numeric, retry_after timestamptz)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_token uuid := gen_random_uuid();
  v_won uuid;
  v_row public.dealmachine_value_cache%rowtype;
begin
  if p_claim_ttl_seconds is null or p_claim_ttl_seconds < 1 or p_claim_ttl_seconds > 600 then
    raise exception 'claim ttl out of range';
  end if;
  if not exists (select 1 from public.properties p where p.id = p_property_id and p.org_id = p_org_id) then
    raise exception 'property not in org';
  end if;

  insert into public.dealmachine_value_cache as c
    (property_id, org_id, state, claim_token, claim_expires_at, claims, updated_at)
  values
    (p_property_id, p_org_id, 'in_flight', v_token, now() + make_interval(secs => p_claim_ttl_seconds), 1, now())
  on conflict (property_id) do update
    set state = 'in_flight',
        claim_token = excluded.claim_token,
        claim_expires_at = excluded.claim_expires_at,
        claims = c.claims + 1,
        updated_at = now()
    where (c.state = 'in_flight' and c.claim_expires_at <= now())
       or (c.state = 'failed_retryable' and (c.retry_after is null or c.retry_after <= now()))
       or (c.state in ('ok', 'negative') and c.valid_until <= now())
  returning c.claim_token into v_won;

  if v_won is not null then
    return query select 'claimed'::text, v_won, null::numeric, null::timestamptz;
    return;
  end if;

  select * into v_row from public.dealmachine_value_cache c where c.property_id = p_property_id;
  if v_row.state = 'ok' then
    return query select 'cached_ok'::text, null::uuid, v_row.estimated_value, null::timestamptz;
  elsif v_row.state = 'negative' then
    return query select 'cached_negative'::text, null::uuid, null::numeric, null::timestamptz;
  elsif v_row.state = 'failed_retryable' then
    return query select 'backoff'::text, null::uuid, null::numeric, v_row.retry_after;
  else
    return query select 'in_flight'::text, null::uuid, null::numeric, null::timestamptz;
  end if;
end;
$$;

-- Settle. Only the current claim holder (matching token, still in_flight) can write; a
-- stale claimer whose claim expired and was retaken gets false and changes nothing.
create or replace function public.fn_dealmachine_value_settle(
  p_property_id uuid,
  p_claim_token uuid,
  p_state text,
  p_estimated_value numeric default null,
  p_retry_after_seconds integer default null,
  p_error text default null,
  p_valid_days integer default 30
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if p_state not in ('ok', 'negative', 'failed_retryable') then
    raise exception 'invalid settle state %', p_state;
  end if;
  if p_state = 'ok' and (p_estimated_value is null or p_estimated_value <= 0) then
    raise exception 'ok requires a positive estimated_value';
  end if;
  if p_valid_days is null or p_valid_days < 1 or p_valid_days > 365 then
    raise exception 'valid days out of range';
  end if;

  update public.dealmachine_value_cache c
     set state = p_state,
         estimated_value = case when p_state = 'ok' then p_estimated_value else null end,
         valid_until = case when p_state in ('ok', 'negative') then now() + make_interval(days => p_valid_days) else null end,
         retry_after = case when p_state = 'failed_retryable'
                            then now() + make_interval(secs => greatest(coalesce(p_retry_after_seconds, 0), 0))
                            else null end,
         claim_token = null,
         claim_expires_at = null,
         last_error = left(p_error, 500),
         updated_at = now()
   where c.property_id = p_property_id
     and c.state = 'in_flight'
     and c.claim_token = p_claim_token;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- Idempotent per call_id (a retried write of the same call never double counts).
create or replace function public.fn_provider_spend_record(
  p_call_id uuid,
  p_provider text,
  p_org_id uuid,
  p_property_id uuid,
  p_http_status integer,
  p_cost numeric
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  insert into public.provider_spend_ledger (call_id, provider, org_id, property_id, http_status, cost)
  values (p_call_id, p_provider, p_org_id, p_property_id, p_http_status, p_cost)
  on conflict (call_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke all on function public.fn_dealmachine_value_claim(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.fn_dealmachine_value_settle(uuid, uuid, text, numeric, integer, text, integer) from public, anon, authenticated;
revoke all on function public.fn_provider_spend_record(uuid, text, uuid, uuid, integer, numeric) from public, anon, authenticated;
grant execute on function public.fn_dealmachine_value_claim(uuid, uuid, integer) to service_role;
grant execute on function public.fn_dealmachine_value_settle(uuid, uuid, text, numeric, integer, text, integer) to service_role;
grant execute on function public.fn_provider_spend_record(uuid, text, uuid, uuid, integer, numeric) to service_role;

commit;
