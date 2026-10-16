-- Rollback for 20261008150300_hold_alert_delivery_rpcs. Drops the two functions.
begin;

drop function if exists public.hold_alert_latest_status(uuid, uuid[]);
drop function if exists public.hold_alert_archive_rows(uuid, uuid[]);

commit;
