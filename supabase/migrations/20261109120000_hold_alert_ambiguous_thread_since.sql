-- Ambiguous-thread hold alerts: a per-org watermark for "a reply threading could
-- not tie to one property alerts Jarrad" (env HOLD_ALERT_AMBIGUOUS_THREAD_ENABLED=1).
-- Null until the first alert pass that runs the feature sets it to now(); only
-- inbound texts at or after it can alert, so turning the feature on sends no backlog.
-- Re-enable silently: set it back to null first; the next pass re-inits to now().
begin;
set local lock_timeout = '5s';
alter table public.hold_alert_settings
  add column if not exists ambiguous_thread_alerts_since timestamptz;
comment on column public.hold_alert_settings.ambiguous_thread_alerts_since is
  'Ambiguous-thread alert watermark. Set to now() by the first alert pass that runs ambiguous-thread alerts; only inbound texts at or after it alert.';
commit;
