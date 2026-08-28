-- Production has outgrown the 20k-thread capacity fixture. The Messages page
-- now groups more than 53k conversations for every exact filter-count
-- snapshot. Preserve the snapshot contract while removing one forced
-- materialization pass and two redundant ordered aggregates.

set lock_timeout = '10s';
set statement_timeout = '120s';

create index if not exists idx_messages_sms_inbox_org_conversation_latest
  on public.messages (
    org_id,
    conversation_id,
    created_at desc,
    id desc
  )
  include (
    contact_id,
    property_id,
    direction,
    read_at
  )
  where channel = 'sms'
    and contact_id is not null
    and conversation_id is not null
    and status not in ('queued', 'paused');

do $migration$
declare
  function_signature constant regprocedure :=
    'public.sms_inbox_thread_page_snapshot(timestamptz,text,uuid,uuid,boolean,integer,integer)'::regprocedure;
  definition text;
  old_fragment text;
  new_fragment text;
  fragment_position integer;
begin
  select pg_get_functiondef(function_signature) into strict definition;

  old_fragment := 'recent_eligible as materialized (';
  new_fragment := 'recent_eligible as not materialized (';
  fragment_position := strpos(definition, old_fragment);
  if fragment_position = 0 then
    raise exception 'messages filter hotfix: recent_eligible materialization fragment not found';
  end if;
  definition := overlay(
    definition placing new_fragment
    from fragment_position for char_length(old_fragment)
  );

  -- Only replace the first occurrence of each aggregate. That is the recent
  -- workset. The cutoff-independent pending-review recovery branch remains
  -- byte-for-byte unchanged.
  old_fragment := '(array_agg(e.id order by e.created_at desc, e.id desc))[1] as last_message_id';
  new_fragment := '(array_agg(e.id) filter (where e.latest_rank = 1))[1] as last_message_id';
  fragment_position := strpos(definition, old_fragment);
  if fragment_position = 0 then
    raise exception 'messages filter hotfix: recent last_message_id aggregate not found';
  end if;
  definition := overlay(
    definition placing new_fragment
    from fragment_position for char_length(old_fragment)
  );

  old_fragment := '(array_agg(e.contact_id order by e.created_at desc, e.id desc))[1] as contact_id';
  new_fragment := '(array_agg(e.contact_id) filter (where e.latest_rank = 1))[1] as contact_id';
  fragment_position := strpos(definition, old_fragment);
  if fragment_position = 0 then
    raise exception 'messages filter hotfix: recent contact_id aggregate not found';
  end if;
  definition := overlay(
    definition placing new_fragment
    from fragment_position for char_length(old_fragment)
  );

  execute definition;
end;
$migration$;

-- The live PostgREST role currently cancels this read-only snapshot at eight
-- seconds. Keep a narrow recovery ceiling on this one bounded function so a
-- transient cold plan cannot crash the entire Messages route while the new
-- index warms. Production acceptance still requires every filter below four
-- seconds; this is a safety net, not the performance gate.
alter function public.sms_inbox_thread_page_snapshot(
  timestamptz,
  text,
  uuid,
  uuid,
  boolean,
  integer,
  integer
) set statement_timeout = '15s';

comment on index public.idx_messages_sms_inbox_org_conversation_latest is
  'Orders the bounded SMS inbox workset by tenant, conversation, and recency without indexing message bodies or phone text.';
