# Ledger refresh — 2026-09-20

Refreshed `full_backfill_ledger.csv` (originally produced by the 2026-09-20
live-eval session) against **live** `properties.outreach_dispo` in the
`sandra-crm` production project (`copflsklaefwzipsrjqz`). Read-only query
only — no writes, per the standing pattern that Claude produces the ledger
and Codex executes any actual database changes.

## Method

1. Queried `select id, outreach_dispo, updated_at from properties where
   outreach_dispo is not null` against production (9,719 rows).
2. Compared every ledger row's `current_outreach_dispo` snapshot against the
   live value for the same `property_id`.
3. Identified property IDs with a non-null disposition that aren't in the
   ledger at all (gained a disposition after the snapshot).

## Result

- **0 of 9,620 existing ledger rows drifted** — every property's live
  `outreach_dispo` still matches the ledger's snapshot value. The existing
  ledger (including the 201 rows flagged `RECLASSIFY_REVIEW_SUPPRESSION`)
  is still current; none of it was re-classified or altered by this refresh.
- **99 new properties** gained a disposition since the snapshot. All 99 are
  `booked_appointment` (79) or `callback_requested` (20) — both explicitly
  excluded from Jev's taxonomy (they need a real booking/scheduling
  mutation, not text classification; see the integration plan's "broader
  outcomes" section). None are pending Jev classification. Appended to the
  ledger as `action=OUT_OF_SCOPE_SCHEDULING` for completeness, not as new
  backfill work.

## What this does NOT do

- Does not re-run Jev classification for any row, existing or new — per the
  standing instruction not to re-run the full-population eval without a
  reason. The 0-drift result gave no reason to.
- Does not resolve the 201-row `RECLASSIFY_REVIEW_SUPPRESSION` ambiguity's
  execution — that's confirmed *safe* to apply (see the plan doc: suppression
  is tracked in `consent_events`, not `outreach_dispo`), but applying it is
  still Codex's job per the standing ledger-write pattern, not this refresh.
- Does not write anything to any database.

## Files

- `full_backfill_ledger.csv` — refreshed, 9,719 rows (9,620 original +
  99 out-of-scope-scheduling appended).
