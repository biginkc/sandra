# Independent mutation harness review

Status: CHANGES REQUIRED before any mutation execution. Read-only review; no DB or mutation executed. One existing filtered pure unit test was used to verify Vitest JSON behavior.

1. Vitest totals include skipped collected tests. Normalize executed assertions and require exactly one correctly named target/control. Failed-suite count alone is not a setup-failure count: an intended failing assertion also fails its suite. Verify against real passing and failing JSON reports.
2. A unique parent directory with child named `candidate` does not produce a unique Supabase project. Use a unique project/worktree basename, check occupied ports and resource ownership, and constrain cleanup to that project.
3. Broad message patterns such as `/claim/` admit fixture exceptions. Require assertion metadata and a specific expected assertion location/marker; reject hook, fixture, plain thrown-error and unrelated assertion failures.
4. Emit PASS only after verified cleanup. Cleanup failure must update the final evidence and exit nonzero.
5. Scrub structured reports and evidence JSON, not just command logs.
6. Use the repository-approved disposable E2E identity namespace for browser mutants.

The workflow is appropriately manual, selects one mutant, waits for a green baseline, checks out its exact SHA, uses fresh Ubuntu Docker, and has a bounded timeout. Final harness re-review remains required after fixes.

Final correction pass: executed-assertion normalization, setup-failure classification, assertion-kind and source-span checks, independent controls, unique Docker project ownership, cleanup-before-PASS, recursive artifact scrubbing, and approved browser identities are implemented. Seven patch dry-runs, Node syntax, ESLint, and real passing/failing Vitest JSON parser contracts pass. No actual mutation evidence is claimed; final read-only delta review and clean-SHA CI execution remain pending.

Final independent read-only delta review: no remaining concrete blockers. The advancement control stops before sending; authorization includes its earliest status assertion; uniqueness includes the aggregate count with an exact multiline assertion span. Actual mutation execution remains required.
