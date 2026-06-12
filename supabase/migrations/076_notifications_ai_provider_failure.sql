-- 076: notifications.event_type — add 'ai_responder_provider_failure'
--      (and backfill the missing 'task_assigned')
--
-- ai_responder_provider_failure: account-level AI responder outages
-- (Anthropic credits exhausted / API key rejected). Live incident
-- 2026-06-12: the org ran out of API credits during the first bulk SMS
-- campaign hour — 6 hot replies escalated as generic generate_error and
-- no human was told the responder was down. Admins now get one loud
-- notification per failure kind per 24h.
--
-- task_assigned: the app's EventType union has included it since the
-- tasks feature (051) but no migration ever added it to this CHECK —
-- every task-assigned notification insert has been failing silently
-- (createNotification swallows insert errors by design). Latent bug
-- found while extending the constraint.

alter table notifications drop constraint notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check check (event_type = any (array[
  'owner_message_added'::text,
  'property_assigned'::text,
  'bulk_action_completed'::text,
  'skip_trace_requested'::text,
  'task_assigned'::text,
  'ai_responder_provider_failure'::text
]));

-- Race-safe dedupe backstop for the provider-failure throttle: two
-- concurrent inbound failures can both pass dispatch's read-then-insert
-- recent-check; this index makes the second insert conflict (and
-- createNotification swallows insert errors by design). Keyed per user,
-- per failure kind (titles are deterministic per kind — see
-- formatNotification), per UTC day.
create unique index if not exists notifications_ai_provider_failure_daily_key
  on notifications (user_id, title, (date_trunc('day', created_at at time zone 'utc')))
  where event_type = 'ai_responder_provider_failure';
