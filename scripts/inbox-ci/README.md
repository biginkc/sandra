# Heavy CI lane contract

The workflow checks out the 40-hex `HEAVY_TESTED_SHA`, then invokes `scripts/inbox-ci/$LANE.sh` with `HEAVY_LANE`, `HEAVY_TESTED_SHA`, `GITHUB_RUN_ID`, and `GITHUB_RUN_ATTEMPT`. The lane receives no hosted credentials or URLs. It must use only a disposable local stack, write a hashed run under `docs/performance/inbox-redesign/evidence/$HEAVY_TESTED_SHA/pre-merge/<run_id>/`, and exit nonzero on any failed, skipped, retried, or incomplete guard. The workflow uploads records even after failure and stops its stack.
