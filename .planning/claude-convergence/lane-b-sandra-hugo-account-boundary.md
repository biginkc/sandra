# Lane B — Sandra Hugo account boundary

## Goal

- Goal ID: `lane-b-sandra-hugo-account-boundary`
- Plan source: Claude-provided EXECUTE block in the active Codex thread.
- Goal: remove Sandra's ability to create accounts or grant/remove app access,
  preserve existing-member role editing and the Team view, and route account
  lifecycle work to a configured Hugo URL.
- Baseline: `origin/main` at
  `a9aaf7ab71dd8f8e1258ec5a2dbcdc02454b5aa3` (merged PR #342).
- Authority: implementation and local verification only. Never merge. Do not
  apply migrations or change production state. Hosted verification may use
  disposable `sandra-crm-test` fixtures with cleanup. Leave PR #343 alone.

## Plan alignment and refute

- PR #342 is present on the freshly fetched baseline; no rebase or migration
  recovery is required.
- The Hugo boundary is internally consistent: account/app-access lifecycle is
  Hugo-owned, while Sandra role changes are app-owned post-login authorization.
- The `ADMIN_EMAILS` allowlist is a separate admin-entry policy and is not
  load-bearing for removing account lifecycle capabilities. It remains out of
  scope.
- Refute finding: baseline `/admin/users` renders role badges but no role-editing
  control. This lane must add an existing-membership-only role update rather than
  pretend an editable role path already exists.

## Transport and tool preflight

- Claude surface: manual Claude-to-Codex transport in the current thread; this
  ledger and the final REPORT return evidence to Claude for review.
- CLI fallback: `claude` is installed and its current auth-status check passes.
  A read-only follow-up review will run after manual findings are resolved.
- Available local tools: git, GitHub CLI, Node.js, and npm.
- Browser proof is intentionally deferred: this branch will not be deployed or
  merged, and Claude owns the acceptance/merge gate.

## Acceptance gates

- [x] No admin-UI-reachable `auth.admin.createUser`.
- [x] No app code deletes from `memberships`.
- [ ] Existing-member role changes persist and the person can still sign in.
      Hosted persistence and fresh password-auth proof pass; a real Hugo
      sign-out/sign-in through a protected Sandra route remains unverified.
- [x] `access_status`, `access_expires_at`, and `deletion_prepared_at` stay
      read-only in Sandra.
- [x] No `e2e/` spec depends on the removed grant/remove flows.
- [ ] Typecheck, lint, and unit suites pass. Typecheck and both unit suites pass;
      repository-wide lint has inherited failures described below.

## Evidence

- Admin lifecycle scan: zero `createUser`, `updateUserById`,
  `grantUserAccess`, or `removeUser` matches under
  `src/app/(dashboard)/admin/users`.
- Global `grep -rn "auth.admin.createUser" src/` now returns only integration
  fixtures and the Hugo-owned access provisioner; no result is reachable from
  the Team admin UI.
- Membership delete scan: zero
  `.from("memberships")...delete()` paths under `src/`.
- Hugo-owned field diff: zero changed `access_status`, `access_expires_at`, or
  `deletion_prepared_at` mutations under `src/`. The Team inventory now reads
  those fields so revoked, suspended, expired, and deletion-prepared rows are
  not mislabeled as active or offered role controls.
- Unchanged fences: zero diff in `dashboard-admin-nav.tsx` and all migration
  SQL. `loadSandraMemberships` remains the inventory path and is read-only.
- E2E dependency scan: zero grant/remove flow matches under `e2e/`.
- Config: `NEXT_PUBLIC_HUGO_URL` is documented and consumed; the Team surface
  contains no hardcoded `hugo.bmhgroupkc.com`.
- `npm run typecheck`: pass.
- Focused ESLint over all changed TypeScript/TSX: pass.
- `npm run test`: 134 files, 1,500 tests passed.
- `npm run test:rtl`: final run 53 files, 499 tests passed. The first broad run
  hit one unrelated menu timing failure in `prospects-table.test.tsx`; its
  isolated reproduction and the subsequent complete suite both passed.
- Hosted `sandra-crm-test` proof:
  `054_memberships_and_rls_rewrite.integration.test.ts` passed 14/14,
  including a persisted active-member role change, a fresh password sign-in,
  rejection of both suspended/deletion-prepared and active-but-expired role
  changes, and exact preservation of their role plus Hugo lifecycle state. No
  migrations were applied.
- `npm run lint`: fail on 433 inherited problems (324 errors, 109 warnings) in
  unchanged `.claude/get-shit-done` tooling and existing application/tests.
  Changed-file ESLint is clean; the repository-wide gate remains honestly
  not met.
- Fallow:
  `fallow audit --base origin/main --format compact` produced inherited
  unused-dependency leads, existing admin-page clone groups, and complexity
  leads in the Team page. Manual review classified them as inherited or
  non-actionable for this diff.
- Primary provider/framework references:
  Supabase JavaScript update/select and password sign-in docs, plus the
  installed Next.js 16.2.4 environment-variable and Link docs.

## Manual review

- Accepted and fixed: Team rows inferred every membership as active. The
  read-only inventory now displays Hugo lifecycle state and withholds role
  controls for inactive access, with suspended/revoked/expired/deletion UI
  coverage.
- Accepted and fixed: the VA handoff checklist still described Sandra's removed
  invite flow. It now routes account/access setup through Hugo.
- Accepted and fixed: production accepted remote HTTP Hugo URLs. Production now
  requires HTTPS; development permits HTTP only on loopback, with parser tests.
- Accepted and fixed: lifecycle preservation used only default field values.
  The hosted test now compares database-normalized, non-default state before and
  after the role-only update.
- Accepted and fixed after Claude follow-up: the UI withheld role controls for
  inactive rows, but the server action did not enforce the same trust boundary.
  The role update now atomically requires active, non-deletion-prepared,
  unexpired access. Hosted tests reject both suspended/deletion-prepared and
  active-but-expired rows without changing any field.
- Residual, not papered over: password auth proves the existing Auth identity
  survives, but it cannot prove Hugo provider login, protected-route access,
  responsive layout, or the configured production link. A visible browser pass
  on the deployed branch is still required for that evidence.
- No manual reviewer found an implementation or secret-handling defect after
  the accepted fixes. No secrets or credential values were read or printed.
- Final read-only Claude Code verdict: `REVIEW_CLEAN` after the active-access
  server guard. Its remaining expired-row proof suggestion was added and passes
  against `sandra-crm-test`.
