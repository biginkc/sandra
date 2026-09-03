# Sandra QA cleanup and dropdown labels convergence ledger

## Goal

Make affected Sandra dropdowns human-readable with correctly scoped assignee names; safely remove only exact-provenance Packet A QA data; classify Packet B records for separate Fable approval; preserve compliance/provider evidence; verify with tests and authenticated Chrome.

## Plan source and alignment

- Plan source: Jarrad's 2026-09-02 cleanup request and the read-only Fable 5 review in the originating Codex task.
- Fable verdict: `APPROVE_WITH_CHANGES`.
- Approved now: dropdown/assignee work and Packet A preparation/execution after prerequisites.
- Explicitly excluded pending separate approval: every Packet B deletion, including STOP/suppression records, provider receipts, and call recordings.
- Small-team boundary: 100 users or fewer; use one small presentation helper and explicit label maps, not a profile framework.

## Baseline and authority

- Git baseline: `origin/main` at `4510146a5b1c168bc35f942662e38047697261ee` on 2026-09-02.
- Production deployment observed in the original audit: `dpl_7PLoviCG8iXHfHWvQkzR2zeUqrZv`, source commit `71ba529d2c62c05edf5b8756d21efb4fb509bc4e`; refresh before runtime acceptance.
- Authority profile: production-aware. Production reads and exact canary-owned cleanup are allowed by repository policy; broad or irreversible non-canary deletion remains gated.
- Worktree: `/Users/jarradhenry/Sites/BMH apps/_codex_worktrees/sandra-dropdown-cleanup-clean`.
- Branch: `codex/sandra-dropdown-cleanup-clean`.

## Acceptance gates

- [ ] Every assignee picker is organization-membership scoped and excludes inactive, expired, and deletion-prepared members.
- [ ] Historical filters retain discoverability of rows assigned to inactive/former users.
- [ ] Visible person labels use authoritative full name first, optional email second, `(you)` for the current user, and never UUID fragments.
- [ ] The existing authoritative name source is reused or proven inadequate before any schema addition.
- [ ] Identified raw system enums have explicit human-readable presentation labels while stored/API values remain unchanged.
- [ ] User-authored tags and already-readable controls are not rewritten.
- [ ] Focused tests cover membership exclusion, historical filtering, label fallbacks, UUID-fragment absence, enum labels, and unchanged values.
- [ ] Packet A has exact-provenance manifests, dependency counts, stopped-worker proof, and backup/PITR proof before deletion.
- [ ] Packet A execution uses bounded transactions/count assertions and proves zero unrelated changes.
- [ ] Packet B has category-level retain/redact/delete rulings and separate Fable approval before deletion.
- [ ] Authenticated real-Chrome verification covers every changed dropdown and a representative already-good sample.
- [ ] Manual adversarial review and Fable final review are clean at the exact current head before merge.

## Preflight

- Claude desktop is running with Fable 5, but this runtime has no safe app-control surface for targeting a new desktop task without contending with existing sessions.
- Deterministic fallback verified: Claude Code CLI 2.1.258 is installed and authenticated; Fable review ran with model `claude-fable-5` and tools disabled.
- Repository tools verified present: GitHub CLI, Supabase CLI, Vercel CLI, Claude CLI.
- Browser verification path: Chrome control skill is available; session/identity must be verified before use.
- Main checkout is dirty with unrelated user/agent work and is preserved untouched. All writes use the isolated worktree above.

## Iterations

### Iteration 0 — plan approval

- Fable approved the dropdown plan and Packet A in principle.
- Blocking corrections adopted: Packet B separate approval; provenance rather than names; storage objects outside DB transactions; distinct active-picker and historical-filter scoping; reuse the existing name source first.

### Iteration 1 — reconciliation

- Status: implementation and first adversarial review complete; exact-head Fable review pending.
- Open PRs at start: draft #418 (Messages performance) and #337 (test locking). Neither is yet assumed as a dependency; changed-path overlap must be checked before PR creation.

### Iteration 2 — adversarial corrections

