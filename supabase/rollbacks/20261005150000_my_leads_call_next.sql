-- Roll back 20261005150000_my_leads_call_next.
-- Drops the strip functions and the overrides table. No existing row is touched; override rows
-- (pins and hides) are discarded with the table, which only hides the strip's personal state.
-- Turn the call_next_strip flag off first so the UI is already inert (it also reads schemaReady).
begin;

drop function if exists public.fn_get_my_leads_triage(uuid, uuid, integer, integer, timestamptz, uuid);
drop function if exists public.fn_set_my_leads_strip_override(uuid, uuid, uuid, text);
drop function if exists public.fn_get_my_leads_call_next(uuid, uuid, integer);
drop function if exists public.my_leads_call_next_rows(uuid, uuid, timestamptz);
drop function if exists public.my_leads_touch_facts(uuid, uuid, timestamptz);
drop function if exists public.my_leads_next_chicago_midnight(timestamptz);
drop table if exists public.my_leads_strip_overrides;

commit;
