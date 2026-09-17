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
- [ ] Targeted mutations fail specific assertions while positive controls pass; clean baseline reconfirmed.
- [x] Opus source review 3 and migration delta review pass, conditional on runtime evidence.
- [ ] Repository-required verification and build pass on final source; changed-file lint is clean, repository-wide lint has pre-existing errors.
- [ ] Dependency-correct PR prepared with exact tested SHA and evidence.

Live-provider and recurring-monitor phases remain specification-only, with allowance zero. Their future recipient authorization and atomic send-slot mutation checks must pass before any live execution; local readiness does not authorize live sends or production deployment.

Current full baseline:231/231 database tests,6/6 browser cases,production build and Verify passed at `72cab7c88442bf145aa382101bb77265465f55b0` (CI35224957464, Verify35224957477). Five valid mutation proofs are complete: claim uniqueness, advancement, persistence error, unsafe ambiguous retry and suppression. Final authorization startup and UI matcher classification still require corrected reruns with restoration evidence. Production/provider equivalence remains UNKNOWN and live allowance zero.
