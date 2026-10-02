# Permanent TEST fixtures

This repository copy records the permanent shared-TEST fixture required by
Ruling v2 TRP2-7. The ruling names the external `notes/` directory; the
reviewable repo copy therefore lives under `scripts/`.

Fixture: `Inbox RO fixture (permanent, inert)`

- UUIDv5 namespace: `6ba7b810-9dad-11d1-80b4-00c04fd430c8`
- `org`: `39a970c9-e4e2-5883-a2d3-09bc6ccf08a8`
- `user`: `9e556479-7003-5916-9cd6-33f4227cec9b`
- `membership`: `6c742eb2-a60a-532a-9923-be3ad97110f6`
- `m1`: `fe6d35c4-41ad-509e-bd1e-0bc72974e94e`
- `m2`: `b819b477-1f33-579d-bc91-63058afd818a`

The only permitted fixture writes are fixed-ID `INSERT ... ON CONFLICT DO
NOTHING` rows for the organization, membership, and two messages, plus one
admin auth `createUser`. The user is passwordless, unconfirmed, banned for
`876000h`, and stamped with the fixed `app_metadata.inbox_ro_fixture` object.
The email is `inbox-ro-fixture@fixtures.invalid`, falling back only to
`inbox-ro-fixture@fixtures.test` if local GoTrue rejects `.invalid`.

The two rows are queued `mock` outbound SMS with null destination and related
entity fields. m1 is scheduled for `2099-12-31T00:00:00Z`; m2 is unscheduled.
Their metadata is `{ "inbox_ro_fixture": { "permanent": true, "purpose":
"J5a shared-readonly PRE->POST queued-set baseline on TEST" } }`.

Search, whole-DB diffs, and future TEST observations must treat this org and
every row derived from it (including Inbox projection rows after merge) as
expected. This org is carved out of the normal remove-what-you-created rule.
