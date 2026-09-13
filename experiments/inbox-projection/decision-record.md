# T2 database decision record

Status: experiments in progress; no production migration approved or installed.

The approved architecture still uses Electric, TanStack DB/Query/Virtual,
PostgreSQL and Restate. The question here is how PostgreSQL records the arrival
boundary that prevents an earlier conversation open from acknowledging a later
message. This is not a proposal to return to the old Inbox architecture.

## What is established

- The new stack works together in the isolated T1 lab. PR #551 merged after all
  CI checks passed; the live application does not import that lab.
- A separate offline fixture replays 237 repository migrations and 13 pinned
  vendor prerequisites, with canonical function hashes compared to the existing
  local reference. This is not deployed-production catalog equivalence.
- The revision-column candidate passed 20 recorded checks, including actual
  contention, rollback, canonical identity stamping, privileges and precision.
- A narrow sidecar alternative passed 12 corrected checks, including a negative
  control for missing-row NULL results. Its installation and test changes rolled
  back, leaving the original candidate enabled. Earlier measurements remain
  retained separately from the corrected correctness receipt.
- Six SQL read-boundary checks passed against canonical guards. They establish
  later-arrival exclusion and bounded mutation batches, not the authenticated
  API, browser acknowledgment or durable operation receipts.

## Decision still open

The sidecar comparison uses identical inputs within its own alternating trials.
It showed less write work and more read work. Do not compare its elapsed times
directly with the earlier head-proof samples: the payloads and experiment setup
differ. The retained plans and WAL samples are useful evidence, but neither a
100-row test nor a lower median establishes production suitability.

Keep the revision-column approach as the approved design baseline while testing
the API and projection contracts. Keep the sidecar as a measured alternative.
Changing the storage design requires an explicit design amendment, equivalent
correctness coverage, workload-informed read/write comparisons and review.

One specific read-design question remains for the sidecar: absence represents
the revision-zero baseline. A boundary query must include those baseline rows as
well as qualifying mapped arrivals. The demonstrated left join handles the
semantics, but its plan is inefficient. A future comparison must cover large
baseline histories and many arrivals newer than a boundary, not merely optimize
the latest-50 join. The revision-column candidate can express that boundary as
one indexed revision range; neither experiment yet establishes the corresponding
production query budget.

## Required corrections before production

1. Both candidates retain the demonstrated source-row/head lock inversion.
   Existing writers do not currently establish whole-transaction deadlock retry.
   Preserve database error codes and retry only the actual aborted transaction;
   do not replay a whole webhook containing unrelated side effects.
2. Existing identity-resolution compensation uses separate HTTP transactions.
   Some compensation errors are ignored. Treat these as repairable partial
   outcomes, not an atomic rollback of earlier committed work.
3. The revision-column allocator's AFTER self-update is absent from outer
   INSERT/UPDATE RETURNING. New APIs must read final state in their specified
   snapshot. Projection capture must recompute affected keys instead of letting
   stale outer NEW overwrite newer nested state.
4. A private-head SECURITY DEFINER endpoint must explicitly enforce requester,
   tenant and active Hugo access. Calling an existing resolver under its owner
   role is not proof of end-user authorization.
5. Head/history consistency alone does not implement post-render acknowledgment,
   bounded updates, immutable recovery receipts or current DNC guards. The
   read API contract remains proposed until its implementation is tested.
6. Production catalog, external writer and workload access remains outstanding.
   Validate ingestion latency, head-lock contention, query plans, retained WAL,
   repair backlog and realistic arrival rates before choosing rollout budgets.

Counter installation, private sidecar tests and fixture bootstrap are outside
`supabase/migrations`. They must not be promoted merely because isolated checks
pass. Outbox and provider sending remain outside these experiments.
