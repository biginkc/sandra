# Session Handoff: Phase 2 Context Complete

**Date:** 2026-05-05 (overnight session)
**Branch:** main — 1 commit ahead of origin (push pending)
**Last commit:** `f2e1455` (Phase 2 CONTEXT.md)
**Prod URL:** https://sandra-sooty.vercel.app
**GSD state:** STATE.md — Phase 02, context gathered, ready for planning

---

## Current State

Phase 01.5 UAT formally approved. Phase 02 discuss-phase complete — CONTEXT.md written and committed. Ready to plan. The commit `f2e1455` needs to be pushed to origin.

---

## What Shipped This Session

| Action | Effect |
|--------|--------|
| Phase 01.5 UAT approved | `01.5-HUMAN-UAT.md` marked passed; `01.5-VERIFICATION.md` status → verified |
| Phase 02 directory created | `.planning/phases/02-market-vocabulary-refactor/` |
| `02-CONTEXT.md` written | All decisions locked — county-as-market, counties table as source of truth, 20 counties, FIPS backfill strategy |
| STATE.md updated | Current phase → 02, next action → `/gsd-plan-phase 02` |

---

## Key Infrastructure Changes (Phase 2 — not yet built, decisions locked)

**Decision summary from CONTEXT.md:**
- `KNOWN_MARKETS` array + `WizardMarket` union type → eliminated, replaced by `counties` table
- `counties` table (already in DB, currently empty) seeded with 20 counties across MO, KS, LA, AR, IL
- `counties.market` = canonical market string (e.g., "Johnson County KS")
- `properties.market` stays as a synced text cache; `properties.county_id` FK populated from `fips_code`
- Backfill: 1,149 rows have `fips_code` → derive `county_id`; ~1,358 without FIPS stay as "Kansas City" temporarily
- Next migration number: 043 (current highest is 042)

**Key DB facts discovered this session:**
- `properties` has `county_id` (uuid FK), `fips_code` (text), `cass_raw_response` (jsonb)
- CASS response embeds `metadata.county_fips` + `metadata.county_name` — county is already in the data
- `counties` table columns: `id, name, state, market, org_id, created_at`
- `counties` table does NOT yet have a `fips_code` column — planner must add it in migration 02-01

**County list for seed (from BMH Group Drive folder):**
MO: Buchanan, Boone, Clay, Jackson, Camden, Saint Charles, Saint Louis, Platte, Taney, Franklin, Jefferson, Greene
KS: Johnson
LA: Lincoln Parish
AR: Garland, Carroll
IL: Madison, Saint Clair
Plus from FIPS data (confirm active): Cass County MO, Wyandotte County KS, Riley County KS

---

## Memory Updates

No new memory files this session. Existing memories are current.

---

## What's In Flight

**Immediate next step:** Push main to origin, then `/gsd-plan-phase 02`

```bash
git push
```

Then in a fresh tab:
```
/gsd-plan-phase 02
```

**Drain still running:** 939 bulk-queued messages draining at 1/min from 8 AM CDT May 5. Check via Supabase MCP:
```sql
SELECT status, COUNT(*) FROM messages WHERE created_at > NOW() - INTERVAL '48 hours' GROUP BY status ORDER BY count DESC;
```

---

## Known Not-Done

- **Push pending:** `f2e1455` not yet pushed to origin
- **Cass/Wyandotte/Riley confirmation:** Are these 3 counties (from FIPS data) active BMH markets? Confirm before seeding
- **`counties` needs `fips_code` column:** Not in current schema — must add in migration 02-01 for backfill JOIN to work
- **~1,358 properties without FIPS:** Will retain "Kansas City" market until re-CASS'd — acceptable for now
- **Stray untracked items:**
  - `.claude/worktrees/Sandra Design System` — `rm -rf ".claude/worktrees/Sandra Design System"`
  - `docs/design/screenshots/phase-1-5-uat/` — commit or gitignore
  - `docs/handoff/2026-05-04-sms-volume-complete.md` — commit or delete
- **E2E CI still fails** — `@sandra/tokens` can't resolve in CI; fix separately
- **~159 overflow messages** resume drain 8 AM CDT May 6

---

## Test Credentials

- **Prod login**: `PROD_EMAIL` / `PROD_PASSWORD` in `.env.local` (gitignored)
- **Jarrad's test phone**: `+13107540662` — SMS smoke only, never real leads
- **Twilio test receiver**: `+18148097074` — inbound-only canary, never a sender
- **Test suite user**: `claude@test.com` / `test12345` (test Supabase `ncsngxlcyxylaeskiteu` only)
- **Prod Supabase project**: `copflsklaefwzipsrjqz`

---

## Verification Scripts

```bash
# Confirm main is clean and pushed
git log --oneline -5
git status

# TypeScript + tests
node_modules/.bin/tsc --noEmit
npm test && npm run test:rtl

# Check drain progress
# (via Supabase MCP prod project copflsklaefwzipsrjqz)
SELECT status, COUNT(*) FROM messages WHERE created_at > NOW() - INTERVAL '48 hours' GROUP BY status ORDER BY count DESC;

# Confirm counties table is empty (ready for seed in Phase 2)
SELECT COUNT(*) FROM counties;

# Confirm properties FIPS coverage
SELECT COUNT(*) total, COUNT(fips_code) has_fips, COUNT(county_id) has_county_id FROM properties;
```

---

## Critical Learnings

1. **County data is already in CASS response** — `cass_raw_response[0].metadata.county_fips` + `.county_name` embedded in the jsonb. No geocoding needed for backfill.
2. **`counties` table already exists in prod** — designed for this exact feature; empty and waiting.
3. **Only "Kansas City" exists in prod data** — St. Louis, Dayton, Lake of the Ozarks are code-only; clean cutover with no alias needed.
4. **BMH operates in 5 states** — MO, KS, LA, AR, IL. The old 4-city market model was a placeholder; county-as-market is the real segmentation.
5. **`counties` table missing `fips_code` column** — must add in first migration or the backfill JOIN can't work.
6. **BMH Google Drive accessible via Google Drive MCP** — search with `owner = 'jarrad@bmhgroupkc.com'` or by folder ID `0AADG_usjVsx7Uk9PVA` (BMH root). Shared Drive folder queries may return empty; use owner filter instead.
