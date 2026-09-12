# My Leads launch runbook

This runbook describes the admitted operation for the P13 launch initializer. It does not authorize a production launch. Keep `acquisition_org_settings.my_leads_enabled` false until the owner, reviewer, and release gate have accepted the preview and apply receipt.

## 1. Dry-run and review

Use the planner with the verified organization and Acquisitions member IDs:

```sh
node --import tsx scripts/my-leads-launch.ts \
  --preview --org-id <org-id> --member-id <member-id>
```

The default mode makes no database call. With `--execute --admit`, the preview RPC is read-only and returns the cohort UUID, settings revision, exact candidate rows, exclusion counts, cutoff, and fingerprint. Save that output as the review receipt. Re-preview if assignment, designation, access, settings, DNC, or queue state changes.

## 2. Admitted initialization

After the exact preview has been reviewed, pass its cohort ID, fingerprint, and settings revision to the planner:

```sh
node --import tsx scripts/my-leads-launch.ts \
  --apply --org-id <org-id> --member-id <member-id> \
  --cohort-id <cohort-id> --fingerprint <fingerprint> \
  --settings-revision <revision> --idempotency-key <new-uuid> \
  --execute --admit
```

The apply command is owner-authorized, locks and rechecks the settings, member, and sorted property set, records prior episode/queue values, creates disabled launch episodes, and leaves the rollout gate disabled. A stale fingerprint, revision, assignment, or designation aborts the transaction. Reusing the same idempotency key returns the stored receipt; a different request with that key is rejected.

## 3. Enablement and rollback

Enablement is a separate admitted operation owned by the release coordinator. It must not be folded into the apply command. If the gate is enabled, rollback is intentionally rejected. Disable the gate first, then run:

```sh
node --import tsx scripts/my-leads-launch.ts \
  --rollback --org-id <org-id> --cohort-id <cohort-id> \
  --idempotency-key <new-uuid> --execute --admit
```

Rollback restores captured episode and queue state only while the launch episode is untouched. Any assignment/status/DNC/deletion or queue change, actual attempt/offer, first-call evidence, or other launch activity stops rollback with `ROLLBACK_BLOCKED`; it never deletes activity or fabricates a call outcome.

## Verification receipt

Run the focused wrapper tests and the private PostgreSQL migration rehearsal before requesting admission:

```sh
npx vitest run src/lib/my-leads/launch.test.ts
node --import tsx scripts/my-leads-launch.ts --help
node scripts/verify-my-leads-launch.mjs
```

The rehearsal must use its own temporary PostgreSQL instance and fixture. It must not use shared or production credentials. Record the exact migration head, dirty paths, preview fingerprint, apply/replay result, and any blocked stale/rollback cases in the release review.
