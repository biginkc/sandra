-- Rollback for 20261007110000_acquisition_contract_defaults.
-- Safe: nothing outside the Phase 3c send-contract card reads these tables, and sent requests
-- snapshot their values in esign_requests.merge_value_snapshot. Export the rows first if the
-- configured title companies and buyer entities matter.
begin;

drop table if exists public.acquisition_contract_title_market_defaults cascade;
drop table if exists public.acquisition_contract_settings cascade;
drop table if exists public.acquisition_contract_buyer_entities cascade;
drop table if exists public.acquisition_contract_title_companies cascade;

commit;
