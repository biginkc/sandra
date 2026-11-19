# DialPad outcome reconciliation

## Verified defect

On main `1f8efdc8a`, both attempt forms omitted `callActivityId` when the rep selected DialPad. The server selected the insert RPC by source alone. Automatic DialPad attempts already supported the finalize RPC, including native and Sandra-origin ledger keys.

Production read-only checks on October 8, 2026 confirmed the reported pair for property `f1b107af-cab2-4826-a5d0-741d1a666310`:

- Automatic attempt `c43730bd-f1d9-484d-9b6c-0fa611a1df84`, activity `a9484520-f64e-4606-93ec-08f5335bf31b`, outcome NULL, occurred 11:02:39 Central.
- Manual attempt `a444e2d7-03ab-4405-997e-3ae016c883ae`, no activity, reached, occurred 11:10 Central. User-provided creation evidence places saving at 11:11:53.
- Automatic prompt acknowledged 11:18:18 Central. There is no historical browser trace.
- One exact automatic/manual recording-URL pair was found across the production attempt table, scoped by organization, property and caller. This is a narrow evidence audit; it cannot identify duplicates with missing or different URLs.

## Change

Both forms retain explicit call identity for DialPad and expose a call selector. Linked DialPad saves use the existing finalize RPC and matching durable recovery operation. Manual outreach clears the previous call selection.

For unlinked manual DialPad saves, the log RPC reconciles only an exact trimmed recording URL belonging to the same organization, property and caller, with an automatic DialPad ledger key. A unique match finalizes the original attempt. Multiple matches reject the save and require explicit selection. No match keeps the existing separate-call insert behavior. Already-finalized matches are rejected under a new key; the original key replays its receipt.

The SQL preserves the log operation and original request hash for recovery. It acquires the finalizer's advisory lock and matched attempt locks before property/queue locks, matching provider/finalizer order. The migration patches the existing log body with checked anchors and has a rollback twin. It does not replace the finalizer, prompt query, or KPI query, and changes no historical rows.

## KPI impact and historical repair

The current KPI function counts attempt rows. This pair therefore contributes one excess attempt and one excess pending outcome. Reached remains one. Duration-based metrics cannot connect the manually saved reached outcome to the automatic call activity. The manual occurred time can also advance the last-call timestamp. The first-call episode field is not automatically doubled.

Historical correction is separate from prevention. Do not delete either row based only on a shared URL. A reviewed repair should preserve the automatic attempt/activity identity, saved outcome, notes, original receipt/retry behavior, dependent SMS obligations, and audit evidence. The production foreign-key audit found `rep_sms_obligations(attempt_id, org_id)` with `ON DELETE CASCADE`; command results also hold JSON attempt IDs. Inspect all references and make an exact two-row repair with before/after KPI assertions. For the confirmed pair, the read-only dependency check found no attempt notes or SMS obligations; the manual row has one command receipt, and the automatic row has none. No historical repair is included or authorized as a broad data operation.

## Boundaries

Matching deliberately does not use “latest call,” time proximity, or any prior attempt on the lead. If the provider recording evidence has not arrived when the manual save occurs, the fallback cannot identify it yet. The explicit call selector is the reliable path when the activity exists. Late evidence reconciliation and URL normalization beyond trimming are not inferred automatically.

DialPad’s [recording-share-link reference](https://developers.dialpad.com/reference/recording_share_linkget-1) binds a share link to a recording entity and call ID. This supports treating identical stored links as recording evidence; it does not justify normalizing different links into a match.

Provider behavior is unchanged: DialPad evidence remains authoritative; Supabase Postgres RPCs own attempt identity and permissions; Next.js server actions route authenticated commands. The no-answer path can dispatch through Sendillo after the database obligation is created; its adapter and dispatch fences are unchanged, and the SQL replay test verifies one obligation. No DialPad, SMS or customer-facing provider calls were made for verification.

## Verification

- Unit/action tests cover source routing, ambiguous-match feedback and recovery operation selection.
- RTL tests cover both forms preserving linked DialPad identity; existing workflow/recovery suites remain green.
- Eight local SQL tests cover KPI/prompt state, exact retry, second key, changed payload, separate calls, ambiguous URLs, caller/org boundaries, native calls and no-answer obligation replay.
- A disposable database concurrency test makes the provider hold the attempt while logging waits, verifies the provider can then lock the property immediately, and finishes with one attempt.
- Independent combined verification with the pending `20261009060000` queue-transition migration passed 10 tests, including the real `dialpad_cti_project_intent` RPC running concurrently with logging and inverse rollback. Verified `060100` SHA-256: `6b9f33bf4fcb014beaefad6a4f4cf6996af11059c3a44244139ea80e85185ac5`. This is peer-reported integration evidence, separate from the eight tests run in this worktree.
- Broad repository verification is tracked in the PR/release handoff.
