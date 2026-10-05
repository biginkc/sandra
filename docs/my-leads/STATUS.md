# My Leads one-call close: status

Owner of this file: Claude session "Optimize my leads page" (branch
`claude/my-leads-one-call-close-decisions`). Root orchestrator and builders: post progress as PR
comments; ask the owner to update this file, or append under "Root notes".

Last updated: 2026-10-04 (after #801 release)

## Plan
| Item | State |
|---|---|
| Decision record `DECISIONS-2026-10.md` | Astra `APPROVE_PLAN: YES`, `BLOCKING: 0` at `6edf9b68`; **merged to main** in PR #791 (merge `2138fec3`, 2026-10-04, root slot) |
| Technical plan `TECH-PLAN-2026-10.md` | Astra `APPROVE_PLAN: YES`, `BLOCKING: 0` at `78f6e7de` (3 rounds 19→4→0); **merged to main** in PR #791 (`2138fec3`). Plan text frozen; changes need re-review. |

## Branch claims (one writer per branch)
| Branch | PR | Owner | State |
|---|---|---|---|
| `claude/my-leads-one-call-close-decisions` | #791 | Claude "Optimize my leads page" | merged `2138fec3`; historical base, no further writes |
| `claude/my-leads-p0-spike` | none | Codex root orchestrator | Phase 0 harness, root-owned |
| `claude/my-leads-p1e-housekeeping` | #794 | Claude (Sonnet 5.5 builder) | **MERGED** `10eda0d9` into main. Migrations applied TEST + PROD, high-water `20261005110000`. Housekeeping NOT run at the time of #797 merge (later run, see below). |
| `claude/my-leads-p1a-core` | #797 | Claude (Sonnet 5.5 builder) | **MERGED** `46ad7e92` into main. Migrations applied TEST + PROD, high-water `20261005121500`. Feature flags table empty = all flags OFF. Housekeeping NOT run at the time of #797 merge (later run, see below). |
| `claude/my-leads-p1a-writers` | #798 | Claude (Sonnet 5.5 builder) | **MERGED** `afec04f4` into main. Migrations 20261005130000-130500 applied TEST + PROD (test and prod migrate runs on afec04f4 succeeded). Flags still OFF. |
| `claude/my-leads-p1e-reassign-scope` | #806 | Claude | **MERGED** `02c1dcaf` into main (reassign `--from`, migration 20261005122000 applied). |
| `claude/my-leads-p1e-reassign-scope-2` | #808 | Claude | **MERGED** `c72f90f5` into main (migration 20261005140000 applied). |
| `claude/my-leads-p1b-strip` | #799 | Claude (Sonnet 5.5 builder) | **MERGED** `001cb1fd` into main (migration 20261005150000 applied TEST + PROD; prod high-water now `20261005150000`). |
| `claude/my-leads-p1c-prompt` | #800 | Claude (Sonnet 5.5 builder) | **MERGED** `a5ba2b58` into main (migration 20261005160000 applied TEST + PROD; prod high-water now `20261005160000`). |
| `claude/my-leads-p1c2-seller-reminders` | #801 | Claude (Sonnet 5.5 builder) | **MERGED** `abf3edd6` into main (migration 20261005170000 applied; prod high-water `20261005170000`). Reminders table 0 rows, flag OFF. Reclaim-after-reschedule duplicate-text edge is a pre-ENABLE fix, tracked. |
| `claude/my-leads-p1d-link-capture` | #802 | Claude (Sonnet 5.5 builder) | draft, base now `main` (retargeted after #801 merge); `origin/main` abf3edd6 merged in; head `1af972f1` before this docs commit (migration 20261005180000). Phase 1 nearly complete. |
| `claude/my-leads-p2-data-plane` | #803 | Phase 2 sole writer | draft, built, NOT merged; Opus YES at `757e01c0` |
| `claude/my-leads-p2-ui` | #809 | Phase 2 writer | draft, built, NOT merged; Opus YES at `8ab5fc5a`; owner Claude Sonnet 5.5 builder, pre-enable fixes in progress (keep key after expired callback; resume polling on flag change) |
| `claude/my-leads-p2-acceptance` | none yet | Claude Sonnet 5.5 builder | in progress; Phase 2 acceptance slice (fixture, T0/T3/T7/T8 spec, CI step), based on `claude/my-leads-p2-ui`; no migration, no `src/` change |
| `claude/my-leads-p4-acceptance` | #804 | Phase 4 writer | draft, built, NOT merged; Opus YES at `3cec0c19` |
| `claude/my-leads-p3-comps` | #805 | Phase 3 writer | draft, built, NOT merged; Opus YES at `bb86747e` |
| `claude/my-leads-p3-call-screen` | #807 | Phase 3 writer | draft, built, NOT merged; Opus YES at `a908ad1c` |
| `p3-send-card`, `p1a-retire` | none | none | NOT built yet |
| all other branches | none | unclaimed | claim here before writing |

Current heads: `gh pr view <n> --json headRefOid` (stack was rebased onto main on 2026-10-04; heads change on every cascade).

## Phase 1 RC approvals
Astra `APPROVE_MERGE: YES` / 0 blocking and Fable YES / 0 blocking, at these SHAs (the approvals bind
those SHAs only):
#794 `4c684f5a`, #797 `256ec287`, #798 `37fa7458`, #799 `cf6554d9`, #800 `5f44a1dd`, #801 `8d96787d`,
#802 `1cef1365`. Rebased heads need unchanged-review confirmation via `git range-diff` (all commits `=`).

## Housekeeping and reassign (2026-10-04, from coordinator)
- Housekeeping close-attempts run 02166c21 applied (PROD 2026-10-04; run 02166c21-e9a4-4b79-9312-db4f5b2d8135): 134 pending attempts > 7 days → not_logged, 134 before-images, rollback available via `rollback --run <id>`.
- reassign run c599fb65 applied: Mel's 12 leads reassigned to Jarrad; Maria's 2 DNC-locked leads left in place.
- #806 (`--from`, migration 20261005122000) and #808 (queue-scope fix, migration 20261005140000, merge `c72f90f5`) are merged.

## Release authority
Jarrad, 2026-10-04 18:05 CDT: Phase 1 PRs merge as each is green, approved at its current head, and
its preconditions hold; receipts go to root.

## Jarrad decisions (2026-10-04, "walk")
- KPI forward change accepted.
- Seller reminders keep the first-text rule.
- #801 pre-activation duplicate-text fix pending.
- All My Leads flags stay OFF.

## Corrections applied from root (2026-10-04)
- Secrets: `op` CLI with the BMH service account only, never the 1Password SDK.
- ATTOM: exact item `ATTOM - API`; trial spend up to $20 total (Jarrad, 2026-10-04), hard-capped in the script; production monthly cap stays `0` until he sets it after the verdict.
- Consistency review (Opus 5.5) applied: 77 fixes; rulings: feature flags + migration-tolerant merges, dial-eligibility patch, single before-image store, retire last.
- Root serializes all merges/migrations/deploys by exact-SHA slot; work continues meanwhile.

## Approved defaults in use
Offer follow-up 3 days before closing 09:00 America/Chicago (next morning if sooner); stale attempts
→ `not_logged`; open appointments → phone; Maria's/Mel's leads and open tasks → Jarrad; ARV =
Jarrad's number; ATTOM cap 0; unmatched personal Dialpad payloads redacted after 30 days.

## Waiting on Jarrad (morning)
Live Dialpad call test (desktop app + owned phone); title company and buyer entity names; seller
reminder SMS text (verbatim); AI-facts prompt text (verbatim); ATTOM thresholds (trial spend up to $20 is approved).

## For root: production migration gate
Verified facts (gh api, 2026-10-04): `.github/workflows/db-migrate-prod.yml` runs on `workflow_run` after "Apply Supabase migrations to test" succeeds on `main`, uses `environment: Production`, but the Production environment currently has `protection_rules: []` and `can_admins_bypass: false`: NO required reviewer is configured (the workflow comment at lines 90–98 claiming reviewer `biginkc` is stale). Recent runs 37161835804 and 37131642031 recorded no approvals and finished ~40 s after creation. So: merging to main applies the migration to production automatically within about a minute; there is no manual approval step.
No change made to repo settings; restoring the reviewer is Jarrad's call.

Migration reservation `20261004092000` is RELEASED (the Phase 4 before-image migration was removed; Phase 1e's housekeeping tables are the only before-image store). Slack may keep 092000.
#794's migrations are applied on TEST and PROD; the prod high-water is `20261005110000`. Any earlier-timestamp open PR must retimestamp its migrations after `20261005110000` before merging.
