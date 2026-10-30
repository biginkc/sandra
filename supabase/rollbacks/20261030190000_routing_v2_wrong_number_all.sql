-- Roll back 20261030190000_routing_v2_wrong_number_all.
-- First turn the slice off (routing_v2_flags.wrong_number_all = false) and roll back any app
-- code that calls these functions. Applied dispositions stay as they are (safe direction);
-- undo any you want reversed BEFORE dropping the audit tables, which hold the prior state.
begin;
drop function if exists public.fn_routing_v2_phone_action_release_fence(uuid);
drop function if exists public.fn_undo_routing_v2_phone_action(uuid);
drop function if exists public.routing_v2_phone_action_undo_core(uuid, uuid);
drop function if exists public.fn_routing_v2_phone_action_unsettled_replies(integer, integer);
drop function if exists public.fn_routing_v2_phone_action_recover_reply(uuid);
drop function if exists public.fn_routing_v2_phone_action_send_allowed(uuid);
drop function if exists public.fn_routing_v2_phone_action_reply(uuid, uuid, text, uuid, text);
drop function if exists public.fn_routing_v2_phone_action_apply_all(uuid, text, text, jsonb, bigint);
drop function if exists public.routing_v2_phone_lock(uuid, text);
drop function if exists public.routing_v2_phone_digits(text);
drop function if exists public.routing_v2_phone_action_eligible(jsonb, uuid);
drop table if exists public.routing_v2_phone_action_properties;
drop table if exists public.routing_v2_phone_actions;
drop trigger if exists trg_sequence_enrollments_routing_v2_pause_token on public.sequence_enrollments;
drop function if exists public.routing_v2_clear_pause_token();
alter table public.sequence_enrollments drop column if exists routing_v2_pause_token;
commit;
