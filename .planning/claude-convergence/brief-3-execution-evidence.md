# Brief 3 — Sandra Jitter-route security hardening

## Goal

Implement contract item 3 from `sandra-jitter-contract-draft.md` §1.3.1 on a
fresh worktree, then verify and open a PR without merging.

## Plan alignment

- Plan item: Sandra build-list item 3 — org-scope all Jitter routes,
  crash-safe idempotency, atomic claim plus fencing generation.
- Related contract requirement: move `call_activities` writeback uniqueness to
  `(org_id, provider, jitter_attempt_id)`.
- Explicit exclusions: no Jitter-repo implementation, no deploy, no merge, no
  unrelated contract items.

## Acceptance gates

- [x] Batch GET returns no foreign-org batch data and exposes
      `claim_generation`.
- [x] Batch claim is org-scoped and compare-and-set; concurrent claims have
      exactly one winner; successful claims return a generation.
- [x] Item PATCH is org-scoped and requires the current session plus claim
      generation; stale generations cannot mutate the item.
- [x] Idempotency responses are recorded only after the mutation succeeds;
      an unprocessed replay is never returned as a successful cached response.
- [x] `call_activities` uniqueness is org-scoped and the writeback conflict
      target matches it.
- [x] Focused tests and the repository's standard full verification pass.
- [x] Manual review is complete for the final head; PR is opened with
      `Depends on: none`; no merge is performed.

## Baseline and preflight

- Worktree: `/Users/jarradhenry/Sites/BMH apps/Sandra-jitter-hardening-item3`
- Branch: `fix/jitter-routes-org-scoping`
- Baseline: Sandra `origin/main` / `d91a6df`
- Claude desktop surface: not used; no desktop control path was established.
- Claude CLI: installed and authenticated; fallback available if a review
  packet is needed.
- Repo/provider CLI: `gh` and `supabase` are callable.
- Browser/control plane: not required for this API/migration task.
- Dependencies/integration env: absent at preflight; verify after normal setup.

## Iterations

### 0 — reconnaissance

- Confirmed the route files live in Sandra, not the Jitter repo, despite the
  contract being stored in the Jitter checkout.
- Re-created the requested path as a Sandra worktree after removing the clean
  mistaken Jitter worktree.
- Confirmed current routes use service-role queries without org predicates on
  batch GET, claim, and item PATCH; claim is read-then-update; idempotency
  inserts a pending response before mutations and treats it as cached.
- Confirmed migration `083_org_scoped_call_activity_uniqueness.sql` is already
  on Sandra `origin/main`; it moves the existing unique key and matches the
  writeback conflict target. It will be preserved and tested rather than
  duplicated.

## Implementation

- Added org predicates to batch GET and writeback lookups; foreign-org IDs are
  indistinguishable from missing IDs.
- Added `claim_generation`, SECURITY DEFINER service-role RPCs, single-statement
  pending-claim CAS, same-session crash recovery, and parent-row locking before
  item fence validation.
- PATCH now requires `jitter_session_id` plus a safe integer generation and
  rejects stale leases.
- Split idempotency request identity (`request_hash`) from the cached response
  payload. Reservations remain pending until the mutation has committed and
  legacy pending rows receive a safe hash backfill.
- Made call-activity DNC/replay writeback safe after the mutation ordering
  change, including the existing org-scoped unique index from migration 083.
- Updated generated Supabase types and added route/unit/integration coverage.

## Verification evidence

- Focused Jitter integration: 4 files, 44 tests passed.
- Idempotency unit suite: 19 tests passed.
- `npm run verify`: typecheck passed; 213 unit files / 2,266 tests passed;
  81 RTL files / 760 tests passed.
- `npm run build`: passed. Expected dynamic-cookie and middleware deprecation
  messages were emitted by existing routes.
- The full integration run exercised 87 files / 1,083 tests and reported one
  unrelated `list-threads` statement-timeout under suite load plus the now-fixed
  crash-replay fixture omission. The `list-threads` file passes isolated (19/19)
  and the final Jitter suite passes after the migration backfill.
- Full `npm run lint` remains blocked by inherited repository-wide lint debt
  (319 existing errors across 430 findings); changed-file behavior was covered
  by typecheck, focused tests, build, and review.
- Fallow audit at commit `a554615` returned `warn` in new-only mode: 0
  introduced dead-code findings and 0 introduced complexity findings; its
  remaining warning is inherited route/type duplication (6 introduced clone
  attributions in generated/shared route shapes). Gate-all reports the same
  inherited findings as `fail`, not new dead-code or complexity.

## Review status

- Initial adversarial review found and drove fixes for same-session claim
  replay, parent-row fencing lock, malformed session validation, payload reuse,
  GET generation exposure, and legacy metadata backfills.
- Final read-only review verdict: APPROVE; no remaining blocking/high issue.
  The review ran with the closest available `codex-auto-review` model because
  the requested Sonnet model was unavailable in this runtime.

## Final outcome

Implementation commit is created and PR #378 is open at
https://github.com/biginkc/sandra/pull/378. No merge or deployment has
occurred.
