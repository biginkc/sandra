# Canonical bulk reply recipient capture

This private, disabled candidate resolves current canonical Inbox recipients before a reviewed reply can be frozen. It depends on the reviewed reply context boundary (PR #587) and metadata authority/policy APIs (PR #586). It does not expose an authenticated RPC, accept a send, create a job, or call a provider.

`recipient.sql` locks canonical property/contact identity, captures inbound generation and purpose-specific content/policy versions, checks the saved normalized phone, opt-outs, suppression and active sender inventory, then captures sender/company/market context. Read receipts do not invalidate reply content. Arbitrary absent or foreign conversation IDs do not allocate persistent heads. Completion-time conversation expiry excludes a recipient even when versions have not changed.

Eligibility fails closed on two axes, both deliberately **stricter** than the
existing single-send/bulk-queue paths (`src/lib/messaging/send.ts`,
`suppression.ts`'s `evaluateAutomatedSuppression` used by `bulk-queue.ts`),
because bulk-reply has no per-message human review at send time:
- **Line type** — only an affirmatively saved `'mobile'` slot is eligible.
  `landline` excludes with `landline`; anything else (`'unknown'`, i.e. never
  classified) excludes with `unclassified_phone`. The existing paths let
  `'unknown'` through by default (bulk-queue only gates it behind an operator
  opt-in toggle this feature doesn't have yet).
- **Consent** — an affirmative opt-in event
  (`opt_in_marketing_written`/`opt_in_confirmed`/`opt_in_informational`) must
  be on file; its absence excludes with `no_consent`. The existing paths only
  hard-block explicit `opt_out`/`provider_auto_opt_out` and let a contact with
  zero consent history through.

`inbox_reply_preparation.recipient_limit()` is the single source of truth for
the D5 bulk-reply cap (50); `batch.sql` and `inbox_reply_review.view()`
(`experiments/inbox-reply-review/setup.sql`) both call it instead of
repeating the literal, and `src/lib/inbox/reply-api-contract.ts`'s
`INBOX_REPLY_RECIPIENT_LIMIT` constant is checked against it by
`reply-api-contract.test.ts`.

`batch.sql` takes at most 500 explicit, unique conversation IDs in deterministic order. It retains exclusions for review, flags every conversation sharing a destination, and reports whether the distinct eligible recipient count exceeds the cap. This is a review signal, not an acceptance implementation. It never silently picks one duplicate conversation. The private quiet-hours helper preserves the application's exact state/timezone map and 08:00–21:00 local window; the batch uses the database clock, with no environment override. Earlier recipients are checked again for time-only expiry after the loop.

Run the actual rollback-only proof against the marked owned fixture:

```sh
python3 experiments/inbox-reply-preparation/recipient-test.py --run-owned-fixture
```

Sixteen groups cover canonical route/personalization, read-only versus content changes, foreign/missing identities, saved phone/landline/unclassified-phone, inventory, consent opt-out AND no-consent, private grants, duplicate destinations, malformed target sets, winter/summer/territory quiet hours, and 51 recipients becoming 50 only after a canonical exclusion. The two fail-closed line-type/consent cases were mutation-checked by hand (temporarily removing each guard and confirming `recipient()` returns `exclusion: null` instead of the expected code) before being committed as permanent assertions here. Source hashes and limitations are in `recipient-evidence.json`. The runner removes the new schemas and all test data in the same rollback.

A separate real-connection proof in `recipient-concurrency.py` observes the reader waiting on a sender-context lock, crosses natural 90-day expiry while it waits, and verifies exclusion at completion. Temporary schemas/triggers are removed; uniquely marked synthetic source rows remain in the owned fixture. **Not re-run as part of this pass** — `recipient-concurrency-evidence.json`'s recorded source hash is now stale against the fail-closed `recipient.sql` changes above; `verify.py` will fail on that check until this proof is re-run against the clean isolated fixture (Lane-2 fixture rebuild), same as the `inbox-reply-review` concurrency proof.

Remaining gates: additional concurrent mapping/version and multi-recipient expiry waits; authenticated immutable personalized preview; cap enforcement and duplicate resolution at acceptance; current actor/dependency/time rechecks at dispatch; committed dispatch marker and account admission; receipt persistence and verified callback reconciliation. The caller must retry only an entirely aborted database transaction, never a potentially accepted provider request. Deterministic conversation order does not prove that legacy multi-row source writers cannot deadlock. No production schema or feature flag is changed by these files.
