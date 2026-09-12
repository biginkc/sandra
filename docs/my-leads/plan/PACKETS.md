# Packet index and execution order

> **Execution amendment from Jarrad:** This feature task is fully isolated. Use built-in agents only; do not dispatch through or depend on Sandra Orchestrator, Messenger, or controller. Historical shared-coordination references below do not apply to this execution. Preserve actual authorization, account/provider limits, native CI, migration/deployment checks, and other worktrees. See [local acceptance](LOCAL-ACCEPTANCE.md).

Each packet has an explicit file boundary, steps, tests and completion evidence. Read [CONTRACTS](../CONTRACTS.md) before taking a packet. Proposed migration names are not executable filenames yet.

| Packet | Deliverable | Dependencies |
|---|---|---|
| [P00](packets/00-baseline-and-contract-adoption.md) | Baseline and contract adoption | None |
| [P01](packets/01-organization-settings-and-acquisitions-designation.md) | Organization settings and Acquisitions designation | P00 |
| [P02](packets/02-queue-state-and-assignment-episodes.md) | Queue state and assignment episodes | P01 |
| [P03](packets/03-attempt-and-offer-facts-with-command-idempotency.md) | Attempt and offer facts with command idempotency | P02 |
| [P04](packets/04-central-working-time-and-warning-functions.md) | Central working-time and warning functions | P00 |
| [P05](packets/05-readiness-and-offer-logging-commands.md) | Readiness and offer logging commands | P03 |
| [P06](packets/06-contract-decline-handoff-and-archive-commands.md) | Contract, decline, handoff and archive commands | P05 |
| [P07](packets/07-jitter-actual-seller-call-producer.md) | Jitter actual seller-call producer | P08 |
| [P08](packets/08-sandra-call-evidence-receiver-and-attempt-logging.md) | Sandra call evidence receiver and attempt logging | P03 |
| [P09](packets/09-scoped-queue-pages-details-and-kpi-queries.md) | Scoped queue pages, details and KPI queries | P03, P04 |
| [P10](packets/10-owner-controls-and-signed-in-sidebar-badge.md) | Owner controls and signed-in sidebar badge | P01, P09 |
| [P11](packets/11-five-section-queue-and-lazy-detail-ui.md) | Five-section queue and lazy detail UI | P09 |
| [P12](packets/12-workflow-dialogs-and-existing-action-bindings.md) | Workflow dialogs and existing action bindings | P05, P06, P08, P10, P11 |
| [P13](packets/13-launch-preview-initialization-and-rollback-tooling.md) | Launch preview, initialization and rollback tooling | P02, P06, P09 |
| [P14](packets/14-integrated-acceptance-and-coordinated-release.md) | Integrated acceptance and coordinated release | P07, P08, P10, P11, P12, P13 |

## Waves

1. P00 records the execution baseline and shared-file agreements.
2. P01 settings and P04 pure time work can proceed independently. Their migration timestamp allocation stays with one schema owner.
3. P02 episodes then P03 activity establish durable contracts. Consumers may develop against frozen types, not competing SQL definitions.
4. P05 offer commands, P08 receiver and P09 reads are independent once their dependencies pass. P06 follows P05.
5. P07 Jitter producer follows the P08 receiver contract; P10 owner/nav and P11 queue UI follow P09. P07 is a distinct repository owner, not a shared-file free-for-all.
6. P12 wires dialogs and P13 prepares launch independently once their listed dependencies pass.
7. P14 runs candidate-bound acceptance and coordinated release. A busy shared DB does not prohibit earlier private local work.

This is dependency parallelism, not authority to spawn implementation agents or create new feature sessions. Orchestrator decides who owns each packet. A packet can span more than one turn; it remains bounded by its files and acceptance criteria rather than a token/time promise.

## PR grouping proposal

- Foundation: P01–P04 (feature disabled, additive schema/types). Split into sequential foundation PRs only if needed for reviewability; migration/type ownership remains singular.
- Commands and reads: P05/P06/P08/P09, with producer P07 in its separately reviewed Jitter PR and explicit deployment compatibility contract.
- UI: P10–P12, stacked on reviewed unmerged prerequisites if applicable.
- Launch/acceptance: P13/P14 after code and provider evidence are reviewed. Actual cohort apply is an admitted operation, not an ordinary migration side effect.

Every PR declares actual dependencies and follows repository stacking policy. A packet does not equal a PR and does not reset the cumulative feature review/fix counter. Main CI and required migration/deployment verification gate every subsequent merge.
