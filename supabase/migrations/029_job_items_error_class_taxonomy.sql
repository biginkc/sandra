-- 029_job_items_error_class_taxonomy.sql
--
-- Extends the `job_items.error_class` check constraint with five
-- new categories so the skip-trace runner can distinguish:
--
--   - `provider_no_data`   — vendor genuinely empty for a CASS-clean
--                            address. Terminal; retry would waste credits.
--   - `address_unverified` — CASS-unverified address; vendor can't
--                            match it. Fixable upstream by running
--                            CASS verification first.
--   - `provider_transient` — HTTP 429 / 5xx; vendor will likely answer
--                            on a retry once it recovers.
--   - `provider_unknown`   — any other ProviderError; default-retryable
--                            but worth a closer look.
--   - `internal`           — already used by retry actions when the
--                            background `after()` step throws, but
--                            wasn't listed in the constraint. Adding
--                            it closes a latent gap.
--
-- The retry button on /jobs/[id] reads error_class to decide which
-- items are retryable vs terminal — so an item that can't be classified
-- because of this constraint gets stranded as `null` and the UI
-- falsely treats it as retryable. This migration is a precondition
-- for that whole feature working honestly.

alter table job_items
  drop constraint if exists job_items_error_class_check;

alter table job_items
  add constraint job_items_error_class_check
  check (
    error_class is null
    or error_class = any (array[
      'validation',
      'transient',
      'provider',
      'database',
      'authorization',
      'configuration',
      'internal',
      'provider_no_data',
      'address_unverified',
      'provider_transient',
      'provider_unknown'
    ])
  );
