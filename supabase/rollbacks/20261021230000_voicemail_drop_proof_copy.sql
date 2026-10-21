-- Roll back 20261021230000_voicemail_drop_proof_copy.
-- Refuses to run while any stored proof copy exists: delete the objects in
-- the voicemail-drop-proofs bucket first, so no recording is orphaned or
-- silently lost. Storage forbids deleting storage rows from SQL, so the
-- empty bucket is removed afterwards with the Storage API
-- (supabase.storage.deleteBucket('voicemail-drop-proofs')); while it stays it
-- is private, empty and unused.
begin;

do $$
begin
  if exists (select 1 from public.voicemail_drops where proof_storage_path is not null)
     or exists (select 1 from storage.objects where bucket_id = 'voicemail-drop-proofs') then
    raise exception 'voicemail drop proof copies still stored; remove them before rolling back';
  end if;
end;
$$;

drop index if exists public.idx_voicemail_drops_proof_copy_due;
alter table public.voicemail_drops
  drop constraint if exists voicemail_drops_proof_stored_facts,
  drop constraint if exists voicemail_drops_proof_copy_status_check,
  drop column if exists proof_copy_error,
  drop column if exists proof_copy_next_at,
  drop column if exists proof_copy_attempts,
  drop column if exists proof_copy_status,
  drop column if exists proof_fetched_at,
  drop column if exists proof_size_bytes,
  drop column if exists proof_content_type,
  drop column if exists proof_storage_path,
  drop column if exists proof_url_at;

commit;
