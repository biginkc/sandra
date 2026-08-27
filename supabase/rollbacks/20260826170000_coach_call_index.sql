begin;

drop policy if exists coach_topics_require_ownership on realtime.messages;
drop policy if exists coach_broadcast_owner_select on realtime.messages;
drop table if exists public.coach_call_index;

commit;
