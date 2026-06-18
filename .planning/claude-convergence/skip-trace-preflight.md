# Skip-Trace Preflight

Goal ID: skip-trace-preflight

## Goal

Before any skip-trace process can spend provider credits, Sandra must show a confirmation preflight that counts selected CASS-verified records versus records needing CASS, shows Tracefy credit readiness, and offers a deliberate CASS verification path before skip tracing.

## Authority

- Scope: Sandra worktree `codex/skip-trace-preflight`.
- Baseline: `origin/main` at `e40c4e2`.
- Operator-facing copy uses `Tracefy`. Existing provider implementation identifiers may remain as-is unless a separate rename is approved.

## Acceptance Gates

- [x] Shared server preflight computes selected, CASS verified, CASS unverified, kill-switch skipped, not eligible, estimated CASS spend, and Tracefy credits needed/available.
- [x] Tracefy pricing rule accounts for the actual launch split: a single eligible provider call requires 5 credits; batch parts require 1 credit per row; split one-row tails are priced at 5.
- [x] Bulk prospects skip trace opens the confirmation dialog instead of launching immediately.
- [x] Single lead skip trace opens the same confirmation dialog instead of launching immediately.
- [x] Pending skip-trace approval opens the same confirmation dialog instead of approving immediately.
- [x] Failed/partial skip-trace retry opens the same confirmation dialog before creating a child retry job.
- [x] Mixed selections make the CASS-first path the primary action while still allowing "skip trace verified only" for already verified eligible records.
- [x] CASS verification requires an explicit second confirmation before cost-bearing CASS spend.
- [x] Starting CASS verification does not automatically launch skip trace afterward; operator must refresh/re-run preflight.
- [x] Final server-side guards re-check CASS eligibility and Tracefy credits immediately before request launch and approval launch.
- [x] Runner re-checks CASS/skip-trace-disabled state before cache/provider work, so stale jobs fail closed before spend.
- [x] UI/request copy reports actual eligible counts, not raw selected counts.
- [x] Regression coverage exists for preflight counts, Tracefy credit failures, CASS-invalid recompute behavior, stale approval credit checks, duplicate approval races, retry preflight, dialog CASS confirmation, disabled launch on insufficient/unavailable credits, stale preflight response handling, and CASS counts that differ from skip-trace eligibility.

## Verification

- `npm run verify` passed: typecheck, 104 unit test files / 1146 tests, and 42 RTL test files / 402 tests.
- `npm run test:integration -- src/app/'(dashboard)'/jobs/actions.integration.test.ts src/lib/skip-trace/actions.integration.test.ts src/lib/skip-trace/skip-trace-job.integration.test.ts` passed: 47 integration tests.
- Targeted lint passed for the touched runtime surfaces.
- `git diff --check` passed.
- Expected test noise remains: simulated Tracefy balance failure logs in skip-trace action integration tests, unmatched provider-row logging in the skip-trace job integration test, and existing React `act(...)` warnings in older prospects menu tests.

## Covered Launch Surfaces

- `/properties`: selected prospects -> Actions -> Enrich -> Skip trace.
- `/leads/[id]`: single lead skip-trace button.
- `/jobs`: admin approval for pending `skip_trace` jobs.
- `/jobs/[id]`: retry for failed/partial skip-trace jobs.

## Changed Surface

- `src/components/skip-trace-preflight-dialog.tsx`
- `src/components/skip-trace-preflight-dialog.test.tsx`
- `src/app/(dashboard)/properties/prospects-table.tsx`
- `src/app/(dashboard)/properties/prospects-table.test.tsx`
- `src/app/(dashboard)/leads/[id]/skip-trace-button.tsx`
- `src/app/(dashboard)/jobs/jobs-list.tsx`
- `src/app/(dashboard)/jobs/jobs-list.test.tsx`
- `src/app/(dashboard)/jobs/[id]/job-detail.tsx`
- `src/app/(dashboard)/jobs/retry-skip-trace-button.tsx`
- `src/app/(dashboard)/jobs/retry-skip-trace-button.test.tsx`
- `src/lib/skip-trace/actions.ts`
- `src/lib/skip-trace/actions.integration.test.ts`
- `src/lib/skip-trace/skip-trace-job.ts`
- `src/lib/skip-trace/skip-trace-job.integration.test.ts`
- `src/lib/skip-trace/providers/mock.ts`

## Residual Gap

- There is no database-backed cross-job Tracefy credit reservation. Independent launches can still both pass a live balance check before either spends. This is a separate serialized reservation/advisory-lock design, not part of this preflight UI gate.
