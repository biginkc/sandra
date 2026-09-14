# Unknown sender history candidate

Preserves the existing unknown dialog's raw `from_address` SMS history, including
matched and dismissed messages. The sender group must still have an unmatched
inbound SMS in the authenticated organization. It does not join outbound
`to_address` replies into a newly invented conversation, normalize raw senders,
or acknowledge messages as read.

The index narrows by organization and sender hash, then the query checks exact
C-collated raw text equality. Hash equality is never an identity decision.
Pages contain at most 50 messages and use raw timestamp plus UUID ordering.
Opaque cursors bind organization, sender group, requester, session and access
epoch, and retain the initial five-minute expiry. They describe live keyset
history, not an immutable snapshot. An exact 50-row terminal page can require one
empty final request.

The client retains its cached newest page and one older page, replaces older
pages instead of accumulating them, aborts navigation requests and hides history
on access denial. Selection and read acknowledgments are independent.

Production installation must use the normal reviewed migration path, create the
message index concurrently, revoke private schema/function grants, gate the public
RPC, and provide cursor expiry cleanup and admission. This source does not enable
production. The SQL runner is restricted to the marked original T2 fixture;
the full-Auth installed browser database is a separate test.
