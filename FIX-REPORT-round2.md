# PR #512 round 2 fix report

## Blocker 1 — fixed

Only claim RPC errors with code `PGRST202` or `42883` defer. The runner logs `skip-trace submission deferred` with the job ID, `missing function claim_skip_trace_submission`, code, and original message, then returns the existing `{ claimed: false }` outcome. The workflow returns `claim_lost`, leaving the prepared job queued with no failure write or provider call. The existing unsubmitted-job sweeper selects queued rows with stale heartbeats and no provider run ID and starts this workflow again. No fallback audience PATCH was added.

Parameterized tests cover both missing-function codes. A separate `42501` permission error test proves other RPC errors still throw and persist failed status with the real message. No migration SQL semantics changed.

## Blocker 2 — mutation proven

The stale-owner test now requires one attempted failure write, so an implementation that simply rethrows without entering the failure handler cannot pass. It also checks that the newer heartbeat, queued status, and absent error message survive.

Temporarily removed only `.eq("worker_heartbeat_at", now)` from the workflow failure-write fence and ran:

```sh
npx vitest run src/workflows/skip-trace-submit.test.ts -t 'does not overwrite a newer prepared owner'
```

Exit code: 1. Verbatim output:

```text

 RUN  v4.1.5 /Users/jarradhenry/Sites/BMH apps/_claude_worktrees/sandra-skiptrace-workflow-fix

 ❯ src/workflows/skip-trace-submit.test.ts (8 tests | 1 failed | 7 skipped) 18ms
     ↓ writes the inner submission token for 3,206 IDs without an oversized URL
     ↓ persists an authorization-read failure instead of leaving the prepared job queued
     ↓ marks a throw before the inner claim failed with its error text
     ↓ defers missing-function PGRST202 without failing the queued job
     ↓ defers missing-function 42883 without failing the queued job
     ↓ surfaces an RPC error as failed, while retaining its message
     × does not overwrite a newer prepared owner on a stale step failure 17ms
     ↓ throws both errors if persisting the failure also fails

 Test Files  1 failed (1)
      Tests  1 failed | 7 skipped (8)
   Start at  09:26:57
   Duration  187ms (transform 77ms, setup 0ms, import 104ms, tests 18ms, environment 0ms)

(node:13781) [DEP0205] DeprecationWarning: `module.register()` is deprecated. Use `module.registerHooks()` instead.
(Use `node --trace-deprecation ...` to show where the warning was created)

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/workflows/skip-trace-submit.test.ts > skip-trace submit claim gap > does not overwrite a newer prepared owner on a stale step failure
AssertionError: expected 'failed' to be 'queued' // Object.is equality

Expected: "queued"
Received: "failed"

 ❯ src/workflows/skip-trace-submit.test.ts:107:24
    105|     const failureWrites = transport.mock.calls.filter(([, init]) => in…
    106|     expect(failureWrites).toHaveLength(1);
    107|     expect(job.status).toBe("queued");
       |                        ^
    108|     expect(job.worker_heartbeat_at).toBe("2099-01-01T00:00:00.000Z");
    109|     expect(job.error_message).toBeUndefined();

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


```

Restored the exact original workflow file in a `finally` block; it has no final diff. Reran the entire focused file: 8/8 tests passed.

## Verification

```sh
SUPABASE_LOCAL_DB_URL=postgresql://jarradhenry@localhost:5432/postgres npm run verify
```

Exit code: 0.

- Atomic packet: 12/12 passed.
- Local eSign Essentials rehearsal: passed.
- Typecheck: passed.
- Unit: 332 files / 3,681 tests passed.
- RTL: 111 files / 1,231 tests passed.
- Targeted ESLint and `git diff --check`: passed.

Verification log: `/tmp/sandra-round2-verify.log`; mutation log: `/tmp/sandra-round2-mutation.log`.

Scope: only the two requested blockers. No production data access, provider calls, merge, or deployment commands. Push is requested; any automatic branch CI/preview behavior is repository-controlled. PR body retains `Fixes #511` and `Depends on: none`.

BLOCKER1_FIXED: YES
BLOCKER2_MUTATION_PROVEN: YES
