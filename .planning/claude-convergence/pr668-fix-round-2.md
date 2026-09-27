# PR 668 — Fix round 2

Baseline: `95c3fe0cb9278e8a2554986907ba61f41db71468` on `feat/coach-runtime-bundle`.

The client now distinguishes an absent `coach_call_index` row (`pending`) from
an existing row with no usable immutable script binding (`unavailable`) and
from query/auth failures (`error`). Only the first state retries. The session
tries immediately, then after 0.5, 1, 2, 4, and 8 seconds (15.5 seconds total),
and stops on a binding, a definitive outcome, unmount, or `callId` replacement.
It never substitutes another script revision.

While pending, the script column says `Loading script…`; transcript and call
controls continue to render. The synthetic browser harness covers an index
write that appears after the first two lookups.

Evidence:

- Fake-timer unit coverage: late second/third lookup success, definitive null
  no-retry, timeout to unavailable, unmount cancellation, and call-ID reset.
- Mutation check: replacing the retry delays with an empty list caused the
  third-lookup late-write test to fail (state became `ready` after the first
  pending lookup); the retry list was restored.
