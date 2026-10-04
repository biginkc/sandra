# My Leads one-call close: status

Owner of this file: Claude session "Optimize my leads page" (branch
`claude/my-leads-one-call-close-decisions`). Root orchestrator and builders: post progress as PR
comments; ask the owner to update this file, or append under "Root notes".

Last updated: 2026-10-04 (overnight run)

## Plan
| Item | State |
|---|---|
| Decision record `DECISIONS-2026-10.md` | Astra `APPROVE_PLAN: YES`, `BLOCKING: 0` at `6edf9b68`; PR #791 open, CI green; merge awaits a root slot |
| Technical plan `TECH-PLAN-2026-10.md` | **Not yet approved.** Assembled draft; Opus 5.5 consistency review applied (77 fixes). Astra plan review 1 at cae86157: NO, 19 blocking — applied in e02a0597; re-review pending. The approval SHA will be recorded here. |

## Branch claims (one writer per branch)
| Branch | Owner | State |
|---|---|---|
| `claude/my-leads-one-call-close-decisions` | Claude "Optimize my leads page" | decision record, tech plan, this file |
| `claude/my-leads-p0-spike` | Codex root orchestrator (Sonnet 5.5 builder) | read-only harness in progress |
| `claude/my-leads-p1e-housekeeping` | Claude "Optimize my leads page" (Sonnet 5.5 builder) | claimed, build starts after plan repairs land |
| all other stack branches | unclaimed | claim here before writing |

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

## Root notes

## For root: production migration gate
Verified facts (gh api, 2026-10-04): `.github/workflows/db-migrate-prod.yml` runs on `workflow_run` after "Apply Supabase migrations to test" succeeds on `main`, uses `environment: Production`, but the Production environment currently has `protection_rules: []` and `can_admins_bypass: false`: NO required reviewer is configured (the workflow comment at lines 90–98 claiming reviewer `biginkc` is stale). Recent runs 37161835804 and 37131642031 recorded no approvals and finished ~40 s after creation. So: merging to main applies the migration to production automatically within about a minute; there is no manual approval step.
No change made to repo settings; restoring the reviewer is Jarrad's call.

Migration reservation `20261004092000` is RELEASED — the Phase 4 before-image migration was removed (Phase 1e's housekeeping tables are the only before-image store). Slack may keep 092000.
