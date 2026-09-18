# Inbox production execution — 2026-09-17

## Completion contract
Full approved core Inbox usable in production after exact-candidate security, functional, stress/recovery, pilot and deployment verification. No customer sends or production stress traffic. Sequence enrollment, permanent DNC, Undo and Outbox rewrite excluded. Dormant code or merge is not completion.

## Current verified state
- Original saved-actions candidate: c4c769e6ad08ede4838b4b384b090875233ef186; original worktree clean and retained unchanged.
- Integration/product/infrastructure start: origin/main 36ee3f8cca42496e06e25c9cf6f8fac12d7b7521.
- Railway project inventory: no sandra-inbox project in accessible biginkc workspace. No provisioning performed.
- Existing owned fixture postgres belongs exclusively to backend lane for mutations. Other lanes require dedicated marked databases.
- Earlier tests and acceptance-matrix statuses are leads, not release evidence.

## Concurrent lanes and file ownership
- Backend: release-backend; experiments/inbox-saved-actions, action-api and saved-action-api. Existing owned fixture postgres exclusive operator.
- Product: release-product; src/components/inbox-workspace, src/app/inbox, new saved-action HTTP routes/helper, associated UI tests. No fixture mutations.
- Infrastructure: release-infra; experiments/inbox-production-install, new experiments/inbox-release harness. Dedicated DB only.
- Coordinator: release-integration; dependency review, release checklist, backend contract extensions, independent verification and integration. No shared fixture mutations while backend runs.

## Gates
- [x] Separate worktrees and worker ownership established.
- [ ] Saved-actions exact-head defects reproduced and repaired; candidate approval reset on changes.
- [ ] Missing core UI and backend behavior implemented.
- [ ] Production installer and complete isolated runtime rehearsed.
- [ ] Required dependencies independently reviewed and integrated.
- [ ] Full acceptance matrix passes, no required skips/blocked rows.
- [ ] Current and 3x growth full-stack performance/recovery passes.
- [ ] Production hosting/spend and pilot identity resolved before activation.
- [ ] Guarded migrations and code deployed with flags off; runtime verified.
- [ ] Owned no-send production smoke and rollback verified.
- [ ] Pilot accepted and default enablement verified.

