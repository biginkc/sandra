-- Roll back 20261021230100_voicemail_drop_attempt_facts.
-- Roll back the app first: voicemail drop eligibility calls this function.
begin;
drop function if exists public.get_voicemail_drop_reached_attempt_facts(uuid, uuid);
commit;
