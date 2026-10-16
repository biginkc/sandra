-- Roll back 20261015010000_my_leads_work_queue_classifier.
-- Drops the new read-only functions. No table, row or existing function is touched.
begin;

drop function if exists public.fn_my_leads_badge_v2(timestamptz);
drop function if exists public.fn_my_leads_work_facts(uuid, uuid, uuid[], timestamptz);
drop function if exists public.fn_my_leads_work_page(uuid, uuid, text, text, text, text, integer, integer, timestamptz);
drop function if exists public.my_leads_work_classified(uuid, uuid, timestamptz);
drop function if exists public.my_leads_add_business_days(timestamptz, integer);

commit;
