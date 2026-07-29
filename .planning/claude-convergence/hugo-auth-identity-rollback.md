# Hugo Auth Identity-Key Rollback

## Goal

Provide a manual-only, outside-migrations rollback for the exact pending
`20260729010000_hugo_auth_identity_key_lifecycle_lock.sql` helper-extraction
delta. The rollback must preserve Auth identities, durable activity, lifecycle
receipts, trigger serialization, and existing service-role app access, then
allow the forward migration to replay cleanly.

## Authority and boundaries

- Worktree: `codex/hugo-user-hub-v1-sandra` only.
- No hosted database, production deploy, provider, Chrome, or other worktree
  actions.
- Rollback artifact is manual-only and outside `supabase/migrations`.
- No secrets or credentials are included.

## Acceptance gates

- [x] Rollback refuses an unexpected forward shape before changing objects.
- [x] Rollback restores the exact pre-delta inline prepare/delete receipt paths.
- [x] Rollback drops only the helper introduced by the delta.
- [x] Service-role execution remains available; authenticated execution remains
  denied; Auth identity-key trigger shape remains unchanged.
- [x] PostgreSQL 17 forward -> rollback -> forward replay proof passes against a
  disposable local cluster with real durable identity/activity/receipt rows.
- [x] Existing Hugo SQL verification remains green.
- [ ] Claude review of the final pushed head (CLI was authenticated and
  launched in read-only plan mode, but produced no response after 3 minutes;
  terminated and recorded as `claude_surface_timeout`).

## Evidence

- Preflight: `/opt/homebrew/opt/postgresql@17/bin/{initdb,psql}` present;
  `claude` installed and authenticated (`claude auth status`, values omitted);
  `gh` and `fallow` available.
- Baseline: `43bcfdbcd83e1b983e66c84a63a9245c20ddd0fc`.
- Focused proof: `npm run verify:hugo-rollback` passed on PostgreSQL 17. It
  applies the full chain, runs the manual rollback, checks unchanged Auth and
  durable-activity rows plus receipt behavior, replays the forward migration,
  and checks helper shape and privileges again.
- Existing proof: `npm run verify:hugo-sql` passed both hosted-snapshot-forward
  and fresh-full-chain lanes.
- Fallow: `fallow audit --base main --format compact` completed; findings are
  pre-existing branch-wide unused exports/dependencies and duplicated E2E
  fixture patterns, not this rollback artifact.
- Browser review: not applicable; this is database-only DDL/test tooling with
  no user-facing surface.
- Manual reviewer sub-agents: unavailable because all four collaboration slots
  were occupied; local adversarial review performed instead.
- Claude convergence: state packet was sent through the authenticated Claude
  CLI in plan mode. The process made network connections but returned no review
  after 3 minutes, so no Claude verdict was accepted and no Claude-suggested
  changes were made.

## Claude state packet

```text
Goal: review the manual-only rollback artifact for the exact
20260729010000_hugo_auth_identity_key_lifecycle_lock.sql helper-extraction
delta in Sandra worktree codex/hugo-user-hub-v1-sandra.
Scope: supabase/rollbacks/20260729010000_hugo_auth_identity_key_lifecycle_lock.sql,
scripts/verify-hugo-access-migrations.mjs, package.json.
Evidence: PostgreSQL 17 forward/rollback/replay lane and existing Hugo SQL
verification both pass; no hosted or production state was touched.
Question: identify only concrete correctness, data-preservation, privilege,
transaction, or replay defects in the final head; ignore style preferences and
do not propose migration or hosted-database changes.
```
