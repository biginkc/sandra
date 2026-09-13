# Bounded canonical history paging

Private fixture candidate, dependent on the reviewed post-render read adapter.
The disabled application route now calls `inbox_history_page` for both first and
older pages. Recorded opaque cursors bind the original boundary, canonical user,
session, access epoch, org and conversation. Raw PostgreSQL `(created_at,id)`
positions preserve microseconds and ties. Each page reauthorizes and returns at
most 50 messages; fetching history never marks a message read.

Older pages retain the original read boundary even if late backdated arrivals
appear in live history. This is live keyset traversal, not an immutable transcript.
The browser retains the newest cached page and one older page (at most100 messages
including the parent cache), replaces that older page when advancing, and offers
Back to latest messages. Navigation aborts in-flight paging. Either read or paging
access loss aborts the other request and latches the history hidden.

`test.py --run-owned-fixture` explicitly validates the canonical synthetic fixture,
installs only this owned candidate if absent, and verifies exact installed function
bodies. Six actual SQL groups cover153 messages, four pages, tied microseconds,
cursor replay/binding/privileges/expiry, and late arrivals excluded from the original
read acknowledgment. `verify.py` only checks source/runner receipt hashes and syntax.

A full50-message terminal page can produce one final empty request. Cursors expire
with the initial five-minute boundary. Refresh obtains a new snapshot. Cursor and
boundary retention, admission controls, full HTTP/JWT transport, and production
migration/rollout still need integration; this receipt does not prove them.
