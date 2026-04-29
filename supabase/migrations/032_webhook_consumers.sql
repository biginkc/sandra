-- 032_webhook_consumers.sql
--
-- Per-consumer authentication for the lead-import webhook.
--
-- Original design (in this same PR before redesign): a single
-- `LEAD_WEBHOOK_SECRET` env var that every integrator (Enzo, future
-- PPC landing pages, future "we buy houses" sites) would have to
-- share. That has three problems:
--
--   1. Can't revoke individually — leak Enzo's secret and you'd have
--      to rotate the global secret, breaking every other consumer.
--   2. Can't audit per-source — the webhook fires from "the secret,"
--      not from "Enzo" specifically.
--   3. Can't bind a default source per consumer. Today every payload
--      must include `source` in the body; with per-consumer rows the
--      consumer's row forces source="cold_call" for Enzo,
--      source="web_form" for PPC, etc.
--
-- New design: each integrator gets a row in `webhook_consumers` with
-- a unique secret. The route hashes the URL secret and looks up the
-- row. The row's `default_source` is applied to the incoming payload.
-- Disabling a consumer = `enabled=false`. Rotating = update the hash
-- to a new value.
--
-- The plaintext secret is NEVER stored — only the SHA-256 hash. The
-- admin UI (future PR) returns the plaintext secret ONCE at creation
-- and never again.

create table public.webhook_consumers (
  id uuid primary key default gen_random_uuid(),
  -- Human-readable name shown in the admin UI. Required + unique so
  -- a future "rotate" or "disable" UI has unambiguous targets.
  name text not null unique,
  -- SHA-256 hash of the secret. We never store the plaintext —
  -- the admin UI returns it ONCE at creation. Hex-encoded so a
  -- migrating admin can spot-check via `select encode(...)`.
  secret_hash text not null unique,
  -- The default `properties.source` value for leads from this
  -- consumer. Lets Enzo's webhook payload omit `source` and still
  -- get tagged correctly. Validated against the same canonical
  -- list as `properties.source` (migration 030).
  default_source text not null,
  enabled boolean not null default true,
  -- Optional notes (admin-only) for context: "Enzo dialer rotation
  -- 2026-04-29 — VAs Mateo and Liz."
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  -- Updated whenever the route successfully matches this row. Used
  -- by the admin UI to surface "last fired 2 minutes ago" and to
  -- detect stale / unused consumers.
  last_used_at timestamptz,
  -- Set when an admin disables a consumer. Independent of `enabled`
  -- so the audit trail survives a re-enable.
  revoked_at timestamptz,
  constraint webhook_consumers_default_source_check check (
    default_source = any (array[
      'dealmachine',
      'propstream',
      'driving_for_dollars',
      'referral',
      'cold_call',
      'sms',
      'web_form',
      'direct_mail'
    ])
  )
);

-- Lookup index — every webhook hit hashes the URL secret and looks
-- up by hash. Hot path. Hash column is unique so a btree on it
-- doubles as the dedup constraint and the lookup index.
create index idx_webhook_consumers_hash_enabled
  on public.webhook_consumers (secret_hash)
  where enabled = true and revoked_at is null;

-- ----------------------------------------------------------------------------
-- RLS — admins read/write, no anon access. Service-role bypasses RLS,
-- so the webhook route (which uses service-role) is unaffected.
-- ----------------------------------------------------------------------------
alter table public.webhook_consumers enable row level security;

create policy "admins can read webhook_consumers"
  on public.webhook_consumers for select
  using (auth.role() = 'authenticated');

create policy "admins can insert webhook_consumers"
  on public.webhook_consumers for insert
  with check (auth.role() = 'authenticated');

create policy "admins can update webhook_consumers"
  on public.webhook_consumers for update
  using (auth.role() = 'authenticated');

-- ----------------------------------------------------------------------------
-- Optional bootstrap: if `LEAD_WEBHOOK_SECRET` is in the deployment env,
-- the deploy script SHOULD seed a "Generic" row with its hash so the
-- transition from single-secret to per-consumer is zero-downtime.
-- We don't seed from SQL because the env var isn't visible from inside
-- the migration — the application's startup path or admin UI handles
-- this.
-- ----------------------------------------------------------------------------
