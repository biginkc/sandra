-- 20261014130000_rep_sms_inbound_stamp.sql
-- My Leads unified work queue, Phase A2: keep the ORIGINAL reply-to stamp across
-- obligation resume and durable-draft recovery. The browser-supplied inbound id is
-- bound once (first writer wins) to the durable record that survives a reload, and
-- every later attempt reads that stored value back instead of re-capturing.
-- Additive: two nullable columns and one new service-role-only function. No existing
-- function, policy, grant or data row is changed. The stored id is a hint that
-- dispatch re-validates (inbound, same org, same property) before stamping.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.rep_sms_obligations
  add column if not exists inbound_message_id uuid;
alter table public.rep_sms_delivery_ledger
  add column if not exists inbound_message_id uuid;

-- Read-only counterpart: the stored stamp for an obligation or draft, org-scoped. Dispatch
-- reads this first so a failing bind can never cost the original stamp.
create or replace function public.fn_get_rep_sms_inbound_stamp(
  p_kind text,
  p_id uuid,
  p_org_id uuid
) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_stored uuid;
begin
  if p_kind = 'obligation' then
    select inbound_message_id into v_stored
      from public.rep_sms_obligations where id = p_id and org_id = p_org_id;
  elsif p_kind = 'draft' then
    select inbound_message_id into v_stored
      from public.rep_sms_delivery_ledger where id = p_id and org_id = p_org_id;
  else
    raise exception 'unknown stamp kind %', p_kind using errcode = '22023';
  end if;
  return v_stored;
end $$;

revoke all on function public.fn_get_rep_sms_inbound_stamp(text,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.fn_get_rep_sms_inbound_stamp(text,uuid,uuid)
  to service_role;

-- Bind-or-read. p_kind is 'obligation' or 'draft' (the delivery ledger row). The first
-- non-null stamp wins; a null or later value never overwrites it. Returns the stored
-- value (possibly null). Scoped by org so a forged id cannot touch another tenant's row.
create or replace function public.fn_bind_rep_sms_inbound_stamp(
  p_kind text,
  p_id uuid,
  p_org_id uuid,
  p_inbound_message_id uuid
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_stored uuid;
begin
  if p_kind = 'obligation' then
    if p_inbound_message_id is not null then
      update public.rep_sms_obligations
         set inbound_message_id = p_inbound_message_id
       where id = p_id and org_id = p_org_id and inbound_message_id is null;
    end if;
    select inbound_message_id into v_stored
      from public.rep_sms_obligations where id = p_id and org_id = p_org_id;
  elsif p_kind = 'draft' then
    if p_inbound_message_id is not null then
      update public.rep_sms_delivery_ledger
         set inbound_message_id = p_inbound_message_id
       where id = p_id and org_id = p_org_id and inbound_message_id is null;
    end if;
    select inbound_message_id into v_stored
      from public.rep_sms_delivery_ledger where id = p_id and org_id = p_org_id;
  else
    raise exception 'unknown stamp kind %', p_kind using errcode = '22023';
  end if;
  return v_stored;
end $$;

revoke all on function public.fn_bind_rep_sms_inbound_stamp(text,uuid,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.fn_bind_rep_sms_inbound_stamp(text,uuid,uuid,uuid)
  to service_role;

commit;
