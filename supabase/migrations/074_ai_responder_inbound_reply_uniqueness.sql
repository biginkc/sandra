begin;

do $$
declare
  duplicate_group_count integer;
  duplicate_rows integer;
begin
  with duplicate_groups as (
    select
      metadata ->> 'inbound_message_id' as inbound_message_id,
      count(*) as row_count
    from public.messages
    where channel = 'sms'
      and direction = 'outbound'
      and metadata ->> 'generated_by' = 'ai_responder_v1'
      and metadata ? 'inbound_message_id'
    group by 1
    having count(*) > 1
  )
  select count(*), coalesce(sum(row_count), 0)
  into duplicate_group_count, duplicate_rows
  from duplicate_groups;

  if duplicate_group_count > 0 then
    raise exception
      'Cannot add AI inbound-reply uniqueness: found % duplicate inbound_message_id group(s) across % outbound AI message row(s). Run an audited cleanup before this migration.',
      duplicate_group_count,
      duplicate_rows;
  end if;
end $$;

create unique index if not exists idx_messages_ai_responder_inbound_unique
  on public.messages ((metadata ->> 'inbound_message_id'))
  where channel = 'sms'
    and direction = 'outbound'
    and metadata ->> 'generated_by' = 'ai_responder_v1'
    and metadata ? 'inbound_message_id';

commit;
