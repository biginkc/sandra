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
declare dup_count int;
begin
  select count(*) into dup_count from (
    select provider, external_id from messages
    where direction = 'inbound' and external_id is not null
    group by provider, external_id having count(*) > 1
  ) d;
  if dup_count > 0 then
    raise exception 'Cannot add inbound uniqueness: % duplicate (provider, external_id) groups exist. Dedupe first.', dup_count;
  end if;
end $$;

create unique index if not exists idx_messages_inbound_provider_external_unique
  on messages (provider, external_id)
  where direction = 'inbound' and external_id is not null;
