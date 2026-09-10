# Fable plan approval

User authority: 2026-09-10 explicit “PLEASE IMPLEMENT THIS PLAN”, all five numbered sections including merge/deployment, review and caps. Later coordinator reserves merges/shared production mutations for admission.

Plan-review counters: four requests; three substantive verdicts (two CHANGES_REQUIRED, one APPROVE); one malformed tool-markup response excluded. Code-review rounds: 0. Paid calls: 0 / $0.

Authenticated model metadata: claude-haiku-4-5-20251001, claude-fable-5-1

**APPROVE.**

The plan clears the three accepted changes and I find no remaining concrete blocker.

- **Paid-call gate is correctly structured.** External-to-browser termination proof, the atomically persisted locked ledger, pre-dial attempt counting, and pre-call spend reservation are all preconditions to dialing, not post-hoc checks. With the cost bound still unresolved, paid calls stay at zero while implementation and tests proceed. Real-call proof is a gated execution milestone and is not claimed as existing enforcement.

- **Snapshot identity model is sound.** Freezing rep name and lead identifiers at Call press from the last successful read-only pre-call read, keeping missing values unavailable, and letting later authenticated context fill only untouched spoken fields preserves trusted identity without inventing IDs. Pre-dial destination and eligibility revalidation with abort-and-reprepare closes the mismatch gap.

- **Inspection boundary is verifiable.** Read-only wrappers with zero writes, existing start actions unchanged, the private start-effects flag kept off the client surface, and per-boundary spies with exact counts give a testable contract. Draft retention with snapshot clearing on failed start, plus no new cross-tab lock, matches the accepted scope.

- **Copy and readiness rules are consistent.** Ready requires all basics, file, and situation. Training and manual show "Not available yet" without blocking. The callback label discloses that caller ID is unchanged. Retained script stays verbatim with no new spoken fallback.

Execution order to hold: root-cause fix and targeted tests first, then termination proof and cost bound, then ledger and reservation, and only then the four reserve calls.
