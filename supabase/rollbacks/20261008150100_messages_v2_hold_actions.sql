-- Rollback for 20261008150100_messages_v2_hold_actions. Drops fn_resolve_hold
-- and the draft bookkeeping columns (edit history and resolver ids are lost).
begin;

drop function if exists public.fn_resolve_hold(uuid, uuid, uuid, text, text);

alter table public.ai_reply_drafts
  drop column if exists edited_body,
  drop column if exists edited_by,
  drop column if exists edited_at,
  drop column if exists resolved_by,
  drop column if exists resolved_at,
  drop column if exists resolution_reason,
  drop column if exists sent_message_id;

commit;
