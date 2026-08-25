# Sandra lead activity ledger convergence ledger

## Goal

Add an append-only `lead_events` ledger as a fourth source in the existing lead activity timeline, instrument only approved persisted lead mutations, backfill only provable history, and ship through production verification without duplicating canonical messages, notes, or calls.

## Execution boundary

- Repository: `/Users/jarradhenry/Sites/BMH apps/Sandra`
- Isolated worktree: `/Users/jarradhenry/Sites/BMH apps/_codex_worktrees/sandra-lead-activity-ledger`
- Branch: `feat/lead-activity-ledger`
- Base: `origin/main` at `bd76d91b95d505196f5f47b0386508673020d017`
- Dependency declaration: `Depends on: none`
- Excluded workflow: GitHub run `32894318130`

## Locked scope

- Keep messages, notes, and calls canonical and unduplicated.
- Add a ten-field tenant-safe ledger: `id`, `org_id`, `property_id`, `actor_type`, `actor_id`, `event_type`, `payload`, `source_type`, `source_id`, `created_at`.
- Put bulk `batch_id` and counts in JSON payload; do not add batch columns.
- Use a narrow string union and plain JSON; no payload class hierarchy or plugin renderer.
- Browser clients may read only. All writes use a server-only, best-effort helper and may not fail the parent mutation.
- Record only confirmed persisted changes. Skip failures, no-ops, retries, failed bulk rows, propertyless ambiguity, and sensitive bodies.
- Backfill only provable lead creation/qualification, property-linked tasks, exact appointment history, and consent events.
- Add lead events to the existing chronological activity feed with Realtime INSERT handling, safe unknown-event rendering, and compact bulk grouping.
- Preserve existing message bubble rendering.
- Notes remain in their current feed; label note additions with actor and timestamp. No note-edit history is invented.

## Anti-bloat rule for every Fable review

This product serves 100 users or fewer. Reject enterprise architecture and scope expansion, including queues, workers, event buses, retry services, payload frameworks, analytics, reporting, exports, filters, settings, pagination/virtualization, plugin renderers, or speculative future-proofing.

## Acceptance evidence

- Schema/RLS/Realtime/append-only/source-idempotency integration tests.
- Best-effort writer isolation, truthful no-op/retry/partial-bulk tests, and backfill rerun proof.
- Timeline interleaving, Realtime, unknown type, bulk grouping, note label, and no-duplication tests.
- Full lint, typecheck, unit, RTL, integration, hosted test migration, PR checks, manual adversarial review, current-head Fable approval, preview Chrome proof, protected production migration, exact-SHA deployment, and production Chrome proof.

## Review rounds

### Round 0 — pre-implementation

- Status: `APPROVE_SCOPE` — confidence 0.9
- Current head: `bd76d91b95d505196f5f47b0386508673020d017`
- Fable finding: current main supports the refined four-source plan; existing notes already display actor and timestamp, so no extra note-card feature is needed.
- Next bounded step: schema, append-only RLS/grants, Realtime, reset helper, paired integration test, and generated type shape only.
- Locked decision: trusted server writes use `createAdminClient()`; no SECURITY DEFINER write RPC.

### Round 1 — schema implementation review

- Status: `APPROVE_STEP` — confidence 0.9
- Blocking findings: none
- Verified: composite tenant FK, read-only member RLS/grants, exact reset-helper preservation, source idempotency, guarded Realtime publication, generated type shape, and auth-user deletion preserving historical actor type.
- Non-blocking guard for next step: the writer must always supply `actor_id` when recording a live `user` event even though historical rows may become null after account deletion.
- Next bounded step: server-only best-effort writer and focused unit tests; no call-site instrumentation yet.

### Round 2 — writer review

- Status: `REJECT_STEP` — confidence 0.8
- Blocking finding: one unbounded PostgREST property lookup could silently omit rows above the response cap.
- Resolution: chunk property ownership reads at 250, abort on any chunk error, keep the final event insert single-shot, and warn only with requested/skipped counts.

### Round 3 — writer re-review

