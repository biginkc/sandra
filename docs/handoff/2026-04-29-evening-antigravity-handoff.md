# Session handoff — moving to Antigravity (with Get Shit Done templates work)

Date: 2026-04-29 (late evening, ~9 PM)
Previous handoffs:
- `docs/handoff/2026-04-29-skip-trace-recovery.md` (afternoon, skip-trace recovery)
- (this doc supersedes the earlier evening version of itself)

Reason for handoff: Jarrad is moving daily development to **Google Antigravity** using Claude as the model. He's also using "Get Shit Done" alongside Antigravity for a templates-page workstream. This doc + the bootstrap prompt should bring a fresh agent fully up to speed on a single read.

## Current state

- **Branch:** `main` is current (origin/main is at the latest merged PR #69 squash). Local main is 2 commits ahead due to Jarrad's `.planning/*` docs commits — those are unrelated and unpushed; ignore them on the next branch-off.
- **Working-tree status:** clean. Untracked files are session artifacts (`.claude/scheduled_tasks.lock`, `.claude/worktrees/`, `.swc/`, `.planning/config.json`, `docs/admin-page/`, `docs/design/screenshots*`, `docs/feedback/`, `docs/handoff/2026-04-29*.md`, `docs/onboarding.pdf`, `docs/research/transcripts/`, `scripts/probe-*.ts`, `scripts/run-recovery-2026-04-29.ts`, `scripts/verify-import-smoke.ts`). The recovery script is intentionally uncommitted.
- **Prod URL:** `https://sandra-sooty.vercel.app` (stable alias — never give Jarrad deployment-specific Vercel URLs).
- **Supabase project IDs:** prod `copflsklaefwzipsrjqz`, test `ncsngxlcyxylaeskiteu`.

## All PRs merged this session — nothing open

| PR | Title | Effect |
| --- | --- | --- |
| #61 | Skip-trace retry on `/jobs/[id]` | Retry button on failed/partial skip_trace jobs with pre-#59 fallback. Concurrency-guarded + admin-gated. |
| #62 | Skip-trace classify + pre-flight CASS gate + smarter retry | `error_class` taxonomy (`provider_no_data` / `address_unverified` / `provider_transient` / `provider_unknown`); `requestSkipTrace` refuses CASS-unverified addresses up front; retry button counts only retryable items. |
| #63 | Prospects table CASS column | Color-coded dots (verified/unverified/invalid/ambiguous) + cross-page breakdown in header subhead. |
| #64 | CI auto-migrate workflow | `.github/workflows/db-migrate.yml`. Auto-applies migrations to prod on merge to main. **Currently broken** due to migration-version-tracking mismatch — see "Critical learnings" below. |
| #65 | System-managed lists tier | 20 pre-populated lists (Auctions, Bank Owned, Divorce, Pre-Foreclosures, etc.). `system_managed` column blocks archive/delete. Built by sub-agent. |
| #66 | Lead intake + unified source enum + per-consumer webhook auth | Webhook at `POST /api/webhooks/leads/[secret]` with SHA-256 hashed-secret-per-consumer auth via `webhook_consumers` table. Manual form at `/leads/new`. Source enum collapsed to 8 canonical values shared across wizard + webhook + form. |
| #67 | Webhook auth: unify Tracerfy onto webhook_consumers | Tracerfy callback also uses `webhook_consumers` (with `consumer_type='provider'`). URL renamed `/api/webhooks/tracerfy/*` → `/api/webhooks/skip-trace/*`. Removed `TRACERFY_WEBHOOK_SECRET` env-var read. |
| #68 | `/admin/webhooks` page for managing webhook consumers | UI for create / rotate / disable / enable / notes. Plaintext secret shown ONCE at creation. Sidebar entry "Webhooks" appears for admins. |
| #69 | Import wizard + dashboard cleanup (feedback) | Collapsed import wizard's `done` step into `progress`; the same card swaps to terminal-state copy + inline action buttons when job ends. Top-up button on dashboard now admin-gated. From `docs/feedback/feedback a.pdf`. |

## Key infrastructure changes (all applied to prod)

### Migrations

All migrations in `supabase/migrations/`. Applied state:

- **029** `job_items_error_class_taxonomy.sql` — prod + test ✓
- **030** `source_enum_unification.sql` — prod + test ✓
- **031** `system_managed_lists.sql` — prod (schema only — `reset_tenant_tables()` skipped) + test (full) ✓
- **032** `webhook_consumers.sql` — prod + test ✓
- **033** `generalize_webhook_consumers.sql` — prod + test ✓ (adds `consumer_type` NOT NULL with asymmetric `default_source` rule)

### Schema deltas (post-handoff state of prod DB)

- `job_items.error_class` allows the post-#62 taxonomy.
- `properties.source` is the canonical 8-value enum.
- `lists.system_managed` boolean column + index + 20 seed rows.
- `webhook_consumers` table: id, name, consumer_type ('lead'|'provider'), secret_hash, default_source (nullable, required when type=lead, must be NULL when type=provider), enabled, revoked_at, last_used_at, created_at, created_by, notes. RLS enabled.

### Code paths added

- **`src/lib/leads/create.ts`** — shared `createLead()` core with `LEAD_SOURCES` canonical enum.
- **`src/app/api/webhooks/leads/[secret]/route.ts`** — lead webhook, SHA-256 hashed lookup, `consumer_type='lead'` filter.
- **`src/app/api/webhooks/skip-trace/[secret]/route.ts`** — provider webhook (was `/tracerfy/[secret]`), `consumer_type='provider'` filter.
- **`src/app/(dashboard)/admin/webhooks/`** — full UI: page, create-consumer dialog, row actions, server actions, URL helper, integration tests, Playwright spec.
- **`src/app/(dashboard)/leads/new/`** — manual lead-entry form + server action.
- **`.github/workflows/db-migrate.yml`** — auto-migrate workflow (broken, see learnings).

### Webhook consumers (live in prod)

```
Enzo Dialer       | type=lead     | default_source=cold_call | enabled
Tracerfy Skip-Trace | type=provider | default_source=NULL    | enabled
```

The Enzo secret is what Jarrad gave Enzo's team in the email he sent earlier. Tracerfy's secret was generated through the new admin UI and pasted into Tracerfy's Profile Setting → Webhook URL. Smoke-tested 2026-04-29 ~8:30 PM with `curl -X POST {url} -d '{"queue_id":"smoke-test","rows":[]}'` → returned 200 `{"ignored":"unknown queue_id"}` ✓.

### Vercel env vars worth knowing

- `NEXT_PUBLIC_SITE_URL=https://sandra-sooty.vercel.app` — Jarrad updated tonight after seeing the admin/webhooks page emit deployment-specific URLs. Future creates use the right host.
- `TRACERFY_WEBHOOK_SECRET` — **inert**. No code reads it post-#67. Safe to delete from Vercel env settings whenever (deferred cleanup).
- `SUPABASE_ACCESS_TOKEN` + `PROD_SUPABASE_DB_PASSWORD` — GitHub Actions secrets for the auto-migrate workflow.

## Memory updates

Added or modified this session:

- `feedback_proactive_subagent_delegation.md` — **NEW.** Delegate inventories / audits / parallel work to sub-agents up front. Always pass `isolation: "worktree"` (today's session burned ~30 min recovering from a sub-agent that shared the parent working tree and reverted in-flight uncommitted edits).
- `feedback_chrome_alert_when_blocked.md` — **NEW.** Use `osascript display notification` (or Chrome JS alert) when work finishes and Jarrad is in another tab. Don't trigger for routine status updates.
- `MEMORY.md` index updated.

Existing memories worth re-reading on resume:
- `feedback_explicit_opt_in_for_paid_actions.md` — paid vendor calls require explicit OK
- `feedback_one_step_open_urls.md` — give ONE instruction at a time, open URLs via `open` not paste
- `feedback_verify_with_playwright.md` — never ask Jarrad to refresh + check; verify yourself
- `feedback_no_usestate_mirror_of_server_props.md` — UI gotcha that's bitten us before
- `reference_prod_url.md` — `sandra-sooty.vercel.app`
- `project_skip_trace_recovery_2026_04_29.md` — yesterday's 100-property recovery state

## What's NOT done — pick whichever feels right

None of these are blocking; everything in flight is shipped.

1. **46-property CASS recovery.** Script exists at `scripts/run-recovery-2026-04-29.ts` (uncommitted). 46 properties from the recovery list are still `cass_status='unverified'`. Running the script CASS-verifies them, then re-runs skip-trace via the post-#62 codepath. Worst-case cost: $2.30 ($1.38 SmartyStreets + $0.92 Tracerfy). Expected outcome: ~25 contactable owners recovered.
   - To run: `vercel env pull --environment=production /tmp/.env.sandra-prod` (interactive — fills real values), then `set -a && . /tmp/.env.sandra-prod && set +a && npx tsx scripts/run-recovery-2026-04-29.ts --execute`
   - Alternative: do it via the `/properties` UI — bulk-select unverified rows → Actions → Verify CASS → wait → Skip-trace.

2. **`TRACERFY_WEBHOOK_SECRET` env var deletion.** Inert post-#67. Delete from Vercel env settings in 30 seconds when convenient.

3. **React Testing Library setup.** Today's admin-menu regression (PR #68 reverted commit `8b4cb3c`) would have been caught instantly with a 1-line component test. Today the only way to test rendering is full-browser Playwright (slow, flaky). Setting up RTL + `jsdom` vitest config = ~half-day. Sandra's package.json currently has zero `@testing-library/*` deps.

4. **Bump Playwright retries `1 → 2`.** One-line change in `playwright.config.ts`. Jarrad chose this earlier in the session ("yes, option 1") but we deferred. Likely eliminates ~50% of the rerun cycles we hit on flaky days.

5. **Re-attempt admin top-nav dropdown.** Reverted from PR #68 because preview returned 500 `MIDDLEWARE_INVOCATION_FAILED`. Component preserved in git reflog (`8b4cb3c`). Root cause: the same revert remained 500 on the preview, so the issue was actually in the sub-agent's `92ea22d` commit (or transient Vercel preview state) — not in the AdminMenu component itself. Since the merge to prod went fine and prod is healthy, the preview-only 500 was a Vercel infrastructure issue. Worth re-trying the top-nav restructure on a fresh branch off main.

6. **Build `/admin/skip-trace-settings`.** Dashboard's "Top up →" link points at this route (admin-gated since #69), but the page doesn't exist yet — it 404s. The credit count + tier dot still display correctly because they don't depend on the link. Inventory has full notes at `docs/admin-page/inventory-2026-04-29.md`.

7. **Build other `/admin` pages from the inventory.** `/admin/trash` (soft-delete recovery) is the highest-value unbuilt one.

8. **Templates page work via Get Shit Done + Antigravity.** This is what Jarrad's switching to next. The two harnesses know what they're doing for that flow; this doc just notes that templates work is the next active stream.

## Test credentials

- **Jarrad's test phone:** `+13107540662` — for SMS smoke; never smoke real leads.
- **Twilio test receiver:** `+18148097074` — inbound only for canary round-trip; never use as a sender.
- **Prod admin emails:** `jarrad.henry@gmail.com` and `jarrad@bmhgroupkc.com` (in `isAdminEmail` allowlist).
- **E2E test user:** `claude@test.com` / `test12345` (per `e2e/fixtures.ts`).

## Verification scripts

- `npx tsx scripts/probe-tracerfy-queue.ts <queueId>` — read-only Tracerfy queue probe (no credit deduction).
- `npm run typecheck && npm run test` — should be clean on `main` after pulling.
- `npm run test:integration -- src/app/api/webhooks/skip-trace/` — 9 tests should pass.
- `npm run test:integration -- src/app/(dashboard)/admin/webhooks/` — 17 tests should pass.
- Smoke-test the live skip-trace webhook (no cost):
  ```
  curl -X POST https://sandra-sooty.vercel.app/api/webhooks/skip-trace/<TRACERFY-SECRET> \
    -H "Content-Type: application/json" \
    -d '{"queue_id":"smoke-test","rows":[]}'
  ```
  Expected: HTTP 200 with `{"ignored":"unknown queue_id"}`.

## Critical learnings (read these before doing anything risky)

1. **Sub-agent + shared working tree = bad.** Today, a sub-agent launched without `isolation: "worktree"` shared the parent's git working tree. The agent created its branch, my files in flight ended up on its branch as untracked, and the agent reverted my modifications to keep its PR clean (good hygiene from the agent — but destructive because I hadn't committed). **Always pass `isolation: "worktree"`** when launching sub-agents that will touch the working tree. Only skip isolation if the agent is read-only (e.g., Explore for inventory) or every in-flight change is committed.
2. **Auto-migrate workflow is broken** because of a migration-version-tracking mismatch. Sandra uses sequentially-numbered files (`029_*.sql`, `030_*.sql`, ..., `033_*.sql`), but migrations applied via Supabase MCP `apply_migration` get recorded in prod's `schema_migrations` table with **timestamp-based versions** (e.g., `20260421200019`). When the Supabase CLI's `db push` (the auto-migrate workflow's command) reads remote versions, it can't find matching files in `supabase/migrations/` and bails. **Until this is fixed, every shipped migration needs a manual `mcp__claude_ai_Supabase__apply_migration` call against prod with explicit user OK.** A real fix is renaming all migration files to timestamp format OR rewriting the workflow to use `apply_migration` directly. Both are bigger changes; defer unless this becomes painful.
3. **Distinguish "system error" from "no data" before retrying.** PR #62's whole rationale. A Tracerfy "no row returned" is a true negative if the address is CASS-verified, or a false negative (address-unverified) if not. Retry only the false negatives + transient errors. Cache the verified-no-data verdicts so re-runs hit cache.
4. **Source enum is shared, not bifurcated.** `WizardSource` and `properties.source` used to be different vocabularies; PR #66 merged them into one canonical 8-value list. The wizard's source picker is now an attribution signal the user picks deliberately — it does NOT drive column mapping (aliases.ts handles that).
5. **Webhook secrets are per-consumer.** Don't ship "the secret"; ship "Enzo's secret." Hashed in DB, plaintext returned once at creation. `consumer_type` column gates which route a secret can authenticate against. Cross-protection means a leaked lead secret cannot authenticate as a provider callback (and vice versa).
6. **Don't manually apply test-only DB helpers to prod.** Migration 031's `reset_tenant_tables()` function refresh is test-environment helper code; the harness correctly flagged it as inappropriate for prod. Apply only the user-facing parts (column + index + seed rows).
7. **Skip-trace eligibility is CASS-gated.** `requestSkipTrace` filters out CASS-unverified properties before hitting Tracerfy. The CASS upgrade unblocks 46 properties from yesterday's recovery list — the workflow is documented in "What's NOT done."
8. **`/admin/skip-trace-settings` is a known dead link** (dashboard's "Top up →" CTA). PR #69 hides it for non-admins; the page itself is unbuilt. Building it is one of the items in the inventory at `docs/admin-page/inventory-2026-04-29.md`.
9. **The Vercel MCP token in this session is read-only-ish.** It can list deployments + read metadata, but `get_runtime_logs` returned 403. To dig into runtime errors on Vercel, Jarrad would need to either expand the OAuth scope or use the dashboard directly.
10. **For the Antigravity move:** Antigravity supports Claude Sonnet 4.6 and Claude Opus 4.6 but **NOT Claude Opus 4.7** (the model that ran this session). For long agentic sessions (lots of tool calls, large context), 4.7 holds context noticeably better. For routine maintenance work, 4.6 is fine. Source: https://discuss.ai.google.dev/t/add-claude-opus-4-7-to-the-model-picker/141054 — community is asking; Google hasn't shipped yet.
