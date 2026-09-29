# Inbox performance lanes

`bash scripts/inbox-ci/perf-120k.sh` and `bash scripts/inbox-ci/burst.sh` run on a GitHub runner against newly created local Supabase stacks. Both scripts require the three `2026092900*` migrations in the checked-out commit and refuse a dirty checkout. They never take a hosted URL. Each stack starts with the earlier checked-out migrations, receives the synthetic 120,000-group fixture (108,000 known conversations plus 12,000 unknown senders; 147,000 messages), and only then receives the three candidate migrations and eight concurrent indexes.

The lanes call W1's `provision-disposable-stack.mjs` with the three candidate migrations excluded and baseline-owner creation disabled. They consume only its loopback endpoints and stop each owned stack before starting the next attempt. The final GitHub environment handoff clears `E2E_LOCAL_WORKDIR` after the lane has stopped the stack.

The 120k lane runs the six D7 single-connection statements before and after installation, captures migration lock samples and table relfilenodes, and applies the absolute limits in `thresholds.json`. Its output is a runner measurement directory, not a `kind=burst` approval record. The full D7 baseline/after method is documented in the original D7 result; the code here is the promoted harness with local endpoints supplied by the lane.

The burst lane runs **three fresh-stack attempts**. Each schedules 16 writer connections for 120 seconds at 85 queued-to-sent updates/s and 20 inbound inserts/s, including three same-conversation pairs and two unknown senders per second. The worker calls match the D7-M3 scratch workload. `analyze.py` scores every attempt against the absolute §17 server latency, deadlock, lock-wait, and backlog limits. The lane records runner CPU and memory information for each attempt and accepts only 3/3 passes. The runner is not production-equivalent; Sandra Production has 2 vCPU.

A passing or failing burst produces one `pre-merge/burst/n/a/disposable` run directory under `docs/performance/inbox-redesign/evidence/<tested-sha>/`. All synthetic raw files are included; files over 1 MiB use deterministic gzip, and the packer refuses a run over 40 MiB. `raw_inflated_sha256` records hashes before compression. The runner does not commit or push evidence; W1's pull-and-seal step owns that transition.

Do not run the full burst on a shared local database or with a hosted Supabase URL. A scratch D7-M3 pass is context only; the required approval evidence is the runner's three-attempt sealed record at the migration head.
