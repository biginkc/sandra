-- Voicemail drop PR 7: durable proof of delivery.
--
-- Drop Cowboy keeps a drop's proof-of-delivery recording for 7 days. When the
-- contact.rvm.receipt webhook arrives, Sandra downloads the audio and keeps its
-- own copy in a private bucket.
--
-- 1. voicemail_drops gains the stored copy's facts and a small retry state.
-- 2. Private bucket voicemail-drop-proofs, service role only: no
--    storage.objects policies, so no member of any org can read it directly.
--    The app checks org access, then hands out a short-lived signed URL.
--    Object path: <org_id>/<voicemail_drops.id>.<ext>.
-- Rollback: supabase/rollbacks/20261021200500_voicemail_drop_proof_copy.sql
begin;

alter table public.voicemail_drops
  add column if not exists proof_url_at timestamptz,
  add column if not exists proof_storage_path text,
  add column if not exists proof_content_type text,
  add column if not exists proof_size_bytes bigint,
  add column if not exists proof_fetched_at timestamptz,
  add column if not exists proof_copy_status text,
  add column if not exists proof_copy_attempts integer not null default 0,
  add column if not exists proof_copy_next_at timestamptz,
  add column if not exists proof_copy_error text;

alter table public.voicemail_drops
  drop constraint if exists voicemail_drops_proof_copy_status_check;
alter table public.voicemail_drops
  add constraint voicemail_drops_proof_copy_status_check
  check (proof_copy_status is null or proof_copy_status in ('pending', 'stored', 'failed'));

alter table public.voicemail_drops
  drop constraint if exists voicemail_drops_proof_stored_facts;
alter table public.voicemail_drops
  add constraint voicemail_drops_proof_stored_facts
  check (
    (coalesce(proof_copy_status, '') = 'stored') = (proof_storage_path is not null)
    and (proof_storage_path is null or (
      proof_content_type is not null and proof_size_bytes is not null and proof_fetched_at is not null
      and proof_storage_path ~ ('^' || org_id::text || '/' || id::text || '\.[a-z0-9]{2,4}$')
    ))
  );

-- Sweep queue: copies due for a retry, plus receipts whose first copy never
-- got as far as recording a result (proof_url_at set, no copy status).
create index if not exists idx_voicemail_drops_proof_copy_due
  on public.voicemail_drops (proof_copy_next_at)
  where proof_copy_status = 'pending' or (proof_copy_status is null and proof_url_at is not null);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('voicemail-drop-proofs', 'voicemail-drop-proofs', false, 26214400,
        array['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mp4', 'audio/x-m4a',
              'audio/aac', 'audio/ogg', 'audio/webm']::text[])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

commit;
