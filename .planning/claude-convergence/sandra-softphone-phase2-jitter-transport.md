# Sandra softphone Phase 2: Jitter transport

## Goal

Implement Sandra's real `JitterCallTransport` against the Fable-pinned softphone API contract without changing the Phase 1 `CallTransport` seam or softphone UI, then reconcile the client/proxy/transport to CONTRACT v2 and Jitter PR #202's latest route handlers.

## Plan alignment

- Plan source: `fable-softphone-phase2-spec.md` and `softphone-api-contract.md` supplied in the EXECUTE block.
- Baseline: `origin/main` at `a5a56f9cf1d713a48b4823d0d99df3fa7cb6732b`.
- Authority: implementation, tests, branch, push, and PR; explicitly no merge and no real call.
- Excluded: Jitter repo writes, provider calls, deployment, recordings, inbound calls, transfer UI, and K greater than 1.

## Acceptance gates

- [x] All four contract endpoints use bearer plus HMAC over the exact raw body, including the empty body case.
- [x] Start re-runs Sandra eligibility and derives `operator_id` from the authenticated user.
- [x] Telnyx registration, incoming conference answer, state mapping, mute, hold, token refresh, and teardown are implemented behind the unchanged seam.
- [x] `jitter`, `simulated`, and unset transport selection preserve the specified behavior.
- [x] Page-hide, RTC failure, and explicit hangup all reach idempotent Jitter cancellation.
- [x] Server-only environment variables are documented and never imported by client code.
- [x] Mock-contract tests cover four endpoints, envelopes, 409, 422, empty-body signing, and token expiry.
- [x] Focused tests, full `npm run verify`, build, changed-file lint, and the existing simulated Playwright spec pass.
- [x] Full-repository lint was run and remains blocked only by the baseline: 351 errors and 112 warnings in checked-in GSD/CommonJS and older files; changed files have zero errors.
- [x] Three independent manual-review slices are clean at the commit candidate.
- [x] CONTRACT v2 uses snake_case bodies, `call_id`, token GET with an empty-body signature, `X-Jitter-Signature`, and normalized response/error envelopes.
- [x] Start-call derives the prospect's IANA timezone, sends `Idempotency-Key`, and retries with the same stable wrap/call token and byte-identical body.
- [x] Transport performs PR #202's `registered` then `accepted` connect phases and validates its detailed cancel response.
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

## Iteration 3 — CONTRACT v2 reconciliation

- Supplied reconciliation block is the Claude/orchestrator verdict and plan source for this round. Baseline: Sandra PR #383 at `c9bf48155d4c3ffb25bd30b37d9be61d7139ef23`.
- Jitter source of truth: PR #202 head `e2236421d815336c8577826d4dac4c4af06657d9`, fetched and inspected read-only in `/Users/jarradhenry/Sites/BMH apps/Jitter-softphone-api`. Its only delta after `0e09ec6` is a PostgreSQL test expectation; the route wire is unchanged.
- Contract resolution: PR #202 fills two details omitted by CONTRACT v2's bottom section: connect requires `phase: registered|accepted`; cancel returns the call/session status plus teardown counts. Those as-built handler shapes win.
- Reconciled the external wire to `operator_id`/`phone_e164`/`timezone`, `call_id`, token GET, empty-body HMAC, `X-Jitter-Signature`, exact start/token/connect responses, and `{error,error_code}` wire failures.
- The earlier reconciliation described a single browser-generated UUID owning both Jitter start idempotency and Sandra wrap-up idempotency. That claim is stale and is being changed separately by the in-flight `codex/lost-response-cancel-fallback` PR; this record is not the source of truth for that start-intent/call-token ownership change. The start proxy retries once after a retryable 5xx/network result with the identical key and body.
- Manual-review fixes preserve `operator_busy` and `not_callable` as distinct pre-call UI states, send `accepted` only after Telnyx reports the matching call active, retry that idempotent acceptance handshake, guard token refresh against teardown races, reject unlinked manual numbers whose real timezone is unknown, and byte-limit the authenticated page-hide route before parsing.
- Focused verification: contract/server/transport/routes 4 files / 37 tests; provider RTL 1 file / 7 tests.
- Final full verification: TypeScript passed; 223 unit files / 2,327 tests; 82 RTL files / 767 tests; Next 16.2.4 production build passed; changed-file ESLint and `git diff --check` passed; simulated softphone Playwright 3/3 passed using the existing ignored test-project environment without printing or copying secret values.
- Fallow leads: inherited unused dependencies were excluded by its gate; the current delta produced only complexity flags in the boundary functions and repeated test setup blocks. Manual triage found no dead runtime path or redundant behavioral test to remove.
- Remaining observed cross-repo mismatches: the old CONTRACT v2 text names a Jitter-originated `422 not_callable`, but Jitter's start route never originates it; its 422s are caller-ID validation errors such as `invalid_caller_id_e164` and `caller_id_unavailable`. Sandra still preserves/maps that envelope defensively and performs its own fail-closed `422 not_callable` eligibility/timezone checks before provisioning. Also, a browser-to-Sandra Server Action response lost after Jitter provisioning remains a Sandra wiring gap in this baseline: Jitter commit `86437bc` already ships both cancel by idempotency key and a stale-call reaper (10-minute unconnected TTL), but Sandra has not yet wired its lost-response path to the cancel capability. Sandra deliberately does not replay eligibility and pretend that gap is solved; the in-request Sandra-to-Jitter retry remains safe because eligibility runs once and reuses the same key/body.
- Status: full verification and refreshed manual review are clean; commit/push and remote checks pending.
