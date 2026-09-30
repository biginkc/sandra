# InboxReplySend recovery

This runbook is for the private Restate `InboxReplySend` service. Recovery is
resume-only. Do not kill, cancel, purge, restart-as-new, restart-from-prefix,
or resume with a deployment override. A paused invocation is pinned to the
deployment that recorded its journal; keep that deployment available until the
inventory is empty.

## Inventory

From inside the private Restate network, run this read-only query before a
pilot session and before any worker-generation change:

```sql
SELECT
  id AS invocation_id,
  pinned_deployment_id,
  modified_at AS last_transition_at
FROM sys_invocation_status
WHERE target_service_name = 'InboxReplySend'
  AND status = 'paused'
ORDER BY modified_at, id;
```

The column names are the Restate 1.7.5 `sys_invocation_status` schema. The
paused-invocation inventory is authoritative; the worker's
`inbox_reply_send_stalled` line is only best-effort backlog detection.

## Resume procedure

For each inventory row, inspect the reply ledger attempt and classify the
cause using the retry ruling. Fix a transient cause, then resume the exact
invocation without a deployment flag. Do not resume a permanent requester-
authorization or integrity cause; record it and apply the pilot decision.
Re-run the inventory until the attempt is terminal or `uncertain` and its
outbox row is acknowledged.

```sh
restate invocations resume <invocation-id>
```

Never use `--deployment` for `InboxReplySend`. The new step shape and explicit
retry policy require a new registered deployment; old deployments remain until
no invocation is pinned to them.
