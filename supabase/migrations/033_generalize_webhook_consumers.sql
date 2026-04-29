-- 033_generalize_webhook_consumers.sql
--
-- Generalizes the `webhook_consumers` table to authenticate both
-- *lead intake* webhooks (Enzo dialer, future PPC landing pages) AND
-- *provider callback* webhooks (Tracerfy results, future skip-trace
-- vendors). One auth model, one admin surface, one rotation flow.
--
-- Before this migration, the table was lead-shaped: every row required
-- a `default_source` from the canonical 8-value lead source enum.
-- Tracerfy's webhook is a provider callback — it has no notion of a
-- "lead source" because no lead is being created; results are matched
-- back to existing skip-trace jobs by queue_id. Forcing every consumer
-- to claim a default_source was wrong.
--
-- New shape:
--   - `consumer_type` NOT NULL (no default) — must be 'lead' or 'provider'
--   - `default_source` nullable — required when type='lead', forbidden
--     when type='provider'
--   - Asymmetric CHECK enforces both rules
--
-- "No default on consumer_type" is deliberate. Forcing every future
-- INSERT to choose a type means a misclassified row can't slip in by
-- accident. Cheap to enforce now; impossible to retrofit cleanly once
-- the table has hundreds of rows.

begin;

-- 1. Add consumer_type. Two-step pattern (add nullable, backfill
-- existing rows to 'lead', then make NOT NULL) is necessary because
-- `add column ... not null` fails on a non-empty table without a
-- default. The default is then dropped so future INSERTs must
-- specify the value explicitly.
alter table public.webhook_consumers
  add column consumer_type text;

-- Existing rows are all lead-shaped (the only consumer in prod is
-- "Enzo Dialer" with default_source='cold_call', seeded earlier
-- this session).
update public.webhook_consumers
set consumer_type = 'lead'
where consumer_type is null;

alter table public.webhook_consumers
  alter column consumer_type set not null;

alter table public.webhook_consumers
  add constraint webhook_consumers_type_check
  check (consumer_type = any (array['lead', 'provider']));

-- 2. Make default_source nullable. The previous CHECK
-- (webhook_consumers_default_source_check) only validated the value
-- against the 8-source enum — it implicitly required NOT NULL
-- because the column was declared NOT NULL. Drop the column-level
-- NOT NULL; the new asymmetric CHECK below handles the per-type
-- nullability rule.
alter table public.webhook_consumers
  alter column default_source drop not null;

-- 3. Replace the old default_source CHECK with one that handles
-- the nullable case (Postgres CHECK semantics: predicate evaluating
-- to NULL passes, but we want to be explicit).
alter table public.webhook_consumers
  drop constraint if exists webhook_consumers_default_source_check;

alter table public.webhook_consumers
  add constraint webhook_consumers_default_source_check
  check (
    default_source is null
    or default_source = any (array[
      'dealmachine',
      'propstream',
      'driving_for_dollars',
      'referral',
      'cold_call',
      'sms',
      'web_form',
      'direct_mail'
    ])
  );

-- 4. The headline asymmetric rule:
--   - lead consumers MUST have default_source (drives auto-attribution)
--   - provider consumers MUST NOT have default_source (no lead is
--     being created; the column is meaningless)
alter table public.webhook_consumers
  add constraint webhook_consumers_type_source_match_check
  check (
    (consumer_type = 'lead' and default_source is not null)
    or
    (consumer_type = 'provider' and default_source is null)
  );

-- 5. Update the hot-path lookup index to include consumer_type so the
-- DB can satisfy `WHERE secret_hash = $1 AND consumer_type = $2 AND
-- enabled = true` from the index without a heap fetch. Each route
-- restricts to its own type, so partitioning by type matters.
drop index if exists idx_webhook_consumers_hash_enabled;

create index idx_webhook_consumers_hash_type_enabled
  on public.webhook_consumers (secret_hash, consumer_type)
  where enabled = true and revoked_at is null;

commit;