## Behavior ledger
| ID | Requirement | Owner | Fresh evidence |
| --- | --- | --- | --- |
| F01 | Inbox / Outbox tabs | Product / coordinator | pending fresh integrated reproduction |
| F02 | Search messages | Product / coordinator | pending fresh integrated reproduction |
| F03 | Inbox filters | Product / coordinator | pending fresh integrated reproduction |
| F04 | Needs Outcome | Product / coordinator | pending fresh integrated reproduction |
| F05 | Hide DNC & tests | Product / coordinator | pending fresh integrated reproduction |
| F06 | Pagination and ordering | Product / coordinator | pending fresh integrated reproduction |
| F07 | Open and close a conversation | Product / coordinator | pending fresh integrated reproduction |
| F08 | Read message history | Product / coordinator | pending fresh integrated reproduction |
| F09 | Automatic mark-read | Product / coordinator | pending fresh integrated reproduction |
| F10 | Conversation identity/context | Product / coordinator | pending fresh integrated reproduction |
| F11 | AI status indicators | Product / coordinator | pending fresh integrated reproduction |
| F12 | Open record / copy links | Product / coordinator | pending fresh integrated reproduction |
| F13 | Call | Product / coordinator | pending fresh integrated reproduction |
| F14 | New Message | Product / coordinator | pending fresh integrated reproduction |
| A01 | Wrong number | Product / coordinator | pending fresh integrated reproduction |
| A02 | Bad / disconnected # | Product / coordinator | pending fresh integrated reproduction |
| A03 | Not interested | Product / coordinator | pending fresh integrated reproduction |
| A04 | Follow up | Product / coordinator | pending fresh integrated reproduction |
| A05 | Needs sequence | Product / coordinator | pending fresh integrated reproduction |
| A06 | SMS opt-out | Product / coordinator | pending fresh integrated reproduction |
| A07 | Permanent DNC unavailable here | Product / coordinator | pending fresh integrated reproduction |
| A08 | Move to Lead | Product / coordinator | pending fresh integrated reproduction |
| A09 | Book appt | Product / coordinator | pending fresh integrated reproduction |
| A10 | Assign to me / teammate | Product / coordinator | pending fresh integrated reproduction |
| A11 | Unassign | Product / coordinator | pending fresh integrated reproduction |
| A12 | Confirm Sandra disposition | Product / coordinator | pending fresh integrated reproduction |
| A13 | Correct an AI disposition | Product / coordinator | pending fresh integrated reproduction |
| R01 | Write/edit a reply | Product / coordinator | pending fresh integrated reproduction |
| R02 | Insert a template | Product / coordinator | pending fresh integrated reproduction |
| R03 | Send SMS / Cmd-Ctrl-Enter | Product / coordinator | pending fresh integrated reproduction |
| R04 | Use the conversation's reply route | Product / coordinator | pending fresh integrated reproduction |
| R05 | Restriction and route-change handling | Product / coordinator | pending fresh integrated reproduction |
| U01 | View unknown sender thread | Product / coordinator | pending fresh integrated reproduction |
| U02 | Merge with existing contact | Product / coordinator | pending fresh integrated reproduction |
| U03 | Merge with existing property | Product / coordinator | pending fresh integrated reproduction |
| U04 | Create new lead | Product / coordinator | pending fresh integrated reproduction |
| U05 | Dismiss unknown sender | Product / coordinator | pending fresh integrated reproduction |
| U06 | Restore dismissed sender | Product / coordinator | pending fresh integrated reproduction |
| U07 | Resolve known contact to an existing property | Product / coordinator | pending fresh integrated reproduction |
| U08 | Create property and resolve | Product / coordinator | pending fresh integrated reproduction |
| O01 | Inspect queued message cards | Product / coordinator | pending fresh integrated reproduction |
| O02 | Send next | Product / coordinator | pending fresh integrated reproduction |
| O03 | Send one queued message | Product / coordinator | pending fresh integrated reproduction |
| O04 | Start / pause auto-send | Product / coordinator | pending fresh integrated reproduction |
| O05 | Set cadence | Product / coordinator | pending fresh integrated reproduction |
| O06 | Edit queued text / save / cancel | Product / coordinator | pending fresh integrated reproduction |
| O07 | Delete queued message | Product / coordinator | pending fresh integrated reproduction |
| O08 | Load more queue rows | Product / coordinator | pending fresh integrated reproduction |
| O09 | Queue totals and timing | Product / coordinator | pending fresh integrated reproduction |
| O10 | Recover failed queue reads | Product / coordinator | pending fresh integrated reproduction |

Additional core rows: saved-action CRUD/version binding; single/bulk selection gestures and hidden review; snapshot-scoped dismiss/restore; reviewed bulk cap and durable attempts; operation recovery across disabled UI. Each requires real persisted outcomes, not screenshot-only assertions.

## Performance acceptance
First-open p95 <=1000ms; revisit <=200ms and selection <=100ms with p95/p99/exceedances; maximum 50 reply recipients. Measure realistic current workload and 3x growth with long histories, skew, concurrent users and sustained/burst arrivals. Remaining latency/lag/resource thresholds require explicit evidence-backed resolution before acceptance. No claimed stress pass yet.

## Independent coordinator evidence — integration 7410ae65
- G3 b2e1313f source reviewed; 12 worker tests passed. Removing per-item catch behavior makes regression tests fail; restore makes 6 core tests pass.
- G4 4c6d4908 source reviewed; 9 relay tests and 22 Next token tests pass. Loosened token alphabet negative control fails as expected; restored source.
- G5 854304da source reviewed; 75 route/unit tests and 9 page RTL tests pass. Removing context cohort check fails denial tests. Integration conflict preserved main's acquisition surface restriction as well as cohort denial; 10 read-route tests pass.
- Integrated additions: admission cohort enforced for metadata/reply prepare/accept; status/recover independent of admission flag while retaining repository authorization. Explicit INBOX_WORKSPACE_ROLLOUT_MODE=all reserved for full rollout; default pilot, unrecognized modes deny. 40 focused tests pass.
- npm run typecheck passes. VITEST_MAX_WORKERS=2 npx vitest run src/lib/inbox src/app/api/inbox: 37 files / 550 tests pass (includes inbox-v2 substring match).
- Production build passes at 7410ae65 after lockfile-based local npm ci. Initial Turbopack symlink-root failure was local dependency setup; no application patch was needed.
- Vercel live project: prj_gOQ6syLYw4og98H3cUPPNvDybnNc; production dpl_6P1s3DgCNnf8NCuh3mAsHEwkGK8M READY, SHA 36ee3f8cca42496e06e25c9cf6f8fac12d7b7521. Production env inventory: 63 entries, hidden count 0; workspace/actions/replies enable flags absent (source defaults off). Runtime behavior not yet independently certified.
- GitHub Production environment still requires reviewer biginkc; can_admins_bypass=false. Respect native approval gate when release packet is ready.
- Supabase management projects list returns Unauthorized. Production metadata/workload query access unresolved; no production stress performed.
- Original approved technical-specification.md at Documents/ChatGPT/New project 2/artifacts/design/inbox-workspace has SHA256 9074b4c2ee4302ebed6fa8342a2cc010a2d6b59a8b1992ff82574bbfc3209d07; architecture and implementation conditions shared with workers. Older optimize-first phase ordering is historical.
- User questions pending: initial pilot identities; acceptance of spec-proposed list/search/acceptance/arrival performance gates. These do not block implementation.

