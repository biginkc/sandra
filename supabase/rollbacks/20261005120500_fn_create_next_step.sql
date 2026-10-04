-- Roll back 20261005120500_fn_create_next_step: drops the function. No data is written by the
-- migration, but rows created through it stay (they are ordinary tasks). Ship with a code
-- revert: schemaReady('next_step_write') turns false once the function is gone, so the
-- booking paths fall back to fn_book_appointment within the 30 second negative cache.
begin;
drop function if exists public.fn_create_next_step(
  uuid, uuid, uuid, text, text, timestamptz, uuid, uuid, text, timestamptz, text, text, text,
  uuid, uuid, text, boolean, boolean);
commit;
