# My Leads unified queue: S1 stress harness

Hard gate before the `unified_queue` flag is turned on (stress design v1). It checks the A1 classifier
(`fn_my_leads_work_page`, `fn_my_leads_work_facts`, `fn_my_leads_badge_v2`, migration `20261015010000`) against an independent
oracle, under volume, concurrency and clock boundaries.

**Disposable local database only.** No provider is ever called and no message is ever sent (the only "sender" is an in-process fake).
The oracle lane, refresh lane, bind-failure lane and scale lane run inside one transaction that is rolled back; the committed race lanes
need an otherwise empty database and an explicit acknowledgement.

## Run it (Codex)

1. Start a disposable stack that has **every** migration applied, on ports that are not your dev stack. In CI that is
   `scripts/provision-e2e-local-database.mjs`. By hand:
   ```bash
   W=$(mktemp -d) && supabase init --workdir "$W" && cp -R supabase/migrations "$W/supabase/" \
     && sed -i '' 's/54321/54721/;s/54322/54722/;s/54320/54720/;s/54329/54729/;s/54323/54723/;s/54324/54724/;s/54327/54727/' "$W/supabase/config.toml" \
     && supabase start --workdir "$W" -x studio,imgproxy,edge-runtime,logflare,vector,mailpit,realtime,storage-api,postgres-meta,supavisor,gotrue
   ```
2. The lanes that drive the real `dispatchRepSms` (fake provider) run under vitest, because they mock the app's server client; run them first so
   the report can pick up their result (the stack's API must be up; the supabase CLI demo keys are the defaults):
   ```bash
   MYLEADS_STRESS_DB_URL=postgresql://postgres:postgres@127.0.0.1:54722/postgres TEST_SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54722/postgres \
   LOCAL_SUPABASE_URL=http://127.0.0.1:54721 MYLEADS_STRESS_DISPOSABLE_DB=1 MYLEADS_STRESS_DISPATCH_REPS=200 \
   MYLEADS_STRESS_OUT_DIR=test-results/my-leads-queue-stress npm run stress:my-leads-queue:dispatch
   ```
3. Full volume run (about 30-40 minutes):
   ```bash
   MYLEADS_STRESS_DB_URL=postgresql://postgres:postgres@127.0.0.1:54722/postgres \
   MYLEADS_STRESS_DISPOSABLE_DB=1 \
   npm run stress:my-leads-queue -- --repeats 20 --out test-results/my-leads-queue-stress
   ```
   Exit code 0 only if every criterion passes. Reports: `report.json` and `report.md` in `--out`.
4. Useful flags: `--smoke`, `--families a,b`, `--lanes oracle,refresh,races,scale`, `--race-reps 200`, `--scale-sizes 400,2000`,
   `--scale-samples 10`, `--seed N`, `--list`.

## What it does

| Lane | What | Needs |
|---|---|---|
| `oracle` | 31 families x (5 inbound wordings x 3 stage contexts) x `--repeats` fresh seeds, timestamps jittered +-1 min around every threshold. Every lead's tab / chip / decision row / headline / Broken actions, every tab and chip view, counts, sort order, the badge, owner-viewing-rep and pagination are compared with the oracle | rolled back |
| `refresh` | one lead per boundary family: `nextChangeAt` must never be later than the true change + 1 s, no clock-only change may happen before it, and at it the SQL placement must equal the oracle's | rolled back |
| `refresh` (bind failure) | the stamp RPC is renamed away inside a transaction: the send carries `inbound_stamp_unresolved`, handles nothing, the reply stays New reply | rolled back |
| `races` (+ `:dispatch`) | the real `dispatchRepSms` with a fake provider: same Y-after-X race, and the stamp bind RPC removed for real (renamed away and restored in a `finally`); plus the SQL-protocol twin of the race: inbound Y 50-500 ms after a stamped send for X begins (fake provider takes 100-900 ms): Y must stay unhandled (`--race-reps`, default 200); a late `delivery_failed` after acceptance while the queue is polled: Texted last, then Broken, X stays handled, a newer inbound makes it New reply | **commits rows**: `MYLEADS_STRESS_DISPOSABLE_DB=1` and a database holding only harness leads |
| `scale` | prod-shaped queues of 400 and 2,000 leads (4-12 messages each, ledger receipts linked): p50/p95 of the page per tab and chip and of the badge, hard gate p95 < 1.5 s at EVERY size, 400 and 2,000 included (master 2.19; any size over budget fails the run, exit 1), plus an EXPLAIN ANALYZE top-5 node breakdown of `my_leads_work_classified` at 2,000; the duplicate queue projections are timed separately (`projection:*`) | rolled back |

Exit criteria (all zero, p95 under budget): wrong-tab, hidden-lead, count/row, wrong-chip, decision-row, headline, Broken-action, view
membership, badge, order, pagination, owner view, scope, race failures, worlds that failed to run. A full run also fails if fewer than 31
families ran, the scale lane did not run at both sizes, or no race lane ran.

## Files

- `model.ts` abstract per-lead facts. `oracle.ts` the oracle: pure TypeScript from design v9 (1.1, 2/2.1, 3.1, 5, 16, 17); it does not import or read SQL. `oracle.test.ts` its unit tests.
- `families.ts` the 31 families and their variants (deterministic from `--seed`). `prod-shape.ts` the prod-shaped generator (aggregate counts only, no contact data).
- `materialize.ts` the one place that turns facts into rows. `runner.ts` compares SQL with the oracle. `races.ts`, `scale.ts`, `report.ts`, `run.ts`, `cli.ts`.
- `guards.ts` loopback-only database, no `.env` reads, no hosted references, commit-lane acknowledgement.
- `smoke.integration.test.ts` runs in `vitest.local-integration.config.ts` and the `e2e.yml` disposable-DB job, and proves the harness catches a mutated classifier and a removed reply-to stamp.

## Spec questions

Registered in `oracle.ts` (`SPEC_QUESTIONS`). After design v9 section 17, two still produce mismatches:
- **SQ2** (unknown ledger/obligation under 15 min): excused (`expected_until: #876`) only when the SQL output equals the pre-v9 reading
  exactly. The excusal retires itself: once migration `20261015020200*` is in the checkout, SQ2 mismatches fail the run.
- **SQ5** (ambiguous contact-only reply): a confirmed SQL bug, labelled `expected_until: A1.2`, and still failing the run.
SQ6 is recorded for a decision and not seeded. Never resolve a question in the oracle without a design decision.

The rolled-back lanes apply every classifier migration from `20261015010000` onward (each file that defines a classifier function), in
order, so a later fix is never overwritten by the first migration.

Note: a loopback address is not proof of a local database (an SSH tunnel to a remote host also answers on 127.0.0.1). Check what listens
on the port before running the committed lanes.
