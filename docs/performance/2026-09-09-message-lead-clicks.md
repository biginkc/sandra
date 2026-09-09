# Message and lead click latency — September 9, 2026

Production was inspected read-only through Supabase. No schema/index changes were applied.

## Evidence

- Production `pg_stat_statements`: inbox page RPC with search argument averaged 3,841.5 ms over 1,265 calls; max 14,880.5 ms. These are accumulated statistics, not current browser click timings.
- A fresh authenticated, read-only execution of the default inbox page RPC took 2,783.1 ms, hit 797,900 shared buffer blocks, and wrote 13,946 temporary blocks. The query reconstructs and classifies the conversation collection before paging.
- Existing indexes include the SMS inbox `(org_id, conversation_id, created_at desc, id desc)` index, message property/date indexes, property status and unlocked-lead indexes, and the open-task property/due-date index.
- Leads urgency counts averaged 2,917.4 ms historically, but the current default RPC took 25.4 ms in a fresh authenticated probe. Its simplified core used the existing property-status and task indexes and took 8.1 ms. Historical averages alone would have led to the wrong indexing recommendation.
- The application reran the entire Messages page on conversation selection, including the inbox RPC, Outbox rows and queue totals.
- Lead detail awaited Street View metadata before returning the page. That external request has a four-second timeout. Several independent page reads also ran in sequence.

## Changes

- Selected conversation clicks request only `/api/messages/thread-detail`, using the viewer's session and the existing tenant-isolated detail loader. URLs remain shareable; direct URLs and authoritative refreshes still use server rendering.
- Selection requests abort on newer clicks/unmount. Generation checks also reject late responses from transports that ignore abort. Errors clear stale detail and expose retry/back controls.
- The existing DNC-aware mark-read action runs after the selected conversation is available. It is no longer a prerequisite for showing the text.
- Inbox no longer retrieves Outbox rows. Queue statistics retain their current authoritative source and polling.
- Consent and phone suppression reads run together; neither safety check is bypassed.
- Leads stages, urgency counts and baseline counts start together; card decorations start as soon as stage IDs are available.
- Lead detail loads eSign, previous/next navigation and current user together. A keyed Suspense boundary lets the lead render while Street View resolves.

## Remaining architectural cost

Initial Inbox entry, filter changes and background full refreshes still reconstruct the inbox snapshot. A maintained per-conversation summary with separately refreshed aggregate counts is a potential next database optimization. It requires careful treatment of consent, suppressions, assignment, AI review changes and tenant access; adding an index alone does not eliminate the reconstruction work.

Browser before/after results and final verification are recorded in the PR. Do not interpret database query timing as measured end-to-end latency.