- Status: `APPROVE_STEP` — confidence 0.93
- Blocking findings: none
- Verified: two ownership reads for 251 properties, one 251-row insert, sanitized failure/skip logs, truthful partial-property behavior, server-only admin client, exact vocabulary exclusions, and parent-action failure isolation.
- Accepted small-team tradeoff: no transaction around property lookup and insert; a racing property delete causes the best-effort insert to fail and be logged without affecting the parent action.
- Next bounded step: instrument lead creation and qualification first, including a test that ledger failure does not change the successful parent result.

### Round 4 — lead creation and qualification review

- Status: `REJECT_STEP` — high confidence
- Blocking finding: client components imported `LEAD_SOURCES` through the now server-persistent lead creation module, so adding the event writer connected the browser module graph to admin-only code.
- Resolution: move `LEAD_SOURCES` and `LeadSource` into a pure leaf module, repoint every importer, restore the `server-only` tripwire, and install the official `server-only` package.
- Verified before the next round: the production Next build passed with the tripwire active, proving no client graph reaches the writer.

### Round 5 — server/client boundary re-review

- Status: `REJECT_STEP` — confidence 0.9
- The round-4 production boundary blocker was resolved.
- Blocking finding: Vitest's integration environment did not resolve Next's `react-server` condition, so direct imports of the protected server modules threw before the new integration tests could run.
- Resolution: alias `server-only` to the package's own `empty.js` implementation in both Vitest configs. The real package export and production tripwire remain unchanged.

### Round 6 — test-harness re-review

- Status: Fable `APPROVE_STEP` — confidence 0.9; Codex commit gate rejected the slice
- Fable blocking findings: none
- Verified independently by Fable: the aliases target the installed package's own empty implementation, the production writer still imports `server-only`, focused unit tests passed, and the hosted creation/qualification pair passed 19/19 six consecutive times.
- Codex adversarial finding: Fable checked the unit and integration configs but missed the separate RTL config. The full pre-commit gate rejected eight browser-component suites because that runner still loaded the production tripwire.
- Resolution under test: apply the identical official-package alias to `vitest.rtl.config.ts`, then rerun the complete pre-commit verification. Fable approval is invalidated until the changed head is re-reviewed.
- Observed non-blocker: shared hosted integration state produced earlier transient missing-row failures. Repeated clean runs show no persistent ledger defect. Do not add a blind insert retry: an ambiguous network result could duplicate events lacking source identity. Prefer bounded assertion polling only if the full hosted suite proves a recurring ledger-visibility flake.
- Scope review: the slice remains appropriate for fewer than 100 users; no queue, event bus, retry service, or speculative framework was added.
- Next bounded step: remaining declared mutation call sites, beginning with lead fields and disposition.

### Round 7 — complete test-runner boundary review

- Status: `APPROVE_STEP` — high confidence
- Blocking findings: none
- Verified independently by Fable: the RTL alias is the same four-line mapping to the installed package's own `empty.js`; `npm run test:rtl` passed 87 files and 817 tests; Next ignores Vitest configs so the production tripwire remains intact.
- Scope review: no new behavior, dependency, abstraction, or enterprise machinery was added.
- Next bounded step: commit this slice, then instrument `reverted_to_prospect`, `status_changed`, and `motivation_changed` using the established confirmed-change pattern.

### Round 8 — lead field mutation review

- Status: `APPROVE_STEP` — high confidence
- Blocking findings: none
- Verified: status, motivation, and revert events append only after the action's compare-and-set persisted a real change; idempotent targets, unchanged values, conflicts, failures, and DNC-locked branches return before emission.
- Verified: actor lookup failures fall back to `system`, and the best-effort writer remains failure-isolated; payloads contain only `from` and `to`.
- Accepted behavior change: motivation and revert now use compare-and-set plus reconciliation instead of blind last-write-wins. That is required to prevent a stale client from creating a false event or overwriting a concurrent change.
- Non-blocking: conflict branches do not each have a direct zero-event assertion; a row deleted during reconciliation returns a conflict rather than not-found; one awaited admin round trip is acceptable at this scale.
- Scope review: appropriate for fewer than 100 users, with no queue, event bus, or extra abstraction.
- Next bounded step: `assigned` events, beginning with the single-property action and then truthful bulk semantics.

