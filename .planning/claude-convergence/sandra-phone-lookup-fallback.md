# Sandra Phone Lookup Fallback Convergence Ledger

## Goal

- `goal_id`: `sandra-phone-lookup-fallback`
- Preserve a valid normalized lead phone when carrier classification is unavailable, so a temporary or configuration lookup failure is not misreported as an uncallable number and does not erase calling/texting entry points.
- Repair the demonstrated production behavior without weakening DNC, SMS opt-out, phone suppression, or confirmed-landline restrictions.

## Plan Source And Alignment

- Plan source: Jarrad's 2026-09-02 request in this task, the demonstrated production lead, and current `origin/main` behavior.
- Small-team boundary: Sandra serves 100 users or fewer; choose the smallest safe change and reject speculative frameworks or infrastructure.
- In scope: manual/shared lead intake fallback, database enforcement needed by that fallback, focused repair of already parked production records after release, and visible lead-detail proof.
- Out of scope: provider replacement, bulk-import redesign, unrelated messaging changes, or sending a real SMS/call during verification.
- Dependencies: none identified in open PRs #337 or #418; re-check before PR creation and merge.

## Baseline

- Git baseline: `71ba529d2c62c05edf5b8756d21efb4fb509bc4e` (`origin/main`).
- Production symptom: valid normalized phone is absent from all contact phone slots and retained only in notes after lookup failure.
- Root cause: production lacks the optional lookup credential; `createLead` collapses missing configuration, transient provider failure, and definitive unknown into `unknown`, then deliberately drops the phone because migration 080 forbids unknown-typed writes.

## Authority Profile

- `Production-aware`.
- Production reads are allowed.
- No real SMS, call, or other external customer contact during proof.
- Production database mutation, environment changes, manual deploys, and real provider side effects remain hard-gated by the convergence protocol unless already specifically authorized and all release gates are satisfied.

## Acceptance Gates

- [ ] A valid normalized phone survives new-lead creation when lookup configuration is missing.
- [ ] The same is true for a transient lookup failure; the failure is represented truthfully as unverified/unknown, not uncallable.
- [ ] Successful mobile classification still stores mobile and enables SMS/calling.
- [ ] Successful landline classification still stores landline, permits voice calling, and keeps SMS blocked as landline-only.
- [ ] Invalid/non-normalizable phone input is not promoted into a callable/textable field.
- [ ] Permanent DNC, contact DNC, SMS opt-out, phone suppression, and wrong/bad-number restrictions remain unchanged.
- [ ] CSV/bulk ingestion does not regress into silently saving unlabeled numbers if the database hard rule is narrowed.
- [ ] Focused unit/integration tests, typecheck, lint, and repository verify pass.
- [ ] Exhaustive Codex manual review is clean at the final head.
- [ ] Fable approves both the plan and the exact final head; any source-byte change invalidates the prior approval.
- [ ] PR declares `Depends on: none`, required checks pass, and the exact reviewed head is mergeable.
- [ ] Visible production lead-detail proof shows a repaired number and enabled calling/SMS entry points without sending a real message.

## Tool And Transport Preflight

- Primary reviewer surface: Claude desktop Code surface using Fable 5.
- Desktop status: reachable, but the currently open Fable task was actively running; it will not be overwritten. Use a separate new Fable task.
- CLI fallback: installed and authenticated; use only if the separate desktop surface proves unavailable or deterministic capture becomes necessary.
- Browser proof: Chrome is installed and the Chrome control path is available; real-browser verification will be performed at final readiness.
- Repo/provider tools: Git, GitHub CLI, Vercel CLI, and Supabase access are callable.
- Secret safety: packets redact phone numbers, emails, addresses, and credential values.

## Iterations

### Iteration 0 — Evidence and plan packet preparation

- Isolated worktree: `/Users/jarradhenry/Sites/BMH apps/_codex_worktrees/sandra-phone-lookup-fallback`
- Branch: `codex/sandra-phone-lookup-fallback`
- Evidence delta: production record and current source prove that lookup uncertainty is converted into phone deletion; production environment inventory proves the lookup credential name is absent.
- Next action: request Fable's adversarial plan verdict before implementation.

### Iteration 1 — Fable plan review

