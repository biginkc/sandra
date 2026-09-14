# Render-bound history

`ConversationHistory` mounts inside the opened detail pane. The owner supplies
its current navigation generation and the generation associated with the fetched
snapshot. Organization, conversation and generation must all match before history
is rendered or acknowledged. A cached/prefetched result alone does not mount this
component. An A→B→A navigation uses a new generation.

After the matching pane commits and reaches a visible animation frame, the
component submits its recorded boundary and batch zero. It advances only from a
matching committed receipt, retains the same batch on a lost response, and cancels
local work on replacement/unmount. PostgreSQL retains receipts when an HTTP
response is lost; cancellation cannot undo an already committed batch. An expired
cached boundary requires refreshed content to render before a new acknowledgment.

Live access denial hides history and calls the owner's `onAccessLost`, which must
cancel and clear the whole workspace Query cache, summary collections and
selection. Fetching, cache lifetime, cursor paging and older-history windows belong
to the owning TanStack Query controller. This component never owns summary rows.

Eleven RTL cases cover commit/frame ordering, hidden/prefetched/stale generations,
navigation cancellation, tab visibility, multiple batches, lost-response retry,
expired content, Strict Mode, late responses after unmount, and a latched live access loss that cannot be revived by an ordinary rerender. These tests use a controlled animation frame
and HTTP responses; they are not a substitute for full-browser integration or a
claim that a person read the messages. The component is not yet mounted by an
enabled production page.
