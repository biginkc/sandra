# My Leads workflow execution goal — state ledger

## Goal

- Goal ID: `my-leads-workflow-20260912`
- Objective: execute the 26-journey, 84-case desktop workflow plan with isolated synthetic data, resolve confirmed defects, rerun fixes and neighbors, and obtain exact-current-candidate Astro review.
- Plan source: `.planning/stress-test/WORKFLOW-TEST-PLAN.md`, `.planning/stress-test/WORKFLOW-TEST-CASES.csv`, `.planning/stress-test/FABLE-USER-WORKFLOWS-20260912.md`, `docs/my-leads/PRD.md`.
- Authority profile: local synthetic, desktop only; no Maria, mobile, live providers, production writes or deployment.
- Candidate after preflight: merged `origin/main` at local merge head containing `77cf1bd6` and the approved My Leads fix migration `20260912150000_acquisition_workflow_stress_guards.sql`.

## Gates

- [PASS] Plan is decomposed into 26 journeys and 84 independent CSV cases with a receipt template.
- [PASS] Candidate source is updated to the merged head before execution; no source diff from the merged candidate remains.
- [PASS] Typecheck passes.
- [PASS] Focused My Leads RTL suite passes: 26 tests across queue, dialogs and client behavior.
- [PASS] Production build completes for the merged candidate.
- [PASS] Astro read-only review completed with high confidence: plan approved for preflight/execution; the historical fresh-handoff defect is confirmed fixed in the merged migration and must be rechecked on the current applied database identity.
- [BLOCKED] New shared database mutation/admission: project TESTER-GATE assigns Sandr tester as sole new shared test-database admission authority. Local port 58322 has another app process and active PostgREST connections; no exclusive reservation or current admission is present.
- [UNTESTED] Browser workflow submissions and persisted outcomes for the new 84-case batch. Prior browser receipts cover the previous campaign and are retained as historical evidence; they do not silently pass these new rows.

## Preflight evidence

- Dedicated local Supabase containers are present on the documented Colima profile, API `58321`, PostgreSQL `58322`; identity values and credentials were not copied into this ledger.
- Existing local Next process on port `58700` and current database connections were observed. No process was stopped or reset.
- Seed preview completed in plan-only mode: 105 synthetic leads, 21 per stage, detail pagination fixture counts. Apply was not run because the Tester admission/ownership gate is not satisfied.
- The candidate worktree was advanced from the older evidence base to `origin/main` with a local merge; plan artifacts remain isolated and uncommitted.

## Astro review

Astro reviewed the plan and reported: approve preflight/execution with two corrections. The tracker must contain a fresh implicit/version-0 handoff case; J04's revised-offer branch must be explicitly BLOCKED rather than NOT RUN. Both corrections were applied. Astro also confirmed the missing-row handoff behavior is a real defect in the older evidence tree but is already fixed and retested in the approved `a9021cfe` candidate; no duplicate source fix was made.

## Current decision

Do not apply fixtures or run browser mutations against port `58322` until the Tester records an exclusive reservation and reconciles the existing writer. Continue safe read-only verification and plan preparation. Once admitted, execute batches in the plan order, update one CSV row and one receipt per scenario, and route confirmed product failures through the owner with exact candidate-bound review and retest.
