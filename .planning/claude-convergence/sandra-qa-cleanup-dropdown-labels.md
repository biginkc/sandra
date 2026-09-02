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
- Identity labels prefer administrator-controlled auth metadata, retain the legacy administrator-created name during migration, reject a copied email as a name, and never invent a name from an email local part.
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

## Packet B classification (no deletion authority)

- Retain: STOP/opt-out/DNC and suppression evidence; messages and provider receipts; call recordings/transcripts; completed enrollments; e-sign/Closer/coach outcomes; live operational leads; the completed dialer batch with unclear provenance; production canary proof records.
- Retain hidden: the already-archived browser-proof sequence and already-soft-deleted SMS template.
- Access review, no deletion yet: stale production QA memberships/auth identities. No currently active property is assigned to an inactive or QA-only identity, but Hugo and Sandra access state must be reconciled before revocation.
- Redaction candidate only: recording media after a separately approved retention/export policy and two-phase object-storage handling. Database audit records remain retained.

## Destructive-action ledger

- No production rows or storage objects have been changed or deleted.
- Packet B deletion remains prohibited pending separate Fable approval.
- Rehearsals used explicit `ROLLBACK`; the retained smoke sequence is still active until an exact approved execution changes it.
