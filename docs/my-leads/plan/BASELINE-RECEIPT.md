# My Leads execution baseline

Execution started September 11, 2026 in the owned `codex/my-leads-prd-20260911` worktree.

## Authority correction

Jarrad explicitly made this task isolated after the original plan was written. Do not use the Sandra Orchestrator, external worker sessions, its dispatch process, or its coordination gates. Preserve unrelated worktrees and avoid shared resource mutations. Repository review, migration safety and appropriate acceptance requirements still apply within this task. The old coordination request was withdrawn.

## Verified baseline

- Sandra local HEAD, origin/main and remote main: `8c7053e7024433f46791eac1b186c1b7a7cf10ec`.
- Starting dirty state: only untracked `docs/my-leads/` planning documents; no existing product implementation.
- Open call-overlap PRs: 519 pre-call, 522 recovery, 492 terminal polling. None copied or modified. Foundation/time have no code dependency on these PRs.
- Node v26.8.1 is installed (package requires >=22). `npm ci --ignore-scripts --no-audit --no-fund` succeeded using the checked-in lockfile. No dependency upgrades.
- Next16.2.4 local version documentation is available; server-function authorization documentation inspected.
- PostgreSQL17 local binaries are available. Use run-owned temporary socket clusters for isolated SQL proof; no hosted test reset or credentials are needed for these checks.
- Jitter source baseline from research remains unverified against deployment; P07 must establish it before provider acceptance. No provider operations performed.

## Checklist

- [x] P00 repository baseline and isolated ownership recorded; live Jitter parity deferred only to the relevant provider operation.
- [ ] P01-P03 foundation: Luna worker owns schema/settings/types, root reviews before acceptance.
- [x] P04 TypeScript timing/warning functions and focused tests: 30 tests passed including existing zoned helper tests.
- [x] P04 SQL helper migration replayed on private PG17: six matching deadline/minute vectors, fractional minutes, invalid duration and execute-grant checks passed; cluster stopped/removed.
- [ ] P04 full feature SQL integration and final review remain.
- [ ] P05-P14 implementation and acceptance remain.

Current timing proof commands: `npm run test -- src/lib/my-leads/time.test.ts src/lib/time/zoned.test.ts`; `node scripts/verify-acquisition-time.mjs`.

No product feature rollout, real lead mutation, provider call, remote migration, PR or deployment has occurred.

## Implementation checkpoint — local work in progress

- Timing functions and SQL helpers implemented; independent timing review found no material defects.
- Call evidence DTO/parser, token-digest binding wrapper, internal authenticated receiver and service-only SQL transaction implemented. Sandra start path now binds context before egress and sends the optional acquisition episode reference; focused existing Jitter server tests pass (33).
- Private PG17 component verifier `scripts/verify-acquisition-evidence.mjs` replays the actual new migrations over minimal source-table fixtures. It verifies late original-rep call credit, replay, untouched new-owner clock/stage, service-only write access, stage paging/cursor bindings and original appointment/KPI attribution. This does not substitute for full-schema migration rehearsal.
- Queue paging, scope guard, KPI/badge SQL, booking-time appointment attribution and owner roster SQL implemented. Server query wrappers have seven passing focused tests.
- P11 presentation components have seven passing RTL tests. P12 dialog work remains active; transient type errors in unfinished dialogs were returned to their owner.
- P01-P03 foundation files/settings/types are written; worker finishing tests and then owning P05/P06 commands.
- P07 worker has the signed delivery adapter and focused mock tests but still must implement persisted start-context propagation and wire the durable seller-start side effect. Adapter-only completion was explicitly rejected; worker continuing full producer implementation.
- Remaining: complete workflow/manual-attempt/finalization commands, UI/server/page/detail integration, launch tooling, full-schema/acceptance/review and authorized release. No PR, hosted mutation, rollout or deployment has occurred.

### Latest checkpoint

