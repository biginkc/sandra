begin;

drop index if exists public.idx_consent_events_external_idempotency;

do $$
declare
  duplicate_group_count integer;
  duplicate_rows integer;
begin
  with duplicate_groups as (
    select
      contact_id,
      channel,
      event_type,
      coalesce(source, '') as source_key,
      source_external_id,
      count(*) as row_count
    from public.consent_events
    where source_external_id is not null
      and event_type in ('opt_out', 'help_request')
    group by 1, 2, 3, 4, 5
    having count(*) > 1
  )
  select count(*), coalesce(sum(row_count), 0)
  into duplicate_group_count, duplicate_rows
  from duplicate_groups;

  if duplicate_group_count > 0 then
    raise exception
      'Cannot rebuild consent external-id idempotency with source scope: found % duplicate group(s) across % consent row(s). Run an audited cleanup before this migration.',
      duplicate_group_count,
      duplicate_rows;
  end if;
end $$;

create unique index idx_consent_events_external_idempotency
  on public.consent_events (contact_id, channel, event_type, source, source_external_id)
  where source_external_id is not null
    and event_type in ('opt_out', 'help_request');

commit;
