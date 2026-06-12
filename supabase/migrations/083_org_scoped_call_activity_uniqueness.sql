-- ============================================================================
-- 083 — org-scope the call_activities writeback uniqueness key.
--
-- Gate-2 review finding on PR #251 (Jitter DNC writeback): migration 058
-- defined `unique (provider, jitter_attempt_id)` GLOBALLY. The writeback
-- route upserts on that key with the service-role client, so an org-A
-- consumer whose body ids are perfectly self-consistent (and therefore
-- passes the route's org guard) could still UPDATE an existing org-B row
-- whenever the jitter_attempt_id collides — rewriting that row's
-- org_id/property_id/contact_id, and letting the follow-up
-- dialer_batch_items.last_call_activity_id pointer update aim an org-A
-- batch item at a formerly-org-B activity.
--
-- Fix: uniqueness becomes (org_id, provider, jitter_attempt_id), so a
-- colliding attempt id from another org INSERTS its own row instead of
-- hijacking the existing one. Existing data cannot violate the new index:
-- the old key guaranteed (provider, jitter_attempt_id) pairs were globally
-- unique, which implies uniqueness within any org partition.
--
-- Ordering: create the new index BEFORE dropping the old constraint so
-- concurrent writeback upserts never see a window with no uniqueness.
-- Both statements are idempotent — the CI migration workflow re-applies
-- this file to prod and test without effect after this has run once.
-- ============================================================================

begin;

create unique index if not exists idx_call_activities_org_provider_attempt
  on public.call_activities (org_id, provider, jitter_attempt_id);

alter table public.call_activities
  drop constraint if exists call_activities_provider_jitter_attempt_id_key;

commit;
