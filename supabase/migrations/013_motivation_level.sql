-- ============================================================================
-- Feature 4h — Motivation level indicator (migration 013)
--
-- Secondary temperature signal on qualified leads. DOES NOT replace the
-- status enum — lives alongside it as a separate axis. Status says "where
-- in the pipeline" (new_lead / contacted / offer_sent / ...); motivation
-- says "how hot is this seller" (hot / warm / cold).
--
-- Nullable by design: a freshly-ingested lead has no temperature until a
-- VA has talked to the seller. Once the prospects/leads split lands
-- (Feature 4a+4b), the UI will gate motivation editing to status != 'prospect',
-- but the column allows null now and forever so pre-qualification rows
-- stay valid.
--
-- Text + check constraint instead of a true enum — matches how properties.status
-- already works. Easier to evolve (no alter-type dance), same query ergonomics.
-- ============================================================================

alter table properties
  add column motivation_level text
  check (motivation_level is null or motivation_level in ('hot', 'warm', 'cold'));

-- Partial index — only the handful of non-null rows are interesting for
-- "show me hot leads" queries, so a partial index stays small even as
-- the properties table grows.
create index idx_properties_motivation
  on properties (motivation_level)
  where motivation_level is not null;
