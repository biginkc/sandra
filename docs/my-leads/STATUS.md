# My Leads one-call close: status

Owner of this file: Claude session "Optimize my leads page" (branch
`claude/my-leads-one-call-close-decisions`). Root orchestrator and builders: post progress as PR
comments; ask the owner to update this file, or append under "Root notes".

Last updated: 2026-10-04 17:30 America/Chicago

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
| `claude/my-leads-p1e-housekeeping` | #794 | Claude (Sonnet 5.5 builder) | **MERGED** `10eda0d9` into main. Migrations applied TEST + PROD, high-water `20261005110000`. Housekeeping NOT run. |
| `claude/my-leads-p1a-core` | #797 | Claude (Sonnet 5.5 builder) | draft; base retargeted to `main`; main (`10eda0d9`) merged in; full CI incl. disposable-DB integration suite now runs |
| `claude/my-leads-p1a-writers` | #798 | Claude (Sonnet 5.5 builder) | draft, stacked on #797 |
| `claude/my-leads-p1b-strip` | #799 | Claude (Sonnet 5.5 builder) | draft, stacked on #798 |
| `claude/my-leads-p1c-prompt` | #800 | Claude (Sonnet 5.5 builder) | draft, stacked on #799 |
| `claude/my-leads-p1c2-seller-reminders` | #801 | Claude (Sonnet 5.5 builder) | draft, stacked on #800; pre-activation duplicate-text fix pending |
| `claude/my-leads-p1d-link-capture` | #802 | Claude (Sonnet 5.5 builder) | draft, stacked on #801 |
| `claude/my-leads-p2-data-plane` | none | Phase 2 sole writer | WIP, no PR yet |
| all other branches | none | unclaimed | claim here before writing |

Current heads: `gh pr view <n> --json headRefOid` (stack was rebased onto main on 2026-10-04; heads change on every cascade).

## Phase 1 RC approvals
Astra `APPROVE_MERGE: YES` / 0 blocking and Fable YES / 0 blocking, at these SHAs (the approvals bind
those SHAs only):
#794 `4c684f5a`, #797 `256ec287`, #798 `37fa7458`, #799 `cf6554d9`, #800 `5f44a1dd`, #801 `8d96787d`,
#802 `1cef1365`. Rebased heads need unchanged-review confirmation via `git range-diff` (all commits `=`).

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
