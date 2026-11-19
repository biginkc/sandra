-- Roll back 20261015020000_my_leads_unified_queue_flag.
-- Drops the flag column. Orgs fall back to today's page (a missing column reads as OFF).
begin;

alter table public.my_leads_feature_flags drop column if exists unified_queue;

commit;
