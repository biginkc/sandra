-- Rollback for 20261007190000_call_facts.
-- Safe: only the call-screen chips read these. Summary notes and accepted-fact notes already written are
-- ordinary lead_notes rows and stay (lead_call_facts.summary_note_id is on delete set null, dropped with the table).
begin;

drop function if exists public.fn_dismiss_call_facts(uuid, uuid);
drop function if exists public.fn_accept_call_fact(uuid, uuid, text, text);
drop function if exists public.fn_complete_call_facts(uuid, uuid, jsonb, text, text);
drop function if exists public.fn_claim_call_facts(integer, integer);
drop table if exists public.lead_call_facts cascade;

commit;