## Fresh installer gate findings
- Independent G2 4f7a0c33 selftest passes in guarded dedicated sandra_inbox_release_20260917. Original installed verification FAILS: four sync functions pinned as supabase_admin are created by supported clean installer as postgres. No original-head approval. Temporary four-owner correction for diagnostic tests is explicitly distinct from original source.
- Next verification exposed missing worker-role grants in assembled fixture. Reviewed worker-role.sql applied only to dedicated release DB; existing restricted cluster role unchanged. Corrected-owner baseline then passes; 38-case mutation run in progress. Final install order must include worker role before complete catalog verification.
- Global DB serving gate currently blocks receipt/recovery authorization; metadata commands lack independent DB admission/cohort checks. Release lane owns installer correction. HTTP-only fixes are insufficient.
- Golden-path CI diagnostic (not independent reproduction yet): run35274395117 fails old thread read_at persistence and Agent unknown merge affordance; two unknown-create cases flaky. Must reproduce in disposable E2E before waiver or fix.

## Required independent Opus gate
User instruction (2026-09-17): every PR created for this release requires Opus 5 approval at its exact current head in addition to the coordinator adversarial gate. Every commit resets approval. Record PR, full SHA, actual reviewer model, verdict, blockers and evidence. Never substitute another model or CI status. Reviewer availability being verified through existing Claude Max subscription.

G2 diagnostic update: after documented temporary four-owner correction and intended worker-role installation, baseline and all 38 mutation cases independently pass, including restoration after every case. Original source restored; original G2 head is still unapproved. Release DB returned to infra with serving=false and zero verifier scratch schemas.

## Coordinator verification continuation
- Existing Claude Max CLI successfully resolved claude-opus-5 at medium effort (availability probe only, no approval). Component review of admission commit 7410ae65a3dfe84875ccd3e70240816b5ce5373f is running; final PR-head review still required.
- Full npm test at 7410ae65: 422 files pass, one file skipped; 4817 tests pass, three skipped. These skips do not satisfy any required acceptance row. Full RTL suite running separately.
- Direct live pg_proc/has_function_privilege read of five saved-action wrappers confirms SECURITY DEFINER, empty search_path, lock_timeout=3s, statement_timeout=15s, authenticated execute=true, anon/service_role=false. Broader PUBLIC/default ACL and mutation/security checks remain independent gate items.
- UI ce350d4c remains unapproved: terminal saved dialog cannot close or permit subsequent action; expired uncertain preparations block UI recovery; terminal reply failures hidden behind generic completed text; stale saved preparation can reopen after cancel. Product lane fixing with regression tests.

- Opus 5 component review completed for 7410ae65a3dfe84875ccd3e70240816b5ce5373f: APPROVE_COMPONENT YES, BLOCKING 0. Read-only review lacked its own shell SHA resolution; coordinator supplied exact git diff. This is not final exact-head PR approval. Reviewer requires real authenticated rollback/read isolation checks after installer repair.
- Full RTL first run:150 files/1543 tests pass, one My Leads background queue-refresh test fails because readiness form remains open with validation error. Isolated test and all28tests in its file pass; full-suite rerun in progress, failure remains recorded.

- Full RTL rerun at unchanged7410ae65 passes151files/1544tests. Earlier full-run readiness failure remains a recorded intermittent failure; isolated test and28-test file both pass. No required acceptance row is waived by this rerun.
- Production UI follow-up review remains open: strict sourceOperationId reply envelope,1..50 recipient count, uncertain acceptance retry, original target verification, abort/generation lifetime are being corrected before integration. Saved CRUD streamed-body abort must cancel a blocked reader.