- `verdict`: `NEXT_STEP`
- `confidence`: `high`
- Fable accepted the direction but challenged the migration design: a per-path database bypass would be unnecessary complexity for a team of this size.
- Required proof before implementation: confirm that CSV import already drops unlabeled numbers before its database write and does not rely on migration 080 as its only guard.
- Verified source evidence:
  - `src/lib/csv/ingest.ts` calls `compactTypedPhones()` before `upsertContact()`.
  - `compactTypedPhones()` drops every phone whose normalized type is `unknown`, compacts only typed phones into contact slots, and reports the dropped count.
  - Focused CSV tests assert that a mixed row drops its unlabeled number and that an all-unlabeled row still creates the name/email contact with all phone slots null.
- Adversarial conclusion: removing the global trigger does not open the CSV path; the application guard is real and directly tested. If those CSV tests regress, release is blocked.
- Approved implementation shape: preserve a valid E.164 phone on `createLead` with type `unknown` when classification is missing, transiently fails, or returns definitive unknown; remove the global trigger in one forward migration; keep CSV behavior, compliance gates, and confirmed-landline SMS blocking unchanged; show truthful uncertainty in UI/API copy.
- Scope remains code, one migration, tests, and non-destructive verification only. No production writes, environment changes, record repair, or outbound contact are authorized in this iteration.

### Iteration 2 — Implementation and focused proof

- Implemented `createLead` fallback: every valid normalized phone is written to `phone_1`; lookup uncertainty writes `phone_1_type='unknown'` and returns `phoneUnverified=true`.
- Removed the old notes parking behavior and removed the phone number from the redirect warning URL. The new warning says the phone was saved and that calling and one-to-one texting remain available.
- Kept webhook compatibility with `phone_dropped: null` and added the truthful `phone_unverified` boolean.
- Added forward migration `20260902171248_allow_unknown_phone_for_lead_intake.sql`, created with `supabase migration new`, to drop migration 080's global trigger/function idempotently.
- Adversarial write-path check: CSV ingest, CSV phone-update operations, and skip-trace each reject/drop unknown-type numbers in application code before writing; inbound-message triage always labels demonstrated SMS senders mobile. No production phone-writing path was found that depended solely on the removed trigger.
- Focused proof:
  - TypeScript: pass.
  - Unit/application guards: 56/56 pass across lead creation, migration contract, CSV ingest, SMS send, and dialer eligibility.
  - Lead form server action: 5/5 pass.
  - Lead dialog UI: 7/7 pass, including truthful warning and no phone number in the URL.
  - Fresh isolated Supabase stack: all migrations applied successfully; focused lead integration 18/18 pass.
  - Migration second application: pass; both `drop ... if exists` statements safely no-op.
- Remaining before review: full lint/verify, exhaustive manual review, exact-head Fable review, PR/checks, and release/browser gates.

### Iteration 3 — Repository verification before manual review

- First full RTL run hit one unrelated Dropbox Sign timing failure; the isolated test passed immediately on the single allowed rerun.
- `npm run verify` rerun: pass — migration packet checks, typecheck, 3,511 unit tests, and 1,127 RTL tests all green.
- `npm run lint` is not a usable repository-wide gate at this baseline because it scans committed `.claude/get-shit-done` CommonJS tooling and reports 365 pre-existing errors outside the app. Scoped lint across every changed TypeScript/TSX file passes with no findings.
- Fresh-stack lead integration: 18/18 pass. Migration apply-twice proof: pass.
- Next action: create the review head and draft PR, then run parallel read-only manual-review lanes plus Fallow.

### Iteration 4 — Early static analysis

- Fallow command: `fallow audit --base origin/main --format compact`.
- Result: warning/fail leads, not an accepted defect. It reported inherited high-complexity functions, repository dependency leads, one pre-existing unused export, and test-fixture clone groups.
- Triage: none of the reported dead-code or dependency items were introduced by this change. The new integration cases repeat setup intentionally but prove different provider outcomes; consolidating them would reduce lines without increasing defect detection. No automatic fixes were run.
- Residual: Fallow's changed-file scope includes comment-only files and therefore repeats inherited complexity findings; manual lanes must judge the actual diff rather than accept the tool's labels.
