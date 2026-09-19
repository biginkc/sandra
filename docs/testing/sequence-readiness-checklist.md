# Sequence readiness checklist

This is a work checklist, not a release approval. All evidence must be tied to the final candidate source hashes and commit.

- [x] Isolated candidate and explicit user authorization recorded.
- [x] Opus 5 revision-3 plan approval recorded.
- [x] Disposable PostgreSQL stack, mock transport and external HTTP denial verified.
- [x] Database migration applies with active-claim index checks.
- [x] Three-step lifecycle and 20 synchronized claim trials passed in run 3.
- [x] Broad unit and component snapshot passed (4,622 / 1,511).
- [x] Run 4 recovery, stop-race, fixture and backlog failures repaired and rerun.
- [x] Remaining enrollment/import/tenant, durable stop, scheduling and post-send fault contracts exercised.
- [x] Queue overlap and clock-advancing in-flight budget contracts exercised.
- [x] Real app browser create/edit/enroll/thread/reply/pause/resume/cancel and tenant controls pass.
- [x] Targeted mutations fail specific assertions while positive controls pass; clean baseline reconfirmed.
- [x] Opus source review 3 and migration delta review pass, conditional on runtime evidence.
- [x] Repository-required verification and build pass on final source; changed-file lint is clean, repository-wide lint has pre-existing errors.
- [x] Dependency-correct PR prepared with exact tested SHA and evidence.

Live-provider and recurring-monitor phases remain specification-only, with allowance zero. Their future recipient authorization and atomic send-slot mutation checks must pass before any live execution; local readiness does not authorize live sends or production deployment.

Current tested code: `2ddeaf555436ce0316f824639c061a4f7b9eab95`; CI35228140861 passed231/231 database tests,6/6 browser cases and production build; Verify35228140824 passed. All seven targeted mutation proofs have before/failure/restoration evidence, passing controls and empty cleanup. See `sequence-readiness-results.md` and its source/provenance manifests. The final review verdict and any documentation-only head checks are recorded in PR #632. Production/provider equivalence remains UNKNOWN and live allowance zero.
