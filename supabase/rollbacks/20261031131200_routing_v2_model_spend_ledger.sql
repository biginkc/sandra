-- Rollback for 20261031131200. Removes the Jev / Haiku ledger rows (accounting only) first.
begin;
set local lock_timeout = '5s';
drop function if exists public.fn_record_model_call(text,uuid,uuid,uuid,text,integer,integer,numeric,text);
delete from public.provider_spend_ledger where provider in ('jev', 'haiku');
alter table public.provider_spend_ledger drop column if exists outcome, drop column if exists inbound_message_id,
  drop column if exists output_tokens, drop column if exists input_tokens;
alter table public.provider_spend_ledger drop constraint if exists provider_spend_ledger_provider_check;
alter table public.provider_spend_ledger add constraint provider_spend_ledger_provider_check check (provider in ('dealmachine'));
commit;
