-- Rollback for 20261007100000_lead_comps_foundation.
-- Safe: nothing outside Phase 3 reads these tables or functions. Dropping lead_comps discards
-- every stored comp (re-fetchable from the vendor); lead_valuation_inputs holds Jarrad's typed
-- ARV/rehab, so export it first if those numbers matter.
begin;

drop function if exists public.fn_set_lead_valuation_inputs(uuid, uuid, numeric, numeric);
drop function if exists public.fn_reap_stuck_comp_fetches();
drop function if exists public.fn_finish_comp_fetch(uuid, text, integer, text, uuid);
drop function if exists public.fn_claim_comp_fetches(integer);
drop function if exists public.fn_enqueue_comp_fetch(uuid, uuid, text, uuid);

drop table if exists public.lead_valuation_inputs cascade;
drop table if exists public.lead_comps cascade;
drop table if exists public.comp_fetch_requests cascade;
drop table if exists public.org_comp_settings cascade;

commit;
