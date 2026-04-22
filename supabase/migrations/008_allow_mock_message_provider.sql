-- ============================================================================
-- Allow `mock` as a provider value on `messages` + `jobs`.
--
-- The integration test suite uses MESSAGING_PROVIDER=mock to exercise the
-- send path without hitting Dialpad. The mock's providerId is "mock",
-- which fails the CHECK constraints. Adding the value is harmless in
-- prod (no real code path sets provider='mock' there) and unblocks the
-- tests.
-- ============================================================================

alter table messages drop constraint if exists messages_provider_check;
alter table messages add constraint messages_provider_check
  check (provider in ('dialpad','twilio','resend','sendgrid','internal','mock'));

alter table jobs drop constraint if exists jobs_provider_check;
alter table jobs add constraint jobs_provider_check
  check (provider in (
    'apify','smartystreets','lob','dialpad','twilio','resend','internal','mock'
  ));
