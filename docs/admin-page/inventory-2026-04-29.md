# Admin tasks inventory — 2026-04-29

Generated for the /admin page design discussion. Each item includes:
- File path + line(s)
- Brief description of what the admin action does
- Current surface (where it's accessed today, if anywhere)
- Recommendation (build into /admin, leave inline, defer)

Allowlist primitive that everything below relies on:
`src/lib/auth/allowlist.ts:39-47` — `isAdminEmail()` reads `ADMIN_EMAILS` env var (comma-separated). Default fallback `jarrad@bmhgroupkc.com`. Adding/removing an admin = Vercel env var edit + redeploy.

---

## A. Built, lives in feature surface

These are admin-gated capabilities that already have a UI but the UI is embedded in a feature page rather than a unified admin home.

### A1. Approve / deny pending skip-trace job
- File: `src/app/(dashboard)/jobs/jobs-list.tsx:194-280`, server actions in `src/lib/skip-trace/actions.ts:220-370`
- Action: VAs can request a skip-trace, which lands in `pending_approval`. Admin sees inline Approve/Deny buttons on `/jobs`. Approve calls Tracerfy `getBalance()` pre-flight; deny stashes a reason and notifies requester.
- Current surface: `/jobs` table row actions (only visible when `isAdmin`).
- Recommendation: leave inline (action is row-bound) but mirror a "Pending approvals" widget on `/admin` overview so the admin doesn't have to scan `/jobs` to see queue depth.

### A2. Retry failed skip-trace job
- File: `src/app/(dashboard)/jobs/actions.ts:283-508` (`retryFailedSkipTraceItems`), button in `src/app/(dashboard)/jobs/[id]/job-detail.tsx:74-130` and `src/app/(dashboard)/jobs/retry-skip-trace-button.tsx`
- Action: admin-only. Filters errored `job_items` by retryable `error_class`, creates a new `skip_trace` child job linked via `parent_job_id`, concurrency-guarded.
- Current surface: `/jobs/[id]` detail page, gated by `isAdminEmail`.
- Recommendation: leave inline.

### A3. Bulk soft-delete properties
- File: `src/app/(dashboard)/leads/actions.ts:681-723` (`deletePropertiesBulk`), wired in `src/app/(dashboard)/properties/page.tsx:113-134` (passes `canDelete={isAdmin}`)
- Action: admin-only soft-delete (`deleted_at = now()`) over the `/properties` selection. UI string at `src/app/(dashboard)/properties/prospects-table.tsx:287` notes "an admin can recover from the database".
- Current surface: `/properties` bulk action bar.
- Recommendation: leave inline. **Build a "Recover deleted properties" view in /admin** — currently the only recovery path is raw DB `UPDATE deleted_at = NULL` with no UI.

### A4. Invite teammate (one-time email link)
- File: `src/app/(dashboard)/admin/users/page.tsx`, `src/app/(dashboard)/admin/users/actions.ts:19-70` (`inviteUser`), `src/app/(dashboard)/admin/users/invite-panel.tsx`
- Action: admin sends a Supabase invite to `@bmhgroupkc.com` email. Domain hard-checked. Redirect URL pulls from `NEXT_PUBLIC_SITE_URL` env var (with hardcoded prod fallback).
- Current surface: `/admin/users` (already exists — sidebar entry "Team", admin-only).
- Recommendation: this is the seed of the unified `/admin` page. Move under `/admin/team` or rename root.

### A5. Remove teammate
- File: `src/app/(dashboard)/admin/users/actions.ts:78-118` (`removeUser`)
- Action: admin deletes auth user. Refuses self-delete. Refuses removing other admins (UI hides the button at `page.tsx:135` — `isSelf || isAdmin` → no button rendered, but server still allows it; UI is the only guard for cross-admin removal).
- Current surface: `/admin/users` row action.
- Recommendation: leave inline. **Note: server action does not block admin-removes-admin.** The UI is the only guard. Consider hardening when consolidating.

### A6. AI responder org-wide config
- File: `src/app/(dashboard)/settings/ai-responder/page.tsx:11-52`, `src/app/(dashboard)/settings/ai-responder/actions.ts:76-157` (`updateAiResponderConfig`), form `src/app/(dashboard)/settings/ai-responder/form.tsx`
- Action: admin tunes Active toggle, business-hours-only flag, system prompt (textarea, 14 rows, large), `max_turns` (1-10), `min_confidence` (0-1), `daily_send_cap` (>=0). Stored in `ai_responder_configs` (mig 019).
- Current surface: `/settings/ai-responder`, sidebar "AI responder" link (admin-only).
- Recommendation: route lives at `/settings/...` despite being admin-only — inconsistent with `/admin/users`. Either move to `/admin/ai-responder` for a unified surface, or keep both routes, both styled the same.

### A7. Per-property kill switches (skip-trace + AI responder)
- File: `src/app/(dashboard)/leads/[id]/ai-actions.ts:52-110` (`setSkipTraceDisabled`, `setAiResponderDisabled`), wired into `src/app/(dashboard)/leads/[id]/page.tsx:220`
- Action: VA-controlled (NOT admin-gated) toggles to disable skip-trace and AI responder for one property.
- Current surface: lead detail page.
- Recommendation: leave inline. Worth surfacing a `/admin` audit list of "properties with kill switches set" so admin can spot abuse patterns.

### A8. Start parked CASS job
- File: `src/app/(dashboard)/jobs/actions.ts:25-137` (`startQueuedCassJob`), button at `src/app/(dashboard)/jobs/jobs-list.tsx:142-145, 282-338`
- Action: starts a CASS job that the import autotrigger parked because property count exceeded `CASS_AUTOTRIGGER_MAX_ITEMS`. NOT admin-gated currently — any signed-in user can start, with a $-cost confirm dialog. Worth checking whether this should be admin-only given it spends SmartyStreets budget.
- Current surface: `/jobs` row action.
- Recommendation: leave inline. Audit whether VAs should be able to spend $0.03 × N without admin approval.

### A9. Retry failed CASS items
- File: `src/app/(dashboard)/jobs/actions.ts:158-265` (`retryFailedCassItems`), button at `src/app/(dashboard)/jobs/jobs-list.tsx:340-395`
- Action: NOT admin-gated. Re-runs CASS for `error`-status items. Cache-aware so most retries cost $0.
- Current surface: `/jobs` row action.
- Recommendation: leave inline. Lower stakes than skip-trace because of the cache.

---

## B. Built, no UI (currently env var or code-only)

These are config knobs that exist as live behavior but have zero UI — admin must SSH to Vercel env settings.

### B1. Admin allowlist (`ADMIN_EMAILS`)
- File: `src/lib/auth/allowlist.ts:39-47`
- Knob: comma-separated email list. Default is hardcoded to Jarrad's address.
- Recommendation: build into `/admin/team`. The current "you can be admin if you're in this env var" model means adding a 3rd admin requires a Vercel deploy.

### B2. Domain allowlist (`ALLOWED_DOMAIN`)
- File: `src/lib/auth/allowlist.ts` (domain constant)
- Knob: hardcoded to `bmhgroupkc.com`. Anyone whose email doesn't match gets bounced from middleware.
- Recommendation: defer. Single-tenant app for now; flip into DB only when multi-org is real.

### B3. Skip-trace provider selection (`SKIP_TRACE_PROVIDER`)
- File: `src/lib/skip-trace/registry.ts:18-31`
- Knob: env var values `tracerfy` | `mock`. Unset = feature off (UI silently disabled).
- Recommendation: build into `/admin/integrations`. Admin should see "skip-trace: Tracerfy / configured / 1,847 credits" in one tile.

### B4. Address verifier provider (`ADDRESS_VERIFIER_PROVIDER`)
- File: `src/lib/enrichment/registry.ts:18-33`
- Knob: env var values `smartystreets` | `mock`. Code already comments `// case "lob"` and `// case "melissa"` as future expansions.
- Recommendation: build into `/admin/integrations`.

### B5. Messaging provider (`MESSAGING_PROVIDER`)
- File: `src/lib/messaging/registry.ts:17-32`
- Knob: env var values `dialpad` | `mock`. Comments `// case "twilio"` as future.
- Recommendation: build into `/admin/integrations`.

### B6. Vendor secrets — Tracerfy
- Files: `src/lib/skip-trace/providers/tracerfy.ts:382` (`TRACERFY_API_KEY`), `src/app/api/webhooks/tracerfy/[secret]/route.ts:68` (`TRACERFY_WEBHOOK_SECRET`)
- Knobs: API key + webhook URL secret (the secret is part of the URL path, e.g. `/api/webhooks/tracerfy/<secret>`).
- Recommendation: never expose secrets in UI. **Do** show "Tracerfy: configured" or "Tracerfy: webhook secret missing" status tile.

### B7. Vendor secrets — Dialpad
- File: `src/lib/messaging/providers/dialpad.ts:326-328`
- Knobs: `DIALPAD_API_KEY`, `DIALPAD_FROM_NUMBER`, `DIALPAD_WEBHOOK_SECRET`. Send-pipeline pulls from-number on every send (`src/lib/messaging/send.ts:172, 278`).
- Recommendation: status tile only. Tie into the Dialpad rotation runbook (`scripts/rotate-dialpad-secret.ts`).

### B8. Vendor secrets — SmartyStreets
- File: `src/lib/enrichment/providers/smartystreets.ts:196-197`
- Knobs: `SMARTY_AUTH_ID`, `SMARTY_AUTH_TOKEN`.
- Recommendation: status tile only.

### B9. Anthropic API key
- File: `src/lib/ai-responder/generate.ts:123` and `src/app/api/webhooks/dialpad/sms/route.ts:317` (`new Anthropic()` reads `ANTHROPIC_API_KEY` from env)
- Recommendation: status tile "Anthropic: configured / model: <ai_responder_configs.model>".

### B10. Twilio test-receiver token (`TWILIO_AUTH_TOKEN`)
- File: `src/app/api/webhooks/test-receiver/route.ts:45`
- Knob: feature gate for the test-receiver webhook. Unset returns 503.
- Recommendation: status tile in a "Canaries / test infra" section.

### B11. CASS autotrigger cap (`CASS_AUTOTRIGGER_MAX_ITEMS`)
- File: `src/lib/enrichment/cass-job.ts:19, 49-54`. Default 100.
- Knob: imports above this property count get parked at `queued` instead of auto-running CASS, so the user has to confirm the spend.
- Recommendation: build into `/admin/spend-controls`. This is a real cost lever — admins will want to bump it during catch-up runs.

### B12. Cron secret (`CRON_SECRET`)
- File: `src/app/api/cron/sequence-tick/route.ts:40`, `notification-cleanup/route.ts:36`, `sweep-stuck-skip-trace/route.ts:55`
- Knob: shared secret Vercel cron sends as `Authorization: Bearer <secret>`.
- Recommendation: status tile only ("Cron auth: configured").

### B13. Site URL fallback (`NEXT_PUBLIC_SITE_URL`)
- File: `src/app/(dashboard)/admin/users/actions.ts:50-51`
- Knob: invite-link redirect target. Falls back to a hardcoded deployment URL `sandra-jarrad-5416s-projects.vercel.app` (NOT the stable `sandra-sooty.vercel.app`).
- Recommendation: **fix the hardcoded fallback to the stable alias** before this matters. Status tile in `/admin/integrations` showing the resolved invite URL.

---

## C. Not built but signaled as needed

Comments and dead links pointing to admin surfaces that don't exist yet.

### C1. `/admin/skip-trace-settings` route — referenced, not built
- File: `src/app/(dashboard)/dashboard/_components/skip-trace-credits.tsx:22, 60`, also `src/app/(dashboard)/jobs/jobs-list.tsx:43`
- Description: dashboard "Skip-trace credits" widget links here for "Open settings →" / "Top up →"; jobs-list comment says vendor "is configured in /admin/skip-trace-settings".
- Current surface: link goes to a 404.
- Recommendation: **highest-priority gap**. Build `/admin/skip-trace-settings` (or fold into `/admin/integrations`). At minimum: provider name, current balance, top-up CTA (link out to Tracerfy), webhook URL display, last successful webhook timestamp.

### C2. Recovery for soft-deleted properties
- File: `src/app/(dashboard)/leads/actions.ts:678-679` (comment) and `src/app/(dashboard)/properties/prospects-table.tsx:287` (UI copy: "soft-delete — an admin can recover from the database").
- Description: there's no recovery UI; admin must run raw SQL.
- Recommendation: build `/admin/trash` listing rows where `deleted_at IS NOT NULL`, with a single-click restore.

### C3. AI responder escalation keywords editor
- File: `src/app/(dashboard)/settings/ai-responder/form.tsx:160-165`
- Description: form shows `escalation_keywords` as **read-only** ("Read-only info" section). The DB column accepts an array but there's no UI to edit it.
- Recommendation: extend the existing form into the new admin home, or accept it as deferred.

### C4. AI responder model selector
- File: `src/app/(dashboard)/settings/ai-responder/form.tsx:155-159`
- Description: model is read-only too. Stored in `ai_responder_configs.model`. To switch from Haiku to Sonnet, you currently have to write SQL.
- Recommendation: build a model dropdown into the AI responder settings.

### C5. Dev/test allowlist exception
- File: retired; no non-domain app allowlist remains.
- Description: comment says "Remove when we migrate dev login to a real @bmhgroupkc.com account."
- Recommendation: defer until the migration; not actionable from a UI.

### C6. Sequences `tick.ts` next-run optimization TODO
- File: `src/lib/sequences/tick.ts:187-188`
- Description: comment "TODO: compute exact next 08:00 local from property.state zone." Not admin work, just incidental TODO.
- Recommendation: ignore for /admin scope.

### C7. AI responder server-side admin-removes-admin gap
- File: `src/app/(dashboard)/admin/users/page.tsx:135` (UI guard) vs `src/app/(dashboard)/admin/users/actions.ts:78-118` (server)
- Description: the server `removeUser` action only blocks self-removal; cross-admin removal is prevented only by the UI hiding the button. A motivated admin could call the action directly with another admin's id.
- Recommendation: harden when consolidating into `/admin`.

---

## D. Implicit config (hardcoded values that admins would want to tune)

Constants sitting in TS files that operationally are tunables.

### D1. Skip-trace credit tier thresholds
- File: `src/lib/skip-trace/balance.ts:24-25`
- Hardcoded: `< 20` = critical, `< 100` = low, otherwise OK. Drives the dashboard credit widget colors.
- Recommendation: tunable from `/admin/spend-controls`. "Alert when balance < N" / "Critical when balance < M".

### D2. Skip-trace per-job size cap
- File: `src/lib/skip-trace/actions.ts:18`
- Hardcoded: `MAX_PROPERTIES_PER_JOB = 500`.
- Recommendation: tunable. Larger batches are cheaper per-row (1 credit vs 5 for single).

### D3. Skip-trace cache TTL
- File: `src/lib/skip-trace/cache.ts:16`
- Hardcoded: `TTL_DAYS = 90`.
- Recommendation: tunable. Long TTL = cheaper but data goes stale (people move, numbers churn).

### D4. Skip-trace balance cache TTL (in-memory)
- File: `src/lib/skip-trace/balance.ts:7`
- Hardcoded: `CACHE_TTL_MS = 60_000` (60s). Suppresses Tracerfy balance polls.
- Recommendation: leave hardcoded. Only matters for dashboard latency.

### D5. CASS cache stale window
- File: `src/lib/enrichment/cass-cache.ts:25`
- Hardcoded: `CASS_CACHE_STALE_DAYS = 150`. Aligned with USPS presort-eligibility window.
- Recommendation: tunable but with a guard rail — going below ~90 days starts wasting budget; above 180 risks stale addresses.

### D6. CASS per-lookup cost assumption
- File: `src/lib/enrichment/cass-job.ts:34`
- Hardcoded: `CASS_COST_PER_LOOKUP_USD = 0.03`. Drives all UI cost estimates.
- Recommendation: tunable. SmartyStreets pricing tiers vary; admin should be able to update without a deploy when their plan changes.

### D7. CASS autotrigger default cap
- File: `src/lib/enrichment/cass-job.ts:19`
- Hardcoded: `DEFAULT_AUTOTRIGGER_CAP = 100`. Used when `CASS_AUTOTRIGGER_MAX_ITEMS` env unset.
- Recommendation: see B11 — tie env var to UI.

### D8. Notification retention
- File: `src/lib/notifications/cleanup.ts:13`
- Hardcoded: `RETENTION_DAYS = 90`. Daily cron deletes notifications older than this.
- Recommendation: tunable. Less critical, but a reasonable knob.

### D9. Sequence-tick batch size
- File: `src/app/api/cron/sequence-tick/route.ts:22`
- Hardcoded: `BATCH_SIZE = 100`.
- Recommendation: leave hardcoded; admin tuning unlikely.

### D10. Sweep-stuck-skip-trace timing
- File: `src/app/api/cron/sweep-stuck-skip-trace/route.ts:32, 37`
- Hardcoded: `MIN_AGE_BEFORE_SWEEP_MS = 2 * 60 * 1000`, `PER_TICK_LIMIT = 25`.
- Recommendation: leave hardcoded.

### D11. Quiet-hours window + state→TZ map
- File: `src/lib/messaging/quiet-hours.ts:18-73, 126`
- Hardcoded: window `[08:00, 21:00)` local; static state→IANA-zone table covering all 50 US states.
- Recommendation: window itself is TCPA-bound (don't expose). State→TZ is fine as code.

### D12. Markets list (CSV import wizard)
- File: `src/app/(dashboard)/import/steps/step-upload.tsx:46-51`
- Hardcoded: 4 BMH markets — Kansas City, St. Louis, Dayton, Lake of the Ozarks.
- Recommendation: build into `/admin/markets`. Adding a new market currently means a code change. Property table also has city/state denormalized columns; markets are mainly a wizard UX nicety.

### D13. Vendor sources list (CSV import wizard)
- File: `src/app/(dashboard)/import/steps/step-upload.tsx:38-44` (UI labels) and `src/lib/csv/ingest.ts:87-93` (vendor → `properties.source` enum mapping)
- Hardcoded: dealmachine, zillow, realtor, mls, generic.
- Recommendation: defer. Vendor mapping is wired into the parser too; not a clean DB-driven thing yet.

### D14. CSV upload size limits
- File: `src/app/(dashboard)/import/steps/step-upload.tsx:57-58`
- Hardcoded: `SOFT_WARN_BYTES = 15 * 1024 * 1024`, `HARD_BLOCK_BYTES = 50 * 1024 * 1024`.
- Recommendation: leave hardcoded. Browser memory bound.

### D15. CSV ingest progress + error sample sizes
- File: `src/lib/csv/ingest.ts:77-78`
- Hardcoded: `PROGRESS_UPDATE_INTERVAL = 10`, `ERROR_SAMPLE_SIZE = 20`.
- Recommendation: leave hardcoded.

### D16. Outbox cadence bounds
- File: `src/app/(dashboard)/messages/queue-panel.tsx:46-48`
- Hardcoded: `MIN_CADENCE_S = 5`, `MAX_CADENCE_S = 300`, `DEFAULT_CADENCE_S = 15`.
- Recommendation: leave hardcoded. This is the operator's per-session UI, not org config.

### D17. Skip-trace retryable error classes
- File: `src/app/(dashboard)/jobs/actions.ts:372-382`, `src/app/(dashboard)/jobs/[id]/job-detail.tsx:74` (`RETRYABLE_CLASSES`)
- Hardcoded: lists which `error_class` values are worth retrying vs. terminal. Embodies vendor knowledge — admin shouldn't tune these without engineering.
- Recommendation: leave hardcoded.

### D18. Property statuses + motivation levels
- File: `src/app/(dashboard)/leads/actions.ts:40, 165-180` (`VALID_STATUSES`, `VALID_MOTIVATION_LEVELS`), motivation labels at `src/app/(dashboard)/leads/[id]/motivation-widget.tsx:25`
- Hardcoded: status enum + motivation enum, both schema-bound.
- Recommendation: leave hardcoded; schema-driven.

### D19. Job-failure poll interval
- File: `src/components/job-failure-notifier.tsx:14`
- Hardcoded: `POLL_INTERVAL_MS = 5000`.
- Recommendation: leave hardcoded.

### D20. Opt-out phrase rotation pool
- File: `src/lib/sequences/opt-out.ts:15-21`
- Hardcoded: 5 hand-curated TCPA-compliant opt-out phrases.
- Recommendation: tunable from `/admin/sequences-config`. Wholesalers like to vary phrasing for A/B; today this requires a deploy.

### D21. Sequence pause rules — terminal/acquisition statuses
- File: `src/lib/sequences/pause-rules.ts:36-37`
- Hardcoded: `TERMINAL_STATUSES = {dead, closed}`, `ACQUISITION_STATUSES = {offer_sent, under_contract}`. Drives whether a sequence enrollment auto-pauses.
- Recommendation: leave hardcoded. These map to status enums that are themselves schema-driven.

---

## E. Vendor integration health signals

Places where the code already discriminates "configured" vs "unconfigured", which would compose into a single admin status page.

### E1. Skip-trace provider configured + balance
- File: `src/lib/skip-trace/balance.ts:10-34`
- Signal: `{available: true, credits, tier}` | `{available: false, reason: 'unconfigured' | 'error'}`.
- Already surfaced: `src/app/(dashboard)/dashboard/_components/skip-trace-credits.tsx`.
- Recommendation: this is the model. Repeat the pattern for every vendor.

### E2. Address verifier configured
- File: `src/lib/enrichment/registry.ts:17-33`
- Signal: returns null (off) vs throws ConfigurationError (named but missing creds).
- Already surfaced: implicit — CASS jobs land with `provider_off` outcome (`src/lib/enrichment/cass-job.ts:169-178`) writing `error_class: "configuration"`.
- Recommendation: surface "SmartyStreets: configured / not configured" tile.

### E3. Messaging provider configured
- File: `src/lib/messaging/registry.ts:17-32`, also `src/lib/messaging/send.ts:14`
- Signal: same null / throw pattern as E2.
- Recommendation: tile + last successful outbound timestamp.

### E4. Tracerfy webhook gate
- File: `src/app/api/webhooks/tracerfy/[secret]/route.ts:68-72`
- Signal: returns 503 when `TRACERFY_WEBHOOK_SECRET` unset; 403 when secret mismatches.
- Recommendation: tile showing "Last webhook received: Xm ago" (would catch the silent-webhook-failure mode that the sweep cron exists to recover from).

### E5. Twilio test-receiver gate
- File: `src/app/api/webhooks/test-receiver/route.ts:45-50`
- Signal: 503 when `TWILIO_AUTH_TOKEN` unset.
- Recommendation: low priority — used only by canary/test infra.

### E6. AI responder configured
- File: `src/app/(dashboard)/settings/ai-responder/page.tsx:30-39`
- Signal: page renders "No active config found" when there's no row in `ai_responder_configs`.
- Recommendation: roll into the integrations status page.

### E7. Cron secret + auth
- Files: `src/app/api/cron/{sequence-tick,notification-cleanup,sweep-stuck-skip-trace}/route.ts`
- Signal: each returns 500 if `CRON_SECRET` unset, 401 if Bearer mismatch.
- Recommendation: tile showing "Last cron run / status" per cron.

---

## F. One-off scripts (candidates for /admin UI)

Bench-grade tools that an admin runs from a terminal today.

### F1. Rotate Dialpad webhook secret
- File: `scripts/rotate-dialpad-secret.ts`
- Action: lists Dialpad SMS subscriptions, finds the one whose URL matches Sandra's prod inbound, PATCHes new signature.
- Recommendation: leave as script. Rotation is rare and high-stakes.

### F2. Test Dialpad webhook secret candidates
- File: `scripts/test-dialpad-webhook-secret.ts`
- Action: forges a Dialpad-shape JWT and POSTs to prod to identify which secret is live.
- Recommendation: leave as script (debugging tool).

### F3. Probe Tracerfy queue
- File: `scripts/probe-tracerfy-queue.ts`
- Action: read-only `GET /queue/:id` to inspect a stuck batch.
- Recommendation: surface in `/admin/jobs/[id]` as a "Probe Tracerfy" button on stuck `skip_trace` jobs (read-only, no credits charged).

### F4. Retry failed CASS items (CLI)
- File: `scripts/retry-failed-cass.ts`
- Action: same shape as `retryFailedCassItems` server action (A9). Predates that action.
- Recommendation: deprecate the script; the UI button covers it.

### F5. Probe RPC as test user
- File: `scripts/probe-rpc-as-test-user.ts`
- Action: smoke `dashboard_summary` RPC as the shared E2E dev user.
- Recommendation: leave as dev script.

### F6. Precheck D4D CSV
- File: `scripts/precheck-d4d-csv.ts`
- Action: splits a D4D / Skip Genie reshaped CSV into cleaned + needs-review.
- Recommendation: fold into the import wizard's preview step. Today it's a manual two-step (script then wizard).

### F7. Reshape D4D CSV
- File: `scripts/reshape-d4d-csv.ts`
- Action: converts D4D's space-delimited address column into the comma-delimited shape the wizard expects.
- Recommendation: fold into the import wizard auto-detect (call `reshapeRows` from `src/lib/csv/reshape-d4d` based on source = D4D / Skip Genie).

### F8. Verify import smoke (Playwright)
- File: `scripts/verify-import-smoke.ts`
- Action: end-to-end Playwright smoke for the import wizard.
- Recommendation: leave as dev/CI script.

### F9. Smokes — AI responder, sequences, STOP keyword, skip-trace
- Files: `scripts/smoke-ai-responder*.ts`, `scripts/smoke-sequences-prod.ts`, `scripts/smoke-stop-keyword-prod.ts`, `scripts/smoke-skip-trace.ts`, `scripts/smoke-ai-responder.ts`
- Action: synthetic prod traffic that exercises each feature end-to-end.
- Recommendation: keep as scripts. The `.github/workflows/canary-*` already wraps the prod variants on a schedule. **Build a "Run canary now" button on /admin** that triggers `gh workflow run` (or the more direct equivalent) — Jarrad currently does this from CLI.

### F10. Verify dashboard scripts
- Files: `scripts/verify-dashboard-{authed,deploy,localhost}.ts`
- Action: dashboard regression smokes against authed / deploy / localhost.
- Recommendation: leave as dev scripts.

---

## G. Cron + scheduled work (admin "trigger now" candidates)

Background work whose failure the admin needs to see, and which they may want to manually fire.

### G1. Vercel cron — sequence tick (every 5 min)
- Config: `vercel.json:7-10` → `/api/cron/sequence-tick`
- Code: `src/app/api/cron/sequence-tick/route.ts`
- Action: drives the SMS drip. Auth via `CRON_SECRET` Bearer.
- Recommendation: `/admin/crons` view with last run / next run / "Run now" (POST with secret).

### G2. Vercel cron — sweep stuck skip-trace (every 1 min)
- Config: `vercel.json:11-14` → `/api/cron/sweep-stuck-skip-trace`
- Code: `src/app/api/cron/sweep-stuck-skip-trace/route.ts`
- Action: catches `running` skip-trace jobs whose webhook never landed. Polls Tracerfy, finalizes if done.
- Recommendation: `/admin/crons` row + a "Sweep now" button that bypasses `MIN_AGE_BEFORE_SWEEP_MS` for the impatient case.

### G3. Vercel cron — notification cleanup (daily 04:00 UTC)
- Config: `vercel.json:3-6` → `/api/cron/notification-cleanup`
- Code: `src/app/api/cron/notification-cleanup/route.ts`
- Action: deletes notifications older than 90 days.
- Recommendation: `/admin/crons` row, low priority for "trigger now".

### G4. GitHub Actions — sequences canary (weekdays 14:00 UTC)
- Config: `.github/workflows/canary-sequences.yml`
- Action: prod canary that round-trips a real Dialpad → Twilio test-receiver SMS.
- Recommendation: `/admin/canaries` showing last run + status badge from GitHub. "Run now" calls `gh workflow run`.

### G5. GitHub Actions — SMS prod canaries (weekdays 14:30 UTC, three jobs)
- Config: `.github/workflows/canary-sms.yml`
- Action: AI responder happy + escalation + STOP-keyword (TCPA) — three independent canaries.
- Recommendation: same as G4.

### G6. GitHub Actions — E2E (`e2e.yml`)
- Action: not a canary; preview-deploy E2E.
- Recommendation: not admin work.

---

## H. Per-property + per-record actions worth surfacing

Not strictly admin-only, but worth listing because they're actions the admin uses to clean up data.

### H1. Soft-deleted property recovery
- See A3 / C2 above. Currently DB-only.

### H2. AI responder kill switch per property
- See A7. Self-service, no admin gate.

### H3. Skip-trace kill switch per property
- See A7. Self-service, no admin gate.

### H4. Need-human-attention dismissal
- File: `src/app/(dashboard)/leads/[id]/ai-actions.ts:14-43` (`clearNeedsHumanAttention`)
- Action: clears the AI-escalation flag after a VA handles a lead. Self-service.
- Recommendation: leave inline.

---

## I. Key registry (`/admin/keys`) — added 2026-04-29 evening

**Goal:** A single page that lists *every key/secret/credential the app depends on* — names only, never values — with status (configured / missing) and a direct rotation link for each.

**Why this exists:**
- Today, "what keys does Sandra need?" is answered by reading code (`process.env.*`) + the Vercel env-vars dashboard. No single source of truth.
- When a vendor key needs rotating, finding the right place to rotate it requires recall (Tracerfy dashboard? SmartyStreets? Where's the "API keys" link in their admin?). A direct "Rotate" link per key removes that lookup tax.
- A status indicator tells admins at a glance which integrations are wired vs missing — currently you find out only when a feature breaks.

### Page contract

For each key, the page shows:
- **Name** — the env-var identifier (e.g., `TRACERFY_API_KEY`)
- **Purpose** — one-line description of what it unlocks
- **Storage** — where it lives (Vercel env / GitHub secret / Supabase / hardcoded)
- **Status** — `configured` (set + non-empty) / `missing` (unset or empty) / `unknown` (can't probe)
- **Last verified** — when we last successfully made an authenticated call against the integration (optional, where probing is cheap)
- **Rotate link** — direct URL to the vendor's API-keys / credentials page

The page **must never display the value itself**, even masked. The point is a directory + status, not key visibility.

### Initial registry (drawn from this inventory)

Vendor API keys + secrets:
- `TRACERFY_API_KEY` — skip-trace credits → rotate at https://app.tracerfy.com (account → API)
- `TRACERFY_WEBHOOK_SECRET` (per `vercel-env`) — webhook signature verification → rotate by updating Vercel env + Tracerfy webhook config
- `SMARTYSTREETS_AUTH_ID` + `SMARTYSTREETS_AUTH_TOKEN` — CASS/DSF2 verification → rotate at https://www.smartystreets.com/account/keys
- `ANTHROPIC_API_KEY` — AI responder → rotate at https://console.anthropic.com/settings/keys
- `DIALPAD_API_KEY` + Dialpad webhook signing secret — outbound SMS → rotate at https://dialpad.com (admin → integrations)
- Twilio inbound webhook signing — currently used as canary receiver
- `OPENAI_API_KEY` (if/when added)

Supabase:
- `NEXT_PUBLIC_SUPABASE_URL` (public, doesn't rotate)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — rotate at https://supabase.com/dashboard/project/copflsklaefwzipsrjqz/settings/api
- `SUPABASE_SERVICE_ROLE_KEY` — same page; service-role can do anything, treat as crown jewels

Internal infra:
- `SUPABASE_ACCESS_TOKEN` (GitHub Actions secret) — for the new auto-migration workflow → rotate at https://supabase.com/dashboard/account/tokens
- `PROD_SUPABASE_DB_PASSWORD` (GitHub Actions secret) — direct prod DB connection → rotate via Supabase dashboard (Settings → Database → Reset password)

App-level config that should also list here for completeness:
- `ADMIN_EMAILS` — admin allowlist (semicolon list). Not a "key" per se but operationally rotates the same way (env var edit + redeploy).
- `NEXT_PUBLIC_SITE_URL` — base URL for invite redirects + email links
- `CASS_AUTOTRIGGER_MAX_ITEMS` — cost-control gate (numeric, but operational)

### Status-probing rules

For each key, the "configured" check is just "env var set + non-empty." That's free. The "last verified" timestamp requires a vendor API call:

- Tracerfy: `getBalance()` (already exists, ~free)
- SmartyStreets: a single zero-cost lookup against a known sentinel address (or skip — the count is in the SmartyStreets dashboard already)
- Anthropic: a 1-token completion (~$0.000015) — cheaper than the operational cost of finding out the key's bad
- Dialpad: a `whoami`-style endpoint if available; otherwise skip
- Supabase service role: a `select 1` against `auth.users` — cheap

Probes should be **opt-in** (button click), not auto-fire on page load — otherwise admins re-hitting the page burns balance.

### Recommendation

Build this as `/admin/keys`. It's a directory + status panel, no schema changes, no migrations. Should be one of the first admin pages built because:
1. Net-new value (today there's no equivalent anywhere)
2. Pure read + external link (no destructive actions = low-risk PR)
3. Composes well with the broader admin inventory (each subsequent admin page can register its own keys here)
4. Solves a real recurring tax (today's `PROD_SUPABASE_DB_PASSWORD` reset took 4 minutes of dashboard navigation; with this page, it'd be one click)