Manual attempt RPC added with active-user scope, assignment/status/version checks, replay receipts, DialPad/manual source validation, optional recording and first-call eligibility checks. The private PG17 verifier now exercises manual outreach versus actual external-call timing as well as original-rep appointment/KPI attribution. Root owns migrations `20260912100000`, `20260912101000`, `20260912110000`, `20260912111000`, `20260912112000`, plus query/binding/evidence modules and verifier. Foundation worker owns `2026091209*`, settings/types, then `20260912120000` workflow commands. UI worker owns `_components`; Jitter worker owns separate P07 worktree. No app-level page integration or completed production claim yet.

### Concurrency checkpoint — September 11, local implementation

The three Luna workers completed initial foundation/workflow, presentation, and provider implementation assignments. They are now independently progressing launch tooling, existing detail action bindings, and call-path review. Root retains page integration, query/timing SQL, call reconciliation, and assembled verification. This uses built-in agents only; no Sandra Orchestrator dispatch or external coordination is involved.

- P01–P03 and P05/P06 worker reports implementation and private PG workflow checks passed; independent assembled acceptance remains.
- P10 navigation and P11/P12 presentation are integrated. Sidebar badge was corrected to the caller's Not contacted count, separate from stale KPI. Root commands inject authenticated organization scope. Calling uses actual contact/phone/DNC projection.
- P07 worker reports durable start-context persistence and seller-create delivery wired in Jitter with 245 focused tests and typecheck passed. No live provider/SQL/deployment evidence is claimed.
- P08 now reconciles call activity and provider receipt in either order without creating another attempt. Explicit outcome finalization is restricted to the original actor and verified attempt; original reassignment timing remains unchanged. Private PG proves both arrival orders, original-caller authorization, replay/conflicting replay, and no duplicate attempts. Concurrent transaction and full-schema review remain.
- Root selected unit command passed 126 tests across 11 files, plus command-integration test passed 4 tests. RTL selection passed 19 tests across 5 files. Root page lint and typecheck passed before the latest small badge/reference integration; rerun at assembled checkpoint.
- Minimal fixtures are not full deployed-schema compatibility proof. Launch, complete detail actions, full review/browser acceptance, commits/PRs, and authorized release remain outstanding. Feature is disabled by default. No hosted writes, real calls, test account provisioning, PRs, commits, or deployments have occurred.

### Full-runtime and integration review checkpoint

- Built a dedicated local Colima/Supabase runtime; details and cleanup ownership are in LOCAL-ACCEPTANCE.md. No shared/hosted resources are used.
- Replayed 216 committed baseline migrations and 13 new feature migrations. Real local GoTrue/REST checks prove owner/rep queue reads, cross-org member denial, attempt/readiness/offer commands, and contract recording without an offer. The missing-queue direct-contract failure was fixed and its authenticated replay now passes.
- Exactly four local acceptance principals and nine synthetic leads exist. The fourth principal is required to keep a permanent owner in the foreign test organization under the existing Hugo guard. No more acceptance principals may be created.
- The review claim that omitted softphone org IDs are rejected was withdrawn: the existing receiver defaults the authenticated org before validation, and its 11 tests pass. Tracked Jitter writeback now explicitly carries persisted original actor/org/property and provider identity; that improves provenance without changing legacy behavior. The Jitter worker fixed its attributable store-initialization test regression; full focused 245 tests and baseline/current executor 87 tests now pass.
- Root reconciliation now requires matching actor and seller provider alias, protects linked identity from later contradictory updates, retains the original bound actor through a receipt FK, and tests concurrent reassignment versus call binding. Explicit call-reference reads now enforce selected-member/property/feature scope.
- Appointment KPI excludes canonical reschedule predecessors; secondary phones participate in search; cross-member selectors and roster history use designation or eligible/launch history. Clean TypeScript and component SQL rehearsal pass after clearing a stale generated incremental cache.
- UI worker owns the pending detail-response generation/StrictMode fix. Foundation worker owns the pending launch correction for genuine pre-feature leads with no prior episode. Jitter worker owns actual local migration rehearsal.
- **Final local source/database parity is not yet claimed:** several function and launch revisions occurred after the first full-schema replay. Freeze the candidate and perform a fresh, hashed replay before final browser acceptance. No browser journey, PR, hosted rollout or deployment has been accepted.
