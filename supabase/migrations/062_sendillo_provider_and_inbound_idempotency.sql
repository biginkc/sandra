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
  ambiguous_ties integer;
  referenced_losers integer;
begin
  with duplicate_groups as (
    select provider, external_id, min(created_at) as keep_created_at
    from public.messages
    where direction = 'inbound'
      and provider is not null
      and external_id is not null
    group by provider, external_id
    having count(*) > 1
  ),
  tied_keepers as (
    select m.provider, m.external_id
    from public.messages m
    join duplicate_groups d
      on d.provider is not distinct from m.provider
     and d.external_id = m.external_id
     and d.keep_created_at = m.created_at
    group by m.provider, m.external_id
    having count(*) > 1
  )
  select count(*) into ambiguous_ties
  from tied_keepers;

  if ambiguous_ties > 0 then
    raise exception
      'Cannot dedupe inbound messages for provider/external_id uniqueness: % duplicate group(s) tie on earliest created_at',
      ambiguous_ties;
  end if;

  with duplicate_groups as (
    select provider, external_id, min(created_at) as keep_created_at
    from public.messages
    where direction = 'inbound'
      and provider is not null
      and external_id is not null
    group by provider, external_id
    having count(*) > 1
  ),
  losers as (
    select m.id
    from public.messages m
    join duplicate_groups d
      on d.provider is not distinct from m.provider
     and d.external_id = m.external_id
    where m.direction = 'inbound'
      and m.provider is not null
      and m.external_id is not null
      and m.created_at > d.keep_created_at
  )
  select count(*) into referenced_losers
  from losers l
  where exists (
    select 1
    from public.job_items ji
    where ji.message_id = l.id
  )
  or exists (
    select 1
    from public.sequence_step_runs ssr
    where ssr.message_id = l.id
  );

  if referenced_losers > 0 then
    raise exception
      'Cannot dedupe inbound messages for provider/external_id uniqueness: % later duplicate row(s) have downstream references',
      referenced_losers;
  end if;

  with duplicate_groups as (
    select provider, external_id, min(created_at) as keep_created_at
    from public.messages
    where direction = 'inbound'
      and provider is not null
      and external_id is not null
    group by provider, external_id
    having count(*) > 1
  ),
  losers as (
    select m.id
    from public.messages m
    join duplicate_groups d
      on d.provider is not distinct from m.provider
     and d.external_id = m.external_id
    where m.direction = 'inbound'
      and m.provider is not null
      and m.external_id is not null
      and m.created_at > d.keep_created_at
  )
  delete from public.messages m
  using losers l
  where m.id = l.id;
end $$;

create unique index if not exists idx_messages_inbound_provider_external_unique
  on messages (provider, external_id)
  where direction = 'inbound' and external_id is not null;
