-- Routing v2 stress review A-6: Jev and Haiku calls in the existing spend ledger
-- (provider_spend_ledger, 20261030180000). One settled row per model call: count + tokens
-- (+ cost when the provider reports it). Accounting only: no caps, no rate limit, no reservation.
-- Additive. Rollback: supabase/rollbacks/20261031131200_routing_v2_model_spend_ledger.sql
begin;
set local lock_timeout = '5s';

alter table public.provider_spend_ledger drop constraint if exists provider_spend_ledger_provider_check;
alter table public.provider_spend_ledger add constraint provider_spend_ledger_provider_check
  check (provider in ('dealmachine', 'jev', 'haiku'));
alter table public.provider_spend_ledger
  add column if not exists input_tokens integer check (input_tokens is null or input_tokens >= 0),
  add column if not exists output_tokens integer check (output_tokens is null or output_tokens >= 0),
  add column if not exists inbound_message_id uuid,
  add column if not exists outcome text;

create or replace function public.fn_record_model_call(
  p_provider text,
  p_org_id uuid,
  p_property_id uuid,
  p_inbound_message_id uuid,
  p_outcome text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_cost numeric,
  p_cost_unit text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_call uuid;
begin
  if p_provider not in ('jev', 'haiku') then raise exception 'unsupported model provider %', p_provider; end if;
  if p_property_id is not null
     and not exists (select 1 from public.properties p where p.id = p_property_id and p.org_id = p_org_id) then
    raise exception 'property not in org';
  end if;
  insert into public.provider_spend_ledger
    (provider, org_id, property_id, inbound_message_id, outcome, status, input_tokens, output_tokens, cost, cost_unit, settled_at)
  values
    (p_provider, p_org_id, p_property_id, p_inbound_message_id, p_outcome, 'settled', p_input_tokens, p_output_tokens,
     p_cost, coalesce(nullif(p_cost_unit, ''), 'usd'), now())
  returning call_id into v_call;
  return v_call;
end;
$$;
revoke all on function public.fn_record_model_call(text,uuid,uuid,uuid,text,integer,integer,numeric,text) from public, anon, authenticated;
grant execute on function public.fn_record_model_call(text,uuid,uuid,uuid,text,integer,integer,numeric,text) to service_role;
commit;