- Active assignment is enforced twice: active-only roster presentation and server-side lifecycle validation when a task is created.
- Lead/message assignment rosters are resolved from the target property organization. Cross-organization pages merge only their caller-authorized organization rosters; membership ordering is no longer treated as scope.
- Former owners remain displayable in historical filters and on lead detail while remaining unassignable.
- Identity labels use only administrator-controlled auth metadata, reject user-editable profile metadata and copied-email pseudo-names, and never invent a name from an email local part.
- Confirmed raw job, source, address-verification, disposition, AI-reason, and system-tag values now use presentation labels; custom tags remain verbatim.
- The cleanup export refuses Git worktrees, paginates stable ID queries, uses exact ID allowlists, and emits a generated-time-independent payload digest.
- Two consecutive production reads produced the same stable payload SHA-256: `2084508ed5ad3b01739b91fa66d614d40bc0d84476a946fc0606ca4809e499b9`.
- Private export directory: `/Users/jarradhenry/Documents/Codex/2026-09-02/sandra-cleanup-packet-iteration2` (directory mode 700, files mode 600). Export SHA-256: `4353d20580a37e87a7c7036a119e1695902f791740dbd27154414829fd222950`.
- Packet A exact counts: 1,326 synthetic contacts, 1,326 synthetic properties, 1,326 synthetic creation events; 3 explicit QA properties, 4 events, 1 completed task, 1 uniquely orphaned contact; 3 empty smoke sequences and 3 steps. One linked smoke sequence with 3 completed enrollments is retained and only proposed for archive.
- The already-archived browser-proof sequence and already-soft-deleted SMS template were removed from Packet A and remain untouched.
- Production has a completed daily physical backup from 2026-09-02; WAL-G backups are enabled and PITR is not enabled.
- The revised SQL inspects every live foreign-key child of contacts, properties, and sequences, asserts exact counts/provenance, and has completed another rollback-only rehearsal with the expected row ledger. Post-rehearsal counts confirm rollback preserved every target.
- Production and test schemas match for all exported tables except test has one extra nullable task column, so production rows remain shape-compatible with test. A restore write has not been performed.
- Manual review found and corrected active/former assignment, multi-organization scope, missing test-schema fallback, historical tenant leakage, ambiguous sender/campaign labels, and incomplete raw-system-label presentation.

### Iteration 3 — exact restore and access cleanup split

- The export now runs in one repeatable-read, read-only production snapshot and records every current foreign-key and known semantic dependency row, count, and digest.
- Latest private export: `/Users/jarradhenry/Documents/Codex/2026-09-02/sandra-cleanup-packet-iteration7` (directory mode 700; files mode 600). Export SHA-256: `a45b740f25019f5b879e23b5943cd511f46ba786fa5f2b6d464d6b75dc994f5b`. Stable payload SHA-256: `a9b57dcfa92ea7e41fa63e840147f70f8aab40f4dec249a5fb2ea061a2ba7483`.
- The exact export restored successfully into test project `ncsngxlcyxylaeskiteu` inside a serializable transaction, matched row counts and full-row digests for contacts, sequences, properties, steps, events, tasks, and memberships, and then rolled back. No test write persisted.
- Packet A was rehearsed again against production with its final statement fixed to `ROLLBACK`. A subsequent fresh production export had the same stable payload hash and exact counts, proving the rehearsal did not persist changes.
- Packet B is now a separate four-row access packet: two active browser/filter QA memberships and two suspended Hugo smoke memberships. Its whole-row hash is `4a0d6f2698defab726950fc6cc0fd5f9eed4e76fda236779fb48639a32819ded`. The SQL deletes membership rows only; auth identities and every Hugo/business/provider/compliance record remain retained. Its production rehearsal deleted four rows, left five active real/service memberships, and rolled back.
- Production and test credentials are explicit and project-pinned. A local environment file was found to target the test project; it is not used as production evidence or by the reviewed production name-sync command.
- The production name-sync dry run proposes five exact administrator-metadata labels: two full names from active Hugo profiles and three reviewed labels for retained exact-email real/service accounts. It reports 5 updates, 0 unresolved identities, 0 identifier mismatches, sealed hash `5f1d9a30eaeb51094310e2da584dd484a2f988a771082b40b02b461780428824`. Apply remains gated on Fable approval.
- Jobs with no title now show job type plus Central time instead of an ID, job/item types use readable labels, and job items resolve to property/contact labels without exposing raw UUIDs.
- Adversarial review corrections now fail closed on missing identity labels, keep former owners readable without making them assignable, require explicit workspace choice, intersect multi-workspace assignees, and reject deletion-prepared assignees in both current and legacy-compatible paths.
- Repository verification is green: eSign packet checks 7/7, unit files 314/314 with 3,541/3,541 tests, and browser-component files 108/108 with 1,134/1,134 tests. The repository-wide lint command remains red on 365 pre-existing errors in bundled `.claude/get-shit-done` code and unrelated legacy files; linting every changed JavaScript/TypeScript file has 0 errors (5 pre-existing warnings in the large leads action module/test).

## Packet B classification (no deletion authority)

- Retain: STOP/opt-out/DNC and suppression evidence; messages and provider receipts; call recordings/transcripts; completed enrollments; e-sign/Closer/coach outcomes; live operational leads; the completed dialer batch with unclear provenance; production canary proof records.
- Retain hidden: the already-archived browser-proof sequence and already-soft-deleted SMS template.
- Separately approvable membership deletion: the four exact QA membership rows in Packet B. Auth identities remain retained and unprivileged after membership deletion; no auth-user deletion is proposed.
- Redaction candidate only: recording media after a separately approved retention/export policy and two-phase object-storage handling. Database audit records remain retained.

## Destructive-action ledger

- No production rows or storage objects have been changed or deleted.
- Packet B deletion remains prohibited pending separate Fable approval.
- Every rehearsal used explicit `ROLLBACK`; the retained smoke sequence is still active and all four QA membership rows still exist until exact approvals authorize execution.
