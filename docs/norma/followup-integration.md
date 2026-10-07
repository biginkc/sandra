# Inbound and recording-state integration

Depends on: #793 (schema dependency #792).

Prepared locally on reviewed runtime `09de75fdf6cb71808a681a40fd1c432d4a5ee40d`, schema parent `6b3e5d2fec667e88d5c35c3488faf48f82a8d66e`. Apply only the deltas of inbound `31c05eed60eb8bb967210520202b5b9fedb9f974` and recording-state `9997eab420d4167d69915649bdb0273ffbf7b820` relative to their reviewed #825 base `f2524ed87972ca743ae9acdc50d3b817cffa5e2e`; #825 itself is already in the canonical runtime.

Both additive type sets and both integration inclusion/exclusion entries are retained. The only application merge conflict was adjacent generated RPC type additions; both were preserved. Canonical dispatch, presend fence, Mark reviewed timeline, outbound webhook, recording flag and `08090100` migration are unchanged.

Local preparation slots are `20261008140000` (inbound) and `20261008140100` (recording state). Revalidate the hosted high-water and current canonical head before publication; slots are not guaranteed release order. No shared migration, publication, provider call, configuration or activation was admitted for local integration. Neither follow-up is a prerequisite to releasing canonical #793 absent a concrete regression.

Database tests replay the complete canonical → inbound → outbound chain inside a rollback transaction, on a verified loopback disposable database. A shared fixture resets only the new follow-up objects inside that transaction so tests work both on pre-follow-up and fully migrated CI schemas. The recording test uses actual retry claim/completion/bind RPCs; a cross-column call-ID conflict test verifies later identities still seed. Run database suites serially when they use the same database. Each new workflow provisions its own disposable stack.

Both new reconciliation paths default off and are not scheduled. Recording-state operator recovery and activation limitations are documented in `recording-state-follow-up.md`. No provider access was attempted, including the known denied credential path. Existing user-reported capture does not substitute for authenticated live playback or inbound/retry acceptance evidence.


Inbound reconciliation now uses its own singleton lease and a committed `awaiting_result` barrier before each provider GET. A second batch cannot overlap. Every request rechecks the lease, denial state and destination flags. A 401/403 disables all destination lookup flags and stamps the global control, even for a stale worker; cancellation failure cannot skip this write. Failed result/denial persistence retains the barrier across lease expiry. After a genuinely changed provider-access condition, the admitted operator must reconcile the uncertain result, clear `denied_at`/`awaiting_result`/lease fields, and re-enable only intended destination flags. No automatic recovery bypass exists. Later signed webhook evidence remains authoritative while a matching lookup checkpoint clears its barrier. Claimed but unprocessed rows still consume bounded attempts/backoff. The new control is service-only; no browser or authenticated role can read or change it.
