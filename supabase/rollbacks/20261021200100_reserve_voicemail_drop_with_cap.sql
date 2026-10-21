-- Roll back 20261021200100_reserve_voicemail_drop_with_cap.
begin;

drop function if exists public.reserve_voicemail_drop_with_cap(uuid, integer, timestamptz, uuid, uuid, uuid, uuid, text, text, text, text);

commit;
