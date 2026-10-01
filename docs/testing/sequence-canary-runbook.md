# Sequences production canary operator runbook

The full canary keeps the GitHub repository variable `SEQUENCE_CANARY_SCHEDULE_ENABLED` as a **coarse job-level skip gate**. A false or missing variable makes the entire scheduled job skip before it starts; the failure latch exempts that run only when GitHub reports a skipped scheduled run with its single full job never started. Keep this variable `false` while scheduling is off. When activation is authorized, it must be `true` **and** the database control must be `true`. The database is authoritative after the job starts. The runner checks it twice, including after dependency installation; the app reads it again immediately before the provider call. Any mismatch or unavailable read stops the run. GitHub variable evaluation timing is undocumented, so it is never used as the fresh authorization check.

The three authoritative controls live in `public.sequence_canary_controls`, created by `20260930038000_sequence_canary_controls.sql`. They are absent by default and a missing row stops the canary. The production migration must be applied through Sandra's established migration workflow before this code is deployed. Confirm the migration is recorded there and the table is readable with the existing production service-role credential. This runbook does not authorize applying a production migration or enabling a send.

Only the service role may read the table or call `public.set_sequence_canary_control(key, value, actor)`. It stamps `changed_by` and `changed_at` on every write. An operator with the existing authorized SQL admin path can set controls as follows, replacing the actor with their own identity and reviewing the result. Do not put service-role credentials in a shell history or a PR.

```sql
select public.set_sequence_canary_control('SEQUENCE_CANARY_SCHEDULE_ENABLED', 'false', 'operator@example.com');
select public.set_sequence_canary_control('SEQUENCE_CANARY_MANUAL_RUN_ID', '', 'operator@example.com');
select public.set_sequence_canary_control('SEQUENCE_CANARY_FAILURE_ACK_RUN_ID', '', 'operator@example.com');
select key, value, changed_by, changed_at from public.sequence_canary_controls order by key;
```

For a single authorized manual full attempt, set `SEQUENCE_CANARY_MANUAL_RUN_ID` to that workflow run's decimal ID. Clear it when the attempt is over. Before enabling a schedule, set the DB schedule control to `true`, then set the coarse GitHub repository variable to `true` only after all other activation gates pass. To stop scheduling, set the coarse variable to `false` and the DB control to `false`. A queued or already running job still reads the DB before enrollment and the app reads it at dispatch.

Before enrollment, the runner reads full runs of `canary-sequences.yml` other than itself. Immediately before provider dispatch, the deployed app repeats that read. Any unresolved full run stops both paths. Every non-successful full run since the most recent clean success needs an acknowledgement, including a failed earlier attempt of a completed rerun. A scheduled run skipped because its full job never started is ignored; the latch checks that job through GitHub's attempt-specific jobs API. A failed, cancelled, timed out, or ambiguous full run still stops both paths, as does any full job that started but did not succeed. An unavailable GitHub or database read stops the canary.

`CANARY_GITHUB_READ_TOKEN` is used **only by the deployed Vercel app**. It must be a fine-grained PAT scoped to **this repository only**, with **Actions: read** only. The runner uses its built-in `github.token`, granted `actions: read`, for runs, attempts, and jobs. The app needs no `Variables: read` permission. No new access or credential is required for the runner.

After investigating every non-successful full run or attempt since the most recent clean success, collect IDs with `gh run list --workflow canary-sequences.yml`. Review each run's redacted summary and any cleanup failure. Set the database acknowledgement control to a comma-separated list of **all** those IDs, such as `10,11`:

```sql
select public.set_sequence_canary_control('SEQUENCE_CANARY_FAILURE_ACK_RUN_ID', '10,11', 'operator@example.com');
```

An acknowledgement is an explicit operator reconciliation, never an automatic retry; it cannot permit an unresolved rerun. Keep both schedule flags disabled while investigating. A wrong-block caused by a skipped or cancelled run needs acknowledgement until live samples confirm the run conclusion and job `started_at` values.

The workflow marks new manual runs as `full` or `preflight-only` in the GitHub run title so the read-only lookup can skip preflights. A legacy manual run without this marker is ambiguous and stops the canary. Investigate it, then acknowledge its exact run ID.

## Rollback

First set the coarse GitHub schedule variable to `false` and the DB schedule control to `false`; clear the manual run ID. Before deploying the previous code, restore its GitHub acknowledgement/manual variables and its required app PAT permission (`Variables: read`) through the existing operator path. Deploy the previous reviewed code only after those controls are in place. The table can remain inert during rollback. If removing the schema is required, do so only after the previous code is serving and no canary job depends on it:

```sql
drop function if exists public.set_sequence_canary_control(text, text, text);
drop table if exists public.sequence_canary_controls;
```

No runbook action here authorizes contacting existing prospects or changing non-canary records. The canary uses its dedicated fixture and the existing send controls.
