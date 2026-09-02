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
- Worktree: `/Users/jarradhenry/Sites/BMH apps/_codex_worktrees/sandra-human-readable-dropdowns-cleanup`.
- Branch: `codex/sandra-human-readable-dropdowns-cleanup`.

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

- Status: in progress.
- Open PRs at start: draft #418 (Messages performance) and #337 (test locking). Neither is yet assumed as a dependency; changed-path overlap must be checked before PR creation.

## Destructive-action ledger

- No production rows or storage objects have been changed or deleted.
- Packet B deletion remains prohibited pending separate Fable approval.
