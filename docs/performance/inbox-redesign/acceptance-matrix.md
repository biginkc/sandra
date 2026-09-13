# Inbox acceptance matrix

Baseline e5fce2d; implementation worktree 269d44ca. This matrix records requirements, not passing tests. See approved development plan for exact new behavior and feature gates.

| ID | Existing capability | Treatment | Evidence |
|---|---|---|---|
| F01 | Inbox / Outbox tabs | Preserve; verify on new Inbox | Not run |
| F02 | Search messages | Preserve; verify on new Inbox | Not run |
| F03 | Inbox filters | Preserve; verify on new Inbox | Not run |
| F04 | Needs Outcome | Preserve; verify on new Inbox | Not run |
| F05 | Hide DNC & tests | Preserve; verify on new Inbox | Not run |
| F06 | Pagination and ordering | Preserve; verify on new Inbox | Not run |
| F07 | Open and close a conversation | Preserve; verify on new Inbox | Not run |
| F08 | Read message history | Preserve; verify on new Inbox | Not run |
| F09 | Automatic mark-read | Preserve; verify on new Inbox | Not run |
| F10 | Conversation identity/context | Preserve; verify on new Inbox | Not run |
| F11 | AI status indicators | Preserve; verify on new Inbox | Not run |
| F12 | Open record / copy links | Preserve; verify on new Inbox | Not run |
| F13 | Call | Preserve; verify on new Inbox | Not run |
| F14 | New Message | Preserve; verify on new Inbox | Not run |
| A01 | Wrong number | Preserve; verify on new Inbox | Not run |
| A02 | Bad / disconnected # | Preserve; verify on new Inbox | Not run |
| A03 | Not interested | Preserve; verify on new Inbox | Not run |
| A04 | Follow up | Preserve; verify on new Inbox | Not run |
| A05 | Needs sequence | Preserve; verify on new Inbox | Not run |
| A06 | SMS opt-out | Preserve; verify on new Inbox | Not run |
| A07 | Permanent DNC unavailable here | Existing disabled permanent DNC; new command gated | Not run |
| A08 | Move to Lead | Preserve; verify on new Inbox | Not run |
| A09 | Book appt | Preserve individual workflow | Not run |
| A10 | Assign to me / teammate | Preserve; verify on new Inbox | Not run |
| A11 | Unassign | Preserve; verify on new Inbox | Not run |
| A12 | Confirm Sandra disposition | Preserve individual workflow | Not run |
| A13 | Correct an AI disposition | Preserve individual workflow | Not run |
| R01 | Write/edit a reply | Preserve; verify on new Inbox | Not run |
| R02 | Insert a template | Preserve; verify on new Inbox | Not run |
| R03 | Send SMS / Cmd-Ctrl-Enter | Preserve; verify on new Inbox | Not run |
| R04 | Use the conversation's reply route | Preserve; verify on new Inbox | Not run |
| R05 | Restriction and route-change handling | Preserve; verify on new Inbox | Not run |
| U01 | View unknown sender thread | Preserve individual workflow | Not run |
| U02 | Merge with existing contact | Preserve individual workflow | Not run |
| U03 | Merge with existing property | Preserve individual workflow | Not run |
| U04 | Create new lead | Preserve individual workflow | Not run |
| U05 | Dismiss unknown sender | Preserve; add explicit snapshot-scoped bulk operation | Not run |
| U06 | Restore dismissed sender | Preserve; add explicit snapshot-scoped bulk operation | Not run |
| U07 | Resolve known contact to an existing property | Preserve individual workflow | Not run |
| U08 | Create property and resolve | Preserve individual workflow | Not run |
| O01 | Inspect queued message cards | Unchanged Outbox regression boundary | Not run |
| O02 | Send next | Unchanged Outbox regression boundary | Not run |
| O03 | Send one queued message | Unchanged Outbox regression boundary | Not run |
| O04 | Start / pause auto-send | Unchanged Outbox regression boundary | Not run |
| O05 | Set cadence | Unchanged Outbox regression boundary | Not run |
| O06 | Edit queued text / save / cancel | Unchanged Outbox regression boundary | Not run |
| O07 | Delete queued message | Unchanged Outbox regression boundary | Not run |
| O08 | Load more queue rows | Unchanged Outbox regression boundary | Not run |
| O09 | Queue totals and timing | Unchanged Outbox regression boundary | Not run |
| O10 | Recover failed queue reads | Unchanged Outbox regression boundary | Not run |
