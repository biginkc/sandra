-- Allow the new Sendillo provider anywhere messages/jobs persist a
-- provider label, and add a real uniqueness guard for inbound provider
-- message ids so webhook retries cannot duplicate inbound message rows.

alter table messages drop constraint if exists messages_provider_check;
alter table messages add constraint messages_provider_check
  check (provider in ('dialpad','twilio','resend','sendgrid','internal','mock','sendillo'));

alter table jobs drop constraint if exists jobs_provider_check;
alter table jobs add constraint jobs_provider_check
  check (provider in (
    'apify',
    'smartystreets',
    'lob',
    'dialpad',
    'twilio',
    'resend',
    'internal',
    'mock',
    'tracerfy',
    'sendillo'
  ));

do $$
declare
  duplicate_group_count integer;
  duplicate_rows integer;
begin
  with duplicate_groups as (
    select provider, external_id, count(*) as row_count
    from public.messages
    where direction = 'inbound'
      and provider is not null
      and external_id is not null
    group by provider, external_id
    having count(*) > 1
  )
  select count(*), coalesce(sum(row_count), 0)
  into duplicate_group_count, duplicate_rows
  from duplicate_groups;

  if duplicate_group_count > 0 then
    raise exception
      'Cannot add inbound provider/external_id uniqueness: found % duplicate group(s) across % inbound message row(s). Run an audited cleanup/merge before this migration.',
      duplicate_group_count,
      duplicate_rows;
  end if;
end $$;

create unique index if not exists idx_messages_inbound_provider_external_unique
  on messages (provider, external_id)
  where direction = 'inbound' and external_id is not null;
