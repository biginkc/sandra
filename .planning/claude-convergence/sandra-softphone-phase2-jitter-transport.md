# Sandra softphone Phase 2: Jitter transport

## Goal

Implement Sandra's real `JitterCallTransport` against the Fable-pinned softphone API contract without changing the Phase 1 `CallTransport` seam or softphone UI.

## Plan alignment

- Plan source: `fable-softphone-phase2-spec.md` and `softphone-api-contract.md` supplied in the EXECUTE block.
- Baseline: `origin/main` at `a5a56f9cf1d713a48b4823d0d99df3fa7cb6732b`.
- Authority: implementation, tests, branch, push, and PR; explicitly no merge and no real call.
- Excluded: Jitter repo writes, provider calls, deployment, recordings, inbound calls, transfer UI, and K greater than 1.

## Acceptance gates

- [x] All four contract endpoints use bearer plus HMAC over the exact raw body, including the empty body case.
- [x] Start re-runs Sandra eligibility and derives operator email from the authenticated user.
- [x] Telnyx registration, incoming conference answer, state mapping, mute, hold, token refresh, and teardown are implemented behind the unchanged seam.
- [x] `jitter`, `simulated`, and unset transport selection preserve the specified behavior.
- [x] Page-hide, RTC failure, and explicit hangup all reach idempotent Jitter cancellation.
- [x] Server-only environment variables are documented and never imported by client code.
- [x] Mock-contract tests cover four endpoints, envelopes, 409, 422, empty-body signing, and token expiry.
- [x] Focused tests, full `npm run verify`, build, changed-file lint, and the existing simulated Playwright spec pass.
- [x] Full-repository lint was run and remains blocked only by the baseline: 351 errors and 112 warnings in checked-in GSD/CommonJS and older files; changed files have zero errors.
- [x] Three independent manual-review slices are clean at the commit candidate.
- [ ] PR has the requested title, dependency line, head SHA, and is not merged.

## Preflight

- GitHub CLI authenticated as `biginkc`.
- Claude CLI authenticated; Claude desktop process present. Current EXECUTE block is the first orchestration packet; no GUI control is needed for this deterministic implementation task.
- Browser proof is not a gate for this PR because real calling is explicitly deferred and Playwright remains simulated.
- Sandra's primary checkout is dirty and preserved. Work is isolated in `_codex_worktrees/sandra-jitter-call-transport-phase2`.
- Jitter is read-only. `src/mvp/product-browser-audio.ts` and the installed `@telnyx/webrtc` 2.27.1 types were inspected.

## Iteration 1

- Verdict: `NEXT_STEP` from the supplied Claude EXECUTE block.
- Adversarial checks: contract is internally consistent; the Phase 1 seam lacks operator email, so it must be derived inside the authenticated server boundary. Server Actions are directly callable, so eligibility must be re-run there rather than trusted from the client.
- Status: implementation in progress.

## Iteration 2

- Three independent manual-review slices found authorization and RTC lifecycle gaps in the first pass.
- Fixed active-membership authorization before eligibility side effects; follow-up actions now require a constant-time-verified, caller-bound signed session capability.
- Fixed normal Telnyx clearing, recoverable socket errors, nonfatal hold/BYE errors, duplicate hold signaling, pre-connect user cancellation, terminal duration capture, and cleanup after a rejected cancel action.
- The shared scratchpad contract was concurrently rewritten after this task began. Sandra remains intentionally pinned to the task-start v1 contract (POST for all four endpoints, camelCase bodies, `x-sandra-signature`, no timezone/idempotency fields); later v1.1/v2 text is reconciliation work, not silently adopted here.
- Verification: focused unit 5 files / 32 tests; focused RTL 1 file / 3 tests; full unit 223 files / 2,320 tests; full RTL 82 files / 763 tests; production build clean; simulated Playwright 3/3.
- Dependency review: the required parity pin `@telnyx/webrtc@2.27.1` is exact. `npm audit --omit=dev` attributes three additional moderate advisories to its transitive `@peermetrics/webrtc-stats`/`uuid` chain; npm offers only an incompatible downgrade, so no unsafe override was applied.
- Status: local implementation, independent manual review, and verification clean; pushed-head Claude review and PR/CI evidence remain.
