-- Lead-reply alerts (owner decision 2026-10-20): a per-org watermark for
-- "every text from a seller on My Leads alerts Jarrad". Null until the first
-- alert pass that runs the feature sets it to now(); only inbound texts at or
-- after it can alert, so turning the feature on sends no backlog.
begin;
set local lock_timeout = '5s';
alter table public.hold_alert_settings
  add column if not exists lead_replies_since timestamptz;
comment on column public.hold_alert_settings.lead_replies_since is
  'Lead-reply alert watermark. Set to now() by the first alert pass that runs lead-reply alerts; only inbound texts at or after it alert.';
commit;