### Round 9 — assignment mutation review

- Status: `APPROVE_STEP` — high confidence
- Blocking findings: none
- Verified: single assignment uses old-value compare-and-set and emits only after a real persisted change; bulk assignment partitions every requested row into changed, skipped, or failed without double-counting.
- Verified: null and non-null previous assignments use correct predicates; partial group failures are not reconciled twice; missing/deleted rows cannot be counted as successes; notifications receive only changed IDs.
- Verified: one `recordLeadEvents` call carries a shared `batch_id` and actual-success `batch_count`; actor IDs are required before using actor type `user`.
- Non-blocking test gaps: cover mixed prior-assignee groups plus an unchanged row, and assert the single clear-assignment payload.
- Scope review: grouping by prior assignee is the smallest correct concurrency-safe bulk shape for fewer than 100 users, not enterprise machinery.

### Round 10 — assignment test-gap re-review

- Status: `APPROVE_STEP` — high confidence
- Blocking findings: none
- Verified without touching the paused shared database: the completed pre-pause hosted run passed 36/36; the new mixed batch test proves two actual changes, one skip, truthful prior values, shared batch metadata, and count two; the single clear test proves `{from: userId, to: null}`.
- Non-blocking carry-forward: the shared-ID assertion should also require UUID shape so two missing values cannot satisfy the set-size check.
- Shared test coordination: hosted Sandra integration/E2E runs are paused at PR #409's request until its rerun owner confirms the database is clear.
- Next bounded step: tag and list membership events using the validated bulk pattern.

### Round 11 — tag and list membership review

- Status: `APPROVE_STEP` — high confidence
- Blocking findings: none
- Verified: single tag apply/remove uses returned inserted/deleted rows, so idempotent no-ops emit nothing; bulk tag and list operations derive successes from returned membership rows and issue one event batch with actual-success counts.
- Verified: payloads contain only membership ID, label, and batch metadata; actor invariants hold; partial writes remain truthfully partitioned.
- Non-blockers: 500 UUID query chunks were larger than the event writer's proven boundary; list re-add no longer refreshes `last_added_at`; Fable proposed a generic tag/list membership helper.
- Codex decision: accept the concrete chunk-size correction and intentional no-op semantics; reject the generic callback helper because the two schemas and failure policies differ and two call sites do not justify an abstraction.

### Round 12 — membership chunk and anti-bloat re-review

- Status: `APPROVE_STEP` — confidence 0.95
- Blocking findings: none
- Verified: one shared membership chunk constant is 250 and covers tag lookup/pre-read/insert plus list pre-read/insert/remove; no old 500-row constant remains.
- Accepted anti-bloat judgment: keep the two short table-specific paths explicit rather than introduce a generic callback framework.
- Intent recorded: re-adding an existing list membership is a no-op and does not refresh `last_added_at`; the CSV import path that intentionally maintains that timestamp is untouched.
- Carry-forward: the initial add-list property lookup was still unchunked.

### Round 13 — add-list ownership lookup re-review

- Status: `APPROVE_STEP` — confidence 0.95
- Blocking findings: none
- Verified: add-list deduplicates requested property IDs, reads ownership in disjoint 250-ID chunks, returns before writes on any lookup error, and reports each unique missing property once.

### Rounds 14–15 — membership outcome accounting proof

- Status: `APPROVE_STEP` — high confidence
- Blocking findings: none
- Remove-list proof: disjoint delete statements are atomic; every unique requested ID is exactly one of returned/removed, skipped because no visible membership existed, or failed with its whole failed chunk.
- Add-list proof: existing memberships and candidates are disjoint; successful chunks count returned inserts as successes and concurrent duplicates as skips; a failed chunk and all remaining candidates become failures before the processed count advances.
- The defensive `Math.max` cannot conceal a negative count because returned inserted rows cannot exceed processed candidate rows.
- Scope review: no retries, wrapping transaction, generic framework, or other enterprise machinery is warranted for fewer than 100 users.
- Verification boundary: hosted tag/list assertions are written but remain intentionally unrun while PR #409 owns the shared Sandra test database.
- Next bounded step: task lifecycle events.

