# Heavy CI lane contract

The workflow checks out the 40-hex `HEAVY_TESTED_SHA`, then invokes `scripts/inbox-ci/$LANE.sh` with `HEAVY_LANE`, `HEAVY_TESTED_SHA`, `GITHUB_RUN_ID`, and `GITHUB_RUN_ATTEMPT`. The lane receives no hosted credentials or URLs. It must use only a disposable local stack, write a hashed run under `docs/performance/inbox-redesign/evidence/$HEAVY_TESTED_SHA/pre-merge/<run_id>/`, and exit nonzero on any failed, skipped, retried, or incomplete guard. The workflow uploads records even after failure and stops its stack.

Each run directory must contain `manifest.json` and every artifact named by its `artifacts` map. Required manifest fields are:

- Identity and check: `tested_sha`, `tier`, `run_id`, `kind`, `phase`, `target`, `verdict`, `exit_status`, `started_at`, `completed_at`.
- Workflow provenance: `workflow_path`, `workflow_input_sha`, `github_run_id`, `github_run_attempt`, `artifact_name`, `event`, `head_branch`, `lane`, `runner_script_sha256`.
- Collection integrity: `clean_tree` with `start`, `end_excluding_run_dir`, and `excluded_path`; `artifacts` mapping every committed artifact path to its SHA-256.
- Outbox lane only: `fault_proxy_script_sha256`. Other lanes do not need this field.
- Compressed raw artifacts only: `raw_inflated_sha256` mapping the original filename to the SHA-256 of its uncompressed bytes.

Keep complete FAIL and INCONCLUSIVE records: the downloader can seal them, and the approval gate rejects a latest required check unless its `exit_status` is zero and `verdict` is `PASS`. Never include `external_artifacts` or credentials in a record.

`perf-120k.sh` is a dispatchable measurement lane. Its sealed manifest uses `kind: perf-120k`, `phase: n/a`, `target: disposable`, and `tier: pre-merge`, with the same workflow and runner provenance as other heavy lanes. Record the absolute §17 thresholds and measured values in `summary`. This kind appears in no J5a or J5b approval matrix; a PASS cannot replace a missing required check. The `burst` kind remains required for J5b.

## Migration-apply records

For `kind: migration-apply`, the manifest's `workflow_run` retains `workflow_path`, `run_id`, `run_attempt`, `head_sha`, and run-level `conclusion`. It must also contain `apply_job: {name, id, run_id, run_attempt, conclusion}` from the GitHub Jobs API. The name is exactly `Apply migrations to test` for `db-migrate-test.yml` or `Apply migrations to prod` for `db-migrate-prod.yml`. The apply job must have `conclusion: success` and the same run ID and attempt as `workflow_run`; a successful run with a skipped apply job does not count.

Production records additionally require `bind_upstream_job` with the same five fields, name exactly `Bind upstream test run`, `conclusion: success`, and the same run ID. Its attempt may be earlier than the current run attempt because a gated-job-only rerun reuses the successful bind job. Record the actual job ID and attempt; do not infer them from the workflow conclusion or artifact name. The existing target binding, schema migration ledger, and committed catalog fingerprint checks remain required.
