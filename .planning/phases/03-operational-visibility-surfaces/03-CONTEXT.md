# Phase 03: Operational Visibility Surfaces - Context

**Gathered:** 2026-05-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Three surgical visibility tweaks across three existing surfaces:

1. **Dashboard** — Skip-trace coverage donut counts all properties (prospects + leads combined); verify existing RPC is correct + fix click-through link.
2. **Notification bell** — "New SMS reply" items show a truncated preview of the actual SMS text beneath the property address.
3. **Messages inbox** — Add an "Unread" filter pill alongside the existing filter chips; shows only conversations with at least one unread inbound message, count badge included.

No new pages, no new data models, no new job types. All three are display/query tweaks on existing infrastructure.

</domain>

<decisions>
## Implementation Decisions

### NOTIF-01: Notification preview format
- **D-01:** SMS text preview appears as a **second line in the notification body, below the property address**. The bell already renders `{n.body && <div className="text-muted-foreground ...">...</div>}` — the body string should contain both the address reference and the SMS preview, e.g. `"Reply from 123 Main St\n\"Hey are you still interested?\""` — or equivalent multi-line / combined format.
- **D-02:** Change surface: `FormatPayload` type needs `messageBody?: string | null`; `formatNotification('owner_message_added')` updated to include truncated SMS text; `dispatchOwnerMessageAdded` must accept and pass `messageBody`; the SMS webhook call site must pass the incoming message body.
- **D-03 (Claude's discretion):** Truncation length — use **80 chars** for consistency with the activity-feed preview in `dashboard_summary()` (line 173 in migration 028). If the body is blank or a bare URL, fall back to the existing address-only body.

### DASH-01: Skip-trace coverage widget scope
- **D-04:** The existing `dashboard_summary()` RPC in `supabase/migrations/028_dashboard_summary_job_id.sql` **already counts all non-deleted properties** for both numerator and denominator (no `status` filter). **No new migration is needed.** The planner should verify this is correct (write a test if none exists) but should not rewrite the RPC.
- **D-05 (Claude's discretion):** The skip-trace coverage donut card is currently wrapped in a `<Link href="/leads?skip_traced=false">` — this opens a leads-only view. The link destination should be updated to surface ALL properties without skip-trace data (prospects + leads), not just leads. The exact destination (e.g. `/properties?skip_traced=false` or `/properties` with an appropriate filter) is Claude's call based on what route supports that filter.

### MSG-01: Unread filter pill
- **D-06:** Add `"unread"` to the `InboxFilter` union type in `src/app/(dashboard)/messages/inbox-filters.tsx`. The new chip follows the exact same `FilterChip` pattern, URL param `?filter=unread`, same `setFilter` / `router.replace` logic.
- **D-07:** The "Unread" chip **shows a count badge** — consistent with the Unknown chip. Count = number of threads where `unreadCount > 0`. This count is derived from the `listThreads` response (already computed in JS, no new DB query needed).
- **D-08:** Filter logic: post-load JS filter on `listThreads` results. Add `unreadOnly?: boolean` option to `ListThreadsOpts` in `src/lib/messages/list-threads.ts`; when true, drop threads where `unreadCount === 0` before returning.
- **D-09 (Claude's discretion):** Add `"unread"` to the `THREAD_FILTERS` set in `src/app/(dashboard)/messages/cockpit-view.tsx` so the thread list renders (not the unknown-sender list) when the filter is active.

### Claude's Discretion Summary
- Truncation length: 80 chars (consistent with activity feed)
- DASH-01 link destination: planner decides best `/properties` filter URL
- THREAD_FILTERS set inclusion: add "unread" to render the thread list

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Notification bell + dispatch
- `src/components/notifications-bell.tsx` — bell UI; body is rendered as `{n.body && <div className="text-muted-foreground mt-0.5 text-xs">{n.body}</div>}`. No UI change needed.
- `src/app/(dashboard)/_actions/notifications.ts` — `NotificationRow` type; `body: string | null`
- `src/lib/notifications/format.ts` — `formatNotification` — the function to modify for NOTIF-01
- `src/lib/notifications/types.ts` — `FormatPayload` type — add `messageBody` field here
- `src/lib/notifications/dispatch.ts` — `dispatchOwnerMessageAdded` — the dispatch call site to update
- `src/app/api/webhooks/dialpad/sms/route.ts` — SMS webhook that calls `dispatchOwnerMessageAdded` — must pass `messageBody`

### Messages inbox
- `src/app/(dashboard)/messages/inbox-filters.tsx` — `InboxFilter` type + `FilterChip` component; extend union + add chip
- `src/app/(dashboard)/messages/cockpit-view.tsx` — `THREAD_FILTERS` set; add "unread" here
- `src/lib/messages/list-threads.ts` — `listThreads` + `ListThreadsOpts`; add `unreadOnly` option
- `src/app/(dashboard)/messages/inbox-filters.test.tsx` — existing RTL tests; must stay green + cover "unread"
- `src/lib/messages/list-threads.test.ts` — existing unit tests; must stay green + cover `unreadOnly`

### Dashboard skip-trace coverage
- `src/app/(dashboard)/dashboard/_components/kpi-cards.tsx` — `KpiRowTwo` — the donut card + its Link wrapper (D-05: link needs updating)
- `src/app/(dashboard)/dashboard/queries.ts` — `fetchDashboardSummary` + `DashboardSummary` type
- `supabase/migrations/028_dashboard_summary_job_id.sql` — current `dashboard_summary()` RPC; read the `v_traced_num` / `v_traced_den` queries to confirm no status filter (D-04 assertion)

### CI / migrations
- `.github/workflows/db-migrate.yml` — any migration file must flow through this; no direct `apply_migration` against prod

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `FilterChip` component (inline in `inbox-filters.tsx`) — accepts `badge?: string`; Unknown chip already uses it. Copy pattern for Unread.
- `listThreads` (`src/lib/messages/list-threads.ts`) — already computes `unreadCount` per thread via JS grouping on inbound `read_at === null` messages. No new DB query for D-07.
- Notification bell body rendering — already handles `null` body (renders nothing). Existing rendering handles the new two-line body automatically.

### Established Patterns
- **URL-based filter state:** `useSearchParams` → `new URLSearchParams` → `router.replace`. Used in `inbox-filters.tsx`, `cockpit-view.tsx`. The Unread filter MUST follow this pattern.
- **Result<T> pattern:** all server actions return `Result<T>` from `@/lib/errors/result`. Any new server-side query follows this.
- **Realtime + 15s poll:** the bell uses this hybrid. No change needed for NOTIF-01 (Realtime INSERT fires when a new notification row lands; the new body format is transparent to the listener).

### Integration Points
- NOTIF-01: `src/app/api/webhooks/dialpad/sms/route.ts` → `dispatchOwnerMessageAdded` → `formatNotification`. The webhook already has the inbound message body; it just needs to pass it down.
- MSG-01: `messages/page.tsx` (server component) reads `filter` from searchParams → passes to `listThreads` → passes to `CockpitView` → `InboxFilters`. "Unread" threads into this existing chain.
- DASH-01: `dashboard/page.tsx` → `fetchDashboardSummary()` → `KpiRowTwo`. The RPC result is correct; only the Link wrapper in `KpiRowTwo` needs updating.

</code_context>

<specifics>
## Specific Ideas

- **NOTIF-01 body format:** Jarrad confirmed "preview below the address." Suggested format: `"Reply from [address]\n\"[first 80 chars of SMS body]\""` — the existing address line is preserved, preview appended on a new line. Exact formatting (quotes, separator) is Claude's call.
- **MSG-01 chip consistency:** Jarrad: "all the chips should be consistent" — Unknown chip shows a badge count, so Unread must too.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 03-Operational Visibility Surfaces*
*Context gathered: 2026-05-05*
