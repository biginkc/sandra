# Sequences production canary operator runbook

The full canary workflow reads `SEQUENCE_CANARY_SCHEDULE_ENABLED` for scheduled runs and `SEQUENCE_CANARY_MANUAL_RUN_ID` for manual full runs. These existing controls still apply. Before enrollment, the runner reads full runs of `canary-sequences.yml` other than itself. Immediately before provider dispatch, the deployed app repeats that read. Any unresolved full run stops both paths. Every non-successful full run since the most recent clean success needs an acknowledgement, including a failed earlier attempt of a completed rerun. A scheduled run skipped because its full job never started is ignored; the latch checks that job through GitHub's attempt-specific jobs API. A failed, cancelled, timed out, or ambiguous full run still stops both paths, as does any full job that started but did not succeed. An unavailable GitHub read stops the canary.

`CANARY_GITHUB_READ_TOKEN` must be a fine-grained PAT scoped to this repository only, with **Actions: read** and **Variables: read** permissions. The runner and app only read the acknowledgement variable; neither changes it.

After investigating every non-successful full run or attempt since the most recent clean success, collect its run ID with `gh run list --workflow canary-sequences.yml`. Review each run's redacted summary and any cleanup failure. Set the repository variable to a comma-separated list of all those IDs:

```bash
gh variable set SEQUENCE_CANARY_FAILURE_ACK_RUN_ID --body "<id>[,<id>]" -R biginkc/sandra
```

The same variable is at **Settings > Secrets and variables > Actions > Variables**. An acknowledgement is an explicit operator reconciliation, not an automatic retry; it never permits an unresolved rerun. Keep the schedule flag disabled until the investigation is complete if further scheduling is undesirable. Any wrong-block caused by a skipped or cancelled run needs acknowledgement until live samples confirm the run conclusion and job `started_at` field values.

The workflow marks new manual runs as `full` or `preflight-only` in the GitHub run title so the read-only lookup can skip preflights. A legacy manual run without this mode marker is ambiguous and stops the canary. Investigate it, then acknowledge that exact run ID to resume; do not infer its mode from its conclusion.

No runbook action here authorizes contacting existing prospects or changing non-canary records. The canary uses its dedicated fixture and the existing send controls.
