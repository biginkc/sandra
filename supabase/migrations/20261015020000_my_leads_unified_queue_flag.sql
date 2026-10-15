-- My Leads unified work queue, Phase B1: the `unified_queue` org kill switch.
--
-- Additive, no data step: the column defaults to false, so every org keeps today's page until
-- scripts/my-leads-flags.mjs turns it on for one org. A missing column reads as OFF
-- (src/lib/my-leads/flags.ts), so code that reaches main before this migration stays inert.
begin;

alter table public.my_leads_feature_flags
  add column if not exists unified_queue boolean not null default false;

commit;