### Round 16 — task lifecycle pre-Fable manual review

- Review surface: uncommitted task lifecycle slice on `3864c17`; hosted integration intentionally paused while Sandra PR #409 reruns against the shared test database.
- Manual lanes: mutation/concurrency correctness, server/auth/Slack boundary, and tests/static analysis. All three final re-reviews returned no findings.
- Fixed P2: generic snooze now requires `open`, compares both prior status and due time atomically, and refuses reconciliation after completion. This prevents a completion race from creating a later `task_snoozed` event or moving its Calendar entry.
- Fixed P2: Slack completion passes an expected assignee; completion compares the prior assignee atomically and refuses stale attribution after reassignment.
- Fixed test-proof gaps: exact update payloads, queue exhaustion, exact Calendar payload, property-linked appointment exclusion, direct actor/auth forwarding, same-target concurrency reconciliation, initial/post-race completion guards, failed writes, and private-title/body exclusion.
- Corrected invalid fixture: the live schema permits propertyless appointments but forbids propertyless non-appointment tasks. The hosted exclusion test now uses a propertyless appointment and expects no generic task event.
- Rejected scope expansion: no outbox, retry worker, transaction RPC, generic lifecycle framework, or policy abstraction. An ambiguous update response can still leave a missing best-effort event; blindly retrying could create duplicates and is not justified for fewer than 100 users.
- Static analysis: Fallow completed. New duplication leads are intentional explicit compare-and-set paths/tests; inherited unused exports/dependencies remain out of scope. Slack formatting-only churn was removed.
- Local verification: typecheck passed; focused task/action/Slack suites passed 59/59; scoped lint passed; production build passed. The build continues to log the existing handled `/templates` dynamic-render warning.
- Human browser review at this slice: no. This is server-side mutation behavior with no UI change; final timeline UI will receive browser review and production Chrome acceptance later.
- Next review: Fable must independently inspect the current uncommitted slice, explicitly challenge sub-100-user scope/bloat, and return the next bounded step. Hosted integration remains unrun until PR #409 releases the shared database again.

### Round 17 — task timestamp-format re-review

- Fable verdict: `REJECT_STEP` — confidence 0.85.
- Blocking finding: browser snooze sends ISO `Z` while PostgREST can return the same instant as `+00:00`; raw string equality could miss a no-op and append a false `task_snoozed` event.
- Fix: both initial and reconciliation no-op guards compare epoch milliseconds. Unit tests cover both `Z`/`+00:00` formats on the initial guard and same-target reconciliation; hosted assertions normalize event timestamps before comparison.
- Fable non-blockers accepted without code expansion: ambiguous committed writes remain best-effort, lifecycle event source identity is creation-only, and pre-existing completed-task reassignment remains unchanged.
- Post-fix manual re-review: correctness and test lanes both returned no findings; explicit epoch comparison is appropriate for fewer than 100 users and no normalization framework is warranted.
- Post-fix local verification: typecheck passed; focused suites passed 59/59; scoped lint passed; production build passed with only the existing handled `/templates` dynamic-render log.
- Hosted integration remains paused at PR #409's explicit request.

### Round 18 — task lifecycle hosted integration proof

- Shared-database coordination: the PR #409 owner released its exact-head E2E window; this task announced its scoped run before starting and released the window immediately after completion.
- Test guard: the run used the repository's validated Sandra TEST configuration and PostgreSQL advisory lock. No production project or unlocked fixture reset was used.
- Hosted verification passed: `tags.integration.test.ts` 10/10, `bulk-actions.integration.test.ts` 26/26, and `tasks/index.integration.test.ts` 2/2; total 38/38.
- Task proof: one truthful event is persisted for create, snooze, reassign, and complete; immediate retries/no-ops, failed transitions, post-completion snooze, and propertyless appointments do not create generic task events; payloads exclude private task title/body text.
- Fable's round-17 implementation approval remains current because no implementation or test code changed after that review; this round records only the subsequently completed hosted evidence.
- Next bounded step: commit and push the approved task slice, then instrument appointment lifecycle events without broadening into a generic lifecycle framework.
