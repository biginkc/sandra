# Sandra Leads and CSV v2 convergence ledger

## Goal

Complete the approved Leads Board and CSV Import redesigns, finish their shared DNC, promotion, urgency, and paging integrations, and stop before merge or deploy.

## Plan source

- User goal prompt in the active Codex task.
- Approved Leads and CSV prototype decisions recorded in the task history.
- Baseline: `5691daed02c47b324d6288952ef5bd443f53b210`.
- Integrated review surface before the final correction wave: `988832ef4255c101df847932844dcef8f7fb2848`.

## Authority and hard boundaries

- Production-aware, local implementation and disposable-database verification only.
- Do not apply migrations to shared or production databases.
- Do not read production PII, call paid providers, spend credits, send messages, merge, deploy, or open production traffic.
- Ordinary UI polish, refactors, unused-export cleanup, abstraction work, and optional hardening are deferred unless they close a demonstrated P0-P2 defect.

## Completed integrated checkpoints

- Leads and CSV branch integration foundation: `c83abbda016230d957678dff6539b5adeb2115e7`.
- Pre-spend skip-trace suppression: `f7d6918b68fe966d86bcc6f44db28bad8b03711e`.
- Permanent true-DNC lifecycle: `e3cf129654b75796a0e3c85304d0b4ee3fd77ef9`.
- Durable Promote to Leads: `3cfe8a1122a31990b9d7424824ffd37a425176d2`.
- Leads urgency and per-column paging: `988832ef4255c101df847932844dcef8f7fb2848`.

## Final exact-head review findings accepted for correction

Fifteen unique material findings were accepted; cosmetic and refactor-only leads were rejected.

### Backend and compliance safety

1. Non-default-organization consent and sidecar writes can violate composite tenant constraints.
2. Async skip-trace finalization can enrich a property after permanent DNC is set.
3. Paid CASS work can run for a permanently locked property.
4. Ambiguous post-provider skip-trace failures can be retried and double-spend credits.
5. CSV row replay can report a created property as a duplicate after a partial checkpoint failure.
6. Sequence-enrollment database guards do not fully protect delete, reassociation, and narrow compliance-stop transitions.

### CSV and recovery truthfulness

7. SMS-only suppression can be incorrectly escalated into irreversible true DNC.
8. CSV retry trusts mutable job metadata rather than authoritative tenant-owned import provenance.
9. Exhausted CSV workflow failures can leave jobs non-terminal.
10. Legacy county recovery performs database work outside a durable step.
11. CSV jobs with zero processed rows have no truthful retry path in Jobs.
12. Select-all over more than 1,000 prospects uses unstable offset paging.

### Leads tenant and paging correctness

13. Lead creation and webhook identity resolution are not consistently organization-scoped.
14. Equal-count concurrent page swaps can leave a stale or missing Leads card.
15. Lead assignment accepts a user identifier without proving active membership in every affected organization.

## Current correction wave

- Backend/compliance lane: findings 1-6 fixed at `18103f51b675d4f7a4b320032288bc9ff6f12b7d`.
- CSV/recovery lane: findings 5 and 7-12 fixed at `d0c539aa92281eb7bf6c26a99a5f572a4ee45f7f`.
- Leads tenant/paging lane: findings 13-15 fixed at `ae93cd521b11c515a827c372babb7382bc97ffaa`.
- Shared-worktree rule: each lane stages only explicitly owned paths and must inspect the staged path list before committing.

## Exact-head correction closeout

- Final review wave accepted and fixed nine additional material cross-lane findings covering CASS tenant provenance, DNC/sequence behavior, CSV retry truth, consent durability, and result accounting.
- Final correction commits:
  - `e7393168edd6d023bbb8cff9ff51eb9e26578b7f` — truthful retry progress and SMS-only visibility.
  - `8d73d0c3541066755555f2161385b43a7894c29a` — CASS tenant provenance and sequence DNC safety.
  - `9b8fee10ee1957ece90f034dce66880e21ec2562` — CSV recovery invariants.
  - `0088d59d58348556010ae588f9899373030212ae` — authoritative DNC import and immutable consent outcomes.
- The final `0088d59` fix surface was re-reviewed independently by database/security, application/accounting, and cross-integration lanes. All three returned CLEAN with no remaining P0-P2 findings.
- Cosmetics, refactors, abstraction changes, complexity-only observations, and optional hardening were deliberately excluded.

## Acceptance gates still open

- [x] All fifteen material findings fixed and committed without cross-lane scope contamination.
- [x] Focused unit, UI, database, migration, retry, tenant, duplicate, and concurrency suites pass.
- [x] Type checking and production build pass.
- [x] Changed-file lint adds no failures.
- [x] Full suites pass except independently proven unrelated baseline failures.
- [x] Every new migration applies and reapplies in a disposable database with its race and tenant invariants proven.
- [x] Desktop and narrow synthetic browser evidence is refreshed and visibly labeled as database-free; real schema-backed acceptance remains explicitly missing unless an approved disposable app database becomes available.
- [x] Diff, scope, and credential scans are clean.
- [x] Fresh independent exact-head review has zero unresolved P0-P2 findings.
- [x] Claude/Fable receives a secret-free exact-head readiness packet only after Codex manual review is clean.
- [x] Requirement-by-requirement completion audit passes.
- [ ] Stop before merge/deploy and request Jarrad's explicit approval.

## Known baseline gap

- Exact final branch proof: UI tests `638/638`; logic tests `2118/2119`; typecheck and production build pass; all migration/recovery/paging/DNC/provider-safety rehearsals pass; scoped lint and diff/credential scans are clean.
- The sole logic-suite failure is `src/lib/notifications/format.test.ts`, whose date-sensitive expectation reports `Due Yesterday`; it is unchanged and outside this change surface.
- Real schema-backed `/leads`, `/properties`, and import browser acceptance remains missing because the committed forward migrations were intentionally not applied to shared or production databases. Existing Chrome evidence is synthetic, desktop+narrow, and visibly labeled database-free.
- No migration, provider, production, messaging, credit, merge, deployment, or production-data action was performed.

## Claude/Fable readiness verdict

- Surface: authenticated Claude CLI, Fable model, secret-free exact-head packet.
- Verdict: `DONE`; confidence: medium.
- Materiality decision: no remaining P0-P2 code blocker. Cosmetics, refactors, naming, abstractions, complexity, duplication, unused exports, and optional hardening remain deferred.
- Required before merge/deploy: real schema-backed browser acceptance for `/leads`, `/properties`, and import after the forward migrations are available in an explicitly approved environment.
- Stop reason: implementation and local/disposable verification are complete; the remaining browser gate requires an environment decision outside this no-migration execution scope.
