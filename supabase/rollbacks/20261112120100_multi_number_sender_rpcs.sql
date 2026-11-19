-- Rollback for 20261112120100_multi_number_sender_rpcs.
-- Drops the sender predicates, settings trigger and RPCs. Nothing in PR 1 sends through them;
-- campaign create/revive's sendable check then fails closed (RPC missing) until the
-- application is rolled back too.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop trigger if exists sms_sender_settings_enforce on public.sms_sender_settings;
drop function if exists public.enforce_sms_sender_settings();
drop function if exists public.campaign_kpis_by_sender(uuid);
drop function if exists public.set_campaign_sender_paused(uuid, text, boolean);
drop function if exists public.add_campaign_sender_numbers(uuid, text[]);
drop function if exists public.admin_reassign_sms_sender(uuid, text, text);
drop function if exists public.preview_sms_sender_conflicts(uuid);
drop function if exists public.adopt_sms_sender_assignments(uuid, text, int);
drop function if exists public.admit_sms_submission(uuid, text, text);
drop function if exists public.resolve_sms_sender(uuid, text, uuid, boolean, text, text);
drop function if exists public.sms_sender_resolve_core(uuid, text, public.sms_sender_settings, uuid, boolean, text, text, text);
drop function if exists public.sms_sender_commitments(uuid, text);
drop function if exists public.sms_sender_evidence(uuid, text);
drop function if exists public.is_rep_sms_reply(uuid, text, text, timestamptz);
drop function if exists public.sms_row_dispatched(text, jsonb);
drop function if exists public.is_possibly_submitted_sms(text, jsonb);
drop function if exists public.is_pool_sender(uuid, text);
drop function if exists public.is_sendable_sender(uuid, text, text);
drop function if exists public.sms_sender_seller_lock_key(uuid, text);
drop function if exists public.sms_sender_settings_lock_key(uuid);
drop function if exists public.sms_sender_assert_org_access(uuid);

commit;
