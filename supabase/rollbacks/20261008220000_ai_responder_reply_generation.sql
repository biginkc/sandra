-- Rollback for 20261008220000_ai_responder_reply_generation. Drops the setter
-- and the columns (a stored 'off' is lost: the responder returns to drafting).
begin;

drop function if exists public.fn_set_ai_reply_generation(uuid, text);
alter table public.ai_responder_configs drop constraint if exists ai_responder_configs_reply_generation_check;
alter table public.ai_responder_configs
  drop column if exists reply_generation_changed_at,
  drop column if exists reply_generation_changed_by,
  drop column if exists reply_generation;

commit;
