# Session handoff — Skip-trace recovery

Date: 2026-04-29 (afternoon)
Previous handoff: `docs/handoff/2026-04-28-overview-build.md`

## Current state

- Branch: `main` (clean, only untracked files: `docs/design/screenshots*`, `docs/research/transcripts/`, `docs/onboarding.pdf`, three `scripts/probe-*.ts` and `verify-import-smoke.ts`)
- Latest prod deploy: ~30 minutes ago, includes PRs #59 + #60
- Prod URL: `https://sandra-sooty.vercel.app`

## What shipped this session

| PR  | Title                                                                | Effect                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #60 | CI: bump runner Node 20 → 24 LTS (unbreak main)                      | E2E was red on main for ~12h because npm 10 (Node 20) misread a v3 lockfile written by npm 11 locally. Bumped runner to Node 24 LTS (matches Vercel default). Added `engines.node: ">=22"` pin in `package.json`. |
| #59 | Skip-trace: fan results out by address (Tracerfy batch dedup fix)    | Tracerfy silently dedupes batch input by address and doesn't round-trip our `external_id`. Now we record `address_to_property_ids` map at submit time, fan each result row to every property in its bucket, write per-property `error` job_items for any address that never returns. Also: `insertJobItem` throws + reports on Supabase errors instead of silently swallowing. |

## Key infrastructure changes

- **Code paths added (PR #59):**
  - `SkipTraceResult.matchedAddress` field (carries provider-echoed address through the wire)
  - `normalizeAddressForMatch()` in `src/lib/skip-trace/cache.ts` — strict 3-part key (no zip) for batch result matching
  - `address_to_property_ids` ledger persisted into `jobs.result_summary` at submit time
  - 3 new integration tests + 1 new unit test in skip-trace
- **CI workflows changed (PR #60):**
  - `.github/workflows/e2e.yml`, `canary-sequences.yml`, `canary-sms.yml` now use `node-version: "24"`
- **No DB migrations applied this session.** All changes are code-only on top of existing schema.
- **Supabase project IDs (for reference):**
  - Prod: `copflsklaefwzipsrjqz` (`sandra-crm`, ACTIVE_HEALTHY)
  - Test: `ncsngxlcyxylaeskiteu` (`sandra-crm-test`)

## Memory updates

- New: `project_skip_trace_recovery_2026_04_29.md` — captures the in-flight 100-property recovery state (list_id, failed job IDs, the bug story, the path to recovery).
- New: `reference_prod_url.md` — `https://sandra-sooty.vercel.app` is the stable alias; never give Jarrad deployment-specific Vercel URLs.
- Index updated in `MEMORY.md`.

## What's in flight

**The 100-property skip-trace recovery is mid-execution and stuck on UI flow.**

- A list called `Skip-trace recovery 2026-04-29` with id `3241368b-0631-45d1-908b-0322660b387f` was created in prod — contains all 100 property IDs that yesterday's 4 failed skip-trace jobs targeted. **Don't re-create the list.**
- The recovery hit a wall when I assumed `/lists/[id]` had a "Skip trace this list" button. **It doesn't** — `/lists` is an index-only page with Archive/Restore as the only actions. The actual skip-trace trigger is on `/properties` via the prospects-table bulk-select (`requestSkipTrace` in `src/lib/skip-trace/actions.ts`).
- **Decision required next session:** how to scope the 100 properties for bulk-select.
  - Option A: add a `?list=<id>` query filter to `/properties` (small, generally useful, would let any list serve as a property-cohort filter going forward).
  - Option B: one-off script that creates the `jobs` row directly with `input_params.property_ids` = the 100 IDs and lets `runSkipTraceEnrichment` take over. Faster but doesn't help next time.
- **Cost when triggered:** 100 × $0.02 = $2.00 in Tracerfy credits.
- **The recovery run also serves as real-world verification of PR #59** — if it completes with 100 cache rows + 100 job_items rows, the structural fix is proven. If anything goes silent again, the fix didn't catch everything.

## Known not-done

- 39 properties from earlier imports still need CASS verification — blocked on SmartyStreets paid plan (free tier exhausted). Separate issue from skip-trace; don't conflate.
- Vendor abstraction is unverified — we have the interface but have only ever wired Tracerfy as the skip-trace provider. Per Jarrad: "Tracerfy may not be used permanently." Worth wiring a second adapter (BatchData / IDI) at some point to prove the abstraction.
- 3 Playwright tests are pre-existing flakes (cockpit-assignment, cockpit-lead-detail-parity, notifications "mark all as read"). They passed on retry on PR #59. Not skip-trace-related.

## Test credentials

- Test phone (Jarrad's, for SMS smoke): `+13107540662` — never smoke real leads.
- Twilio test receiver: `+18148097074` — inbound only for canary round-trip; never use as a sender.
- Prod admin email: `jarrad.henry@gmail.com` (and any other addresses in `isAdminEmail` allowlist) — when impersonating in scripts, use this so jobs queue immediately instead of landing in `pending_approval`.

## Verification scripts

- `npx tsx scripts/probe-tracerfy-queue.ts <queueId>` — read-only Tracerfy queue probe (no credit deduction). Needs `TRACERFY_API_KEY` in env. To populate locally: `vercel env pull`.
- After running the recovery: query `skip_trace_cache` count where `address_normalized` matches one of the 100 properties' normalized addresses. Should be 100. Was 0 before.
- After running the recovery: query `job_items` where `job_id = <new job id>`. Should equal 100. Old failed jobs had 0.

## Critical learnings

1. **Don't speculate about UI rendering.** I told Jarrad to look for a "yellow tag at the top" of `/lists` — I'd guessed at how lists render, was wrong. He called it out as hallucination. **Read the source first; don't make claims about the UI you haven't verified.** Memory `feedback_verify_with_playwright.md` covers this principle but I violated it.
2. **Don't give deployment-specific Vercel URLs.** I gave him `sandra-93ibtxg18-jarrad-5416s-projects.vercel.app` — those 401 in his browser session. Use the stable alias `sandra-sooty.vercel.app` (now in `reference_prod_url.md`).
3. **D4D import ships phone numbers** — so `contacts.phone_*` being populated is NOT evidence skip-trace ran. The authoritative signal is `skip_trace_cache` row membership (per provider + normalized address). I made this mistake first ("recovery set is 4!") and Jarrad caught it.
4. **All 4 failed jobs from yesterday morning charged $0 except job 4** — jobs 1-3 were rejected at the Tracerfy API (415/400) before any work. Job 4 (queue 82502) ≈ $0.42, but our `total_credits` summary recorded 0 because we couldn't attribute results to properties. The actual Tracerfy charge happens on their side independent of our bookkeeping.
5. **`/lists` has no per-list detail route.** Only the index page exists. Skip-trace happens from `/properties` (prospects-table) via bulk-select.
6. **Auto-mode caveat:** Even in auto mode, cost-bearing actions (Tracerfy credits, Twilio sends, SmartyStreets calls) require explicit user opt-in. Memory `feedback_explicit_opt_in_for_paid_actions.md` covers this.
7. **Step-by-step for manual procedures:** Jarrad has ADHD — give ONE instruction per turn, wait for confirmation. Don't paste multi-step lists. Open URLs via `open` (don't paste as text). Memory `feedback_one_step_open_urls.md` covers this.
