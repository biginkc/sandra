-- Rollback for 20261007170000_acquisition_offer_projections.
-- Drops the triggers, functions and projection table. The widened outcome constraint is restored
-- only when no 'superseded' offers exist: supersession is never recorded as a decline, so those rows
-- are NOT rewritten; if any exist the (additive, harmless) widened constraint is left in place.
begin;

drop trigger if exists trg_offer_projection_state on public.esign_requests;
drop trigger if exists trg_offer_projection_link on public.esign_requests;
drop function if exists public.fn_list_offer_conflicts(uuid, uuid, uuid);
drop function if exists public.fn_supersede_offer_and_log(uuid, uuid, uuid);
drop function if exists public.fn_offer_projection_due(integer);
drop function if exists public.fn_abandon_offer_projection(uuid);
drop function if exists public.fn_offer_projection_repair();
drop function if exists public.fn_retry_offer_projection(uuid, uuid, text);
drop function if exists public.fn_project_acquisition_offer(uuid);
drop function if exists public.fn_offer_projection_run(uuid, uuid, boolean, text);
drop function if exists public.fn_create_offer_projection(uuid, uuid, uuid, uuid, text, text, jsonb, bigint, date, text, text, text);
drop function if exists public.trg_offer_projection_state();
drop function if exists public.trg_offer_projection_link();
drop function if exists public.contract_follow_up_at(date, timestamptz, integer, smallint);
drop table if exists public.acquisition_offer_projections cascade;

do $$
begin
  if not exists (select 1 from public.acquisition_offers where outcome = 'superseded') then
    alter table public.acquisition_offers drop constraint acquisition_offers_outcome_check;
    alter table public.acquisition_offers add constraint acquisition_offers_outcome_check check (
      (outcome = 'pending' and outcome_at is null and outcome_by is null)
      or (outcome in ('accepted', 'declined') and outcome_at is not null and outcome_by is not null)
    );
  end if;
end $$;

commit;
