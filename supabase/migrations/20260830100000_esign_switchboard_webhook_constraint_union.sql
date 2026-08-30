-- Preserve the complete webhook-consumer type union when Sandra eSign and
-- Switchboard land in either supported migration order. The earlier feature
-- migrations each replace these checks from their own historical baseline;
-- this compatibility migration is deliberately later than both and is the
-- sole final authority for the combined constraint shape.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- The ALTER statements below take ACCESS EXCLUSIVE locks. Taking the table
-- lock once makes the drop/add pair an explicit indivisible critical section
-- even when this file is replayed directly during an isolated rehearsal.
lock table public.webhook_consumers in access exclusive mode;

alter table public.webhook_consumers
  drop constraint if exists webhook_consumers_type_check;
alter table public.webhook_consumers
  add constraint webhook_consumers_type_check
  check (consumer_type = any (array[
    'lead',
    'provider',
    'jitter_writeback',
    'closer_practice',
    'bmh_institute_course',
    'esign_provider',
    'switchboard_contact_preference'
  ]));

alter table public.webhook_consumers
  drop constraint if exists webhook_consumers_type_source_match_check;
alter table public.webhook_consumers
  add constraint webhook_consumers_type_source_match_check
  check (
    (consumer_type = 'lead' and default_source is not null)
    or
    (consumer_type in (
      'provider',
      'jitter_writeback',
      'closer_practice',
      'bmh_institute_course',
      'esign_provider',
      'switchboard_contact_preference'
    ) and default_source is null)
  );

commit;
