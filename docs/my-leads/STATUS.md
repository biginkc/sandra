# My Leads one-call close: status

Owner of this file: Claude session "Optimize my leads page" (branch
`claude/my-leads-one-call-close-decisions`). Root orchestrator and builders: post progress as PR
comments; ask the owner to update this file, or append under "Root notes".

Last updated: 2026-10-04 06:30 America/Chicago (overnight run)

## Plan
| Item | State |
|---|---|
| Decision record `DECISIONS-2026-10.md` | Astra `APPROVE_PLAN: YES`, `BLOCKING: 0` at `6edf9b68`; **merged to main** in PR #791 (merge `2138fec3`, 2026-10-04, root slot) |
| Technical plan `TECH-PLAN-2026-10.md` | Astra `APPROVE_PLAN: YES`, `BLOCKING: 0` at `78f6e7de` (3 rounds 19→4→0); **merged to main** in PR #791 (`2138fec3`). Plan text frozen; changes need re-review. |

## Branch claims (one writer per branch)
| Branch | PR | Owner | State |
|---|---|---|---|
| `claude/my-leads-one-call-close-decisions` | #791 | Claude "Optimize my leads page" | merged `2138fec3`; branch kept as historical base, no further writes |
| `claude/my-leads-p0-spike` | — | Codex root orchestrator (Sonnet 5.5) | Phase 0 harness, root-owned |
| `claude/my-leads-p1e-housekeeping` | #794 (base `main`) | Claude (Sonnet 5.5 builder) | draft; Opus `OPUS_APPROVE: YES` at `d017f669`; main merged in |
| `claude/my-leads-p1a-core` | #797 (base p1e) | Claude (Sonnet 5.5 builder) | draft; Opus `OPUS_APPROVE: YES` at `f4594887`; review notes 1–3 being applied |
| `claude/my-leads-p1a-writers` | — | Claude (Sonnet 5.5 builder) | building on p1a-core |
| all other stack branches | — | unclaimed | claim here before writing |

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
- Astra plan review 2 at 37f33448: NO, 4 blocking (reminder retry key, contract replay payload, facts ON CONFLICT predicate, backfill future follow-ups) + 1 non-blocking — applied; review 3 pending.
- Build: P1e draft PR #794 (a03bb9c3) open, Opus review running; P1a-core building on claude/my-leads-p1a-core (stacked on #794).
- Astra plan review 3 at 78f6e7de: YES, 0 blocking. Non-blocking note for the P3 send-card builder: align §3.5 helper signatures with `send_payload`/`submission_hash` and ignore §3.7's older 'compare submitted payload against requestHash' sentence; the replay rule in §3.6 and its regression test govern.
- P1e PR #794: Opus intermediate review OPUS_APPROVE YES, 0 blocking; its 5 notes applied at d017f669 (locked id-array fence, tasks of the old assignee only, extra rollback blockers, explicit cutoff, host-bound confirm hash, op service account required). Integration suites run locally (CI e2e only runs on PRs into main). Carry to P1c: UI labels for `not_logged` in my-leads/adapter.ts and leads/[id]/acquisition-history.tsx.
- PR #791 merged at root's exact slot: head `945d35d3` onto main `7fb2c973`; merge `2138fec3`, tree `aa335b92` = proven merge tree, no non-doc path changed. Deployments on the merge: Vercel Production success (docs-only, runtime unchanged); Railway `sandra-sentry-repair / production` failure — pre-existing, every deploy of that service has failed since at least `f3bf65b2`; no Supabase migration workflow ran.
- P1a-core Opus review (`f4594887`): integration failures are identical at base and head (23 = 23, Norma/Dialpad/direct/search/outreach-dispo), so none are caused by the branch. Notes applied before writers route Norma through `fn_create_next_step`: service-only source keys/origins/window bypass; no reopening a superseded chain row; replay tolerant of legacy-phone vs new in-person mode.
