-- Dropbox Sign includes `test_mode` on every real signature-lifecycle event
-- (signature_request_sent/viewed/signed/all_signed/downloadable, etc). The
-- foundation's public.esign_safe_event_data_is_valid required the safe event
-- data key set to be EXACTLY the five original keys, so any payload carrying
-- test_mode failed validation, claim_esign_webhook_receipt raised 22023
-- ('invalid safe event data'), the webhook route returned 503, and Dropbox
-- Sign retried forever -- no esign_webhook_receipts row was ever written.
--
-- Production evidence (2026-09-03): Supabase edge logs show repeated
-- POST /rest/v1/rpc/claim_esign_webhook_receipt -> 400 at 06:03:05Z,
-- 06:03:13Z, 06:05:08Z, 06:05:41Z, 06:07:22Z, 06:08:06Z, 06:08:14Z for
-- signature request 6afe1a5b6690288277c053ed0421ca869f0bf7dc (Seller signed
-- at 06:03:03Z); zero rows in esign_webhook_receipts for it. callback_test
-- and template_created events (which do not carry test_mode) succeeded,
-- which is why the callback appeared "verified" earlier.
--
-- Fix: allow the key set to be either the original five keys, or those five
-- plus test_mode, where test_mode must be a jsonb boolean or jsonb null.
-- Every other check (types, regexes, lengths) is unchanged.
create or replace function public.esign_safe_event_data_is_valid(p_data jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_typeof(p_data) = 'object', false)
    and coalesce(
      (select array_agg(key order by key) from jsonb_object_keys(p_data) key),
      array[]::text[]
    )
      in (
        array[
          'event_time', 'event_type', 'related_signature_id',
          'reported_for_app_id', 'sign_request_id'
        ]::text[],
        array[
          'event_time', 'event_type', 'related_signature_id',
          'reported_for_app_id', 'sign_request_id', 'test_mode'
        ]::text[]
      )
    and jsonb_typeof(p_data -> 'event_time') = 'string'
    and (p_data ->> 'event_time') ~ '^[0-9]{1,20}$'
    and (p_data ->> 'event_time')::numeric <= 253402300799
    and jsonb_typeof(p_data -> 'event_type') = 'string'
    and (p_data ->> 'event_type') ~ '^[a-z0-9_]{1,128}$'
    and (
      not (p_data ? 'test_mode')
      or jsonb_typeof(p_data -> 'test_mode') in ('boolean', 'null')
    )
    and not exists (
      select 1 from jsonb_each(p_data) item
      where item.key in (
          'sign_request_id', 'related_signature_id', 'reported_for_app_id'
        )
        and jsonb_typeof(item.value) not in ('string', 'null')
        or (
          item.key in (
            'sign_request_id', 'related_signature_id', 'reported_for_app_id'
          )
          and jsonb_typeof(item.value) = 'string'
          and char_length(item.value #>> '{}') not between 1 and 256
        )
    );
$$;

comment on function public.esign_safe_event_data_is_valid(jsonb) is
  'Validates normalized eSign webhook safe event data. Accepts the original five-key shape, or that shape plus an optional test_mode boolean/null, since Dropbox Sign includes test_mode on real signature-lifecycle callbacks.';
