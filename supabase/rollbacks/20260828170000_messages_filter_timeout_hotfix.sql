set lock_timeout = '10s';
set statement_timeout = '120s';

do $rollback$
declare
  function_signature constant regprocedure :=
    'public.sms_inbox_thread_page_snapshot(timestamptz,text,uuid,uuid,boolean,integer,integer)'::regprocedure;
  definition text;
  old_fragment text;
  new_fragment text;
  fragment_position integer;
begin
  select pg_get_functiondef(function_signature) into strict definition;

  old_fragment := 'recent_eligible as not materialized (';
  new_fragment := 'recent_eligible as materialized (';
  fragment_position := strpos(definition, old_fragment);
  if fragment_position = 0 then
    raise exception 'messages filter rollback: optimized recent_eligible fragment not found';
  end if;
  definition := overlay(
    definition placing new_fragment
    from fragment_position for char_length(old_fragment)
  );

  old_fragment := '(array_agg(e.id) filter (where e.latest_rank = 1))[1] as last_message_id';
  new_fragment := '(array_agg(e.id order by e.created_at desc, e.id desc))[1] as last_message_id';
  fragment_position := strpos(definition, old_fragment);
  if fragment_position = 0 then
    raise exception 'messages filter rollback: optimized last_message_id aggregate not found';
  end if;
  definition := overlay(
    definition placing new_fragment
    from fragment_position for char_length(old_fragment)
  );

  old_fragment := '(array_agg(e.contact_id) filter (where e.latest_rank = 1))[1] as contact_id';
  new_fragment := '(array_agg(e.contact_id order by e.created_at desc, e.id desc))[1] as contact_id';
  fragment_position := strpos(definition, old_fragment);
  if fragment_position = 0 then
    raise exception 'messages filter rollback: optimized contact_id aggregate not found';
  end if;
  definition := overlay(
    definition placing new_fragment
    from fragment_position for char_length(old_fragment)
  );

  execute definition;
end;
$rollback$;

alter function public.sms_inbox_thread_page_snapshot(
  timestamptz,
  text,
  uuid,
  uuid,
  boolean,
  integer,
  integer
) reset statement_timeout;

drop index if exists public.idx_messages_sms_inbox_org_conversation_latest;
