# Canonical bulk reply recipient capture

This private, disabled candidate resolves current canonical Inbox recipients before a reviewed reply can be frozen. It depends on the reviewed reply context boundary (PR #587) and metadata authority/policy APIs (PR #586). It does not expose an authenticated RPC, accept a send, create a job, or call a provider.

`recipient.sql` locks canonical property/contact identity, captures inbound generation and purpose-specific content/policy versions, checks the saved normalized phone, opt-outs, suppression and active sender inventory, then captures sender/company/market context. Read receipts do not invalidate reply content. Arbitrary absent or foreign conversation IDs do not allocate persistent heads. Completion-time conversation expiry excludes a recipient even when versions have not changed.

`batch.sql` takes at most 500 explicit, unique conversation IDs in deterministic order. It retains exclusions for review, flags every conversation sharing a destination, and reports whether the distinct eligible recipient count exceeds 50. This is a review signal, not an acceptance implementation. It never silently picks one duplicate conversation. The private quiet-hours helper preserves the application's exact state/timezone map and 08:00–21:00 local window; the batch uses the database clock, with no environment override. Earlier recipients are checked again for time-only expiry after the loop.

Run the actual rollback-only proof against the marked owned fixture:

```sh
python3 experiments/inbox-reply-preparation/recipient-test.py --run-owned-fixture
```

Fourteen groups cover canonical route/personalization, read-only versus content changes, foreign/missing identities, saved phone/landline, inventory, consent, private grants, duplicate destinations, malformed target sets, winter/summer/territory quiet hours, and 51 recipients becoming 50 only after a canonical exclusion. Source hashes and limitations are in `recipient-evidence.json`. The runner removes the new schemas and all test data in the same rollback.

A separate real-connection proof in `recipient-concurrency.py` observes the reader waiting on a sender-context lock, crosses natural 90-day expiry while it waits, and verifies exclusion at completion. Temporary schemas/triggers are removed; uniquely marked synthetic source rows remain in the owned fixture.

Remaining gates: additional concurrent mapping/version and multi-recipient expiry waits; authenticated immutable personalized preview; cap enforcement and duplicate resolution at acceptance; current actor/dependency/time rechecks at dispatch; committed dispatch marker and account admission; receipt persistence and verified callback reconciliation. The caller must retry only an entirely aborted database transaction, never a potentially accepted provider request. Deterministic conversation order does not prove that legacy multi-row source writers cannot deadlock. No production schema or feature flag is changed by these files.
