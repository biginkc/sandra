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
