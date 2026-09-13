# Candidate1 network-read cost investigation

The direct source baseline measures fetchInboxDetail with an already authenticated
client. A browser request includes more work. Source inspection found middleware
Auth getUser and membership reads; endpoint getUser and membership resolution;
a conversation-org guard; bounded history and latest-inbound reads in parallel
with the old context reader; the context reader repeats org resolution then reads
100 messages/review, contact/property, consent and phone suppression. Roughly12
DB requests and two Auth user requests are scheduled in this uncomplicated fixture,
with some parallelism; a pending review can add an older-message query. This is
source counting, not a trace attributing milliseconds to each call.

Source: middleware.ts/lib/supabase/middleware.ts; api/inbox-v2/detail/route.ts;
lib/auth/memberships.ts; lib/inbox-v2/read-detail.ts; Messages inbox-detail-data.ts.
Installed Supabase auth-js getUser calls the Auth user endpoint. Reusing an already
validated request context could reduce duplicate work, but removing permission
checks is not an acceptable performance fix. Changes need parity and auth tests.

## Browser timing refinement

A separate six-click probe recorded the real browser click event through correct
history DOM and two animation frames, alongside the previous Playwright action
start measurement. It excludes automation time before the actual click event.
First opens were147/130ms; memory revisits32/30ms; post-expiry network revisits
229/115ms. Endpoint resource durations were134/112/218/99ms. These are individual
observations, not population quantiles. One expired revisit still exceeded200ms.

The distinction shows why subtracting65ms cached-action timing from a network
number would misattribute work. Earlier conservative action-start measurements
remain retained; no passing result replaces a failed case. See
browser-candidate1-event-timing.json. Route logs begin after middleware and cannot
alone explain its authentication time. A future controlled trace should correlate
middleware, route auth, context/history branches and browser paint, under the full
Inbox rendering/mark-read workload and realistic concurrency/arrivals.
