# Sequences production canary operator runbook

The full canary workflow reads `SEQUENCE_CANARY_SCHEDULE_ENABLED` for scheduled runs and `SEQUENCE_CANARY_MANUAL_RUN_ID` for manual full runs. These existing controls still apply. Before enrollment, the runner also reads the most recent completed full run of `canary-sequences.yml` other than itself. Immediately before provider dispatch, the deployed app repeats that read. A failed, cancelled, or ambiguous result stops both paths. An unavailable GitHub read stops the canary.

To resume after investigating a non-successful full run, set the repository variable `SEQUENCE_CANARY_FAILURE_ACK_RUN_ID` to that exact completed run ID. This is an explicit operator acknowledgement, not an automatic retry. The runner and app only read this variable; neither has permission to change it. The acknowledgement applies only while that run remains the most recent completed full run. Review the run's redacted summary and any cleanup failure before acknowledging it. Keep the schedule flag disabled until the investigation is complete if further scheduling is undesirable.

The workflow marks new manual runs as `full` or `preflight-only` in the GitHub run title so the read-only lookup can skip preflights. A legacy manual run without this mode marker is ambiguous and stops the canary. Investigate it, then acknowledge that exact run ID to resume; do not infer its mode from its conclusion.

No runbook action here authorizes contacting existing prospects or changing non-canary records. The canary uses its dedicated fixture and the existing send controls.
