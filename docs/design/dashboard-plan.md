# Dashboard — Implementation Plan

## Context

Sandra CRM has shipped Features 1–9 (lead pipeline, sequences, AI responder, skip-trace) but has no landing page. After login the user lands on `/leads` directly. The sidebar's first entry is currently Leads.

A landing dashboard at `/dashboard` is the morning-triage view: walk in, see what needs you today, and either act on it or get an at-a-glance read on coverage health. The mental model is REISift's dashboard — 3-area page (sidebar / main / right rail), wide hero strip, KPI rows, persistent right-rail worklist — but the *content* is wholesale-RE operator concerns, not REISift's rental-data-quality concerns.

**Goal:** ship V1 in time for the next operator session so Jarrad and the VA both have a single page that surfaces the day's work without a tour of every route.

## Decisions (locked)

### Layout

- **3-area page**: existing left sidebar (~280px) + main content (flex) + right rail (340px fixed).
- **Main rhythm** (top → bottom): Skip-Trace Credits hero strip → Needs Attention strip → KPI row 1 (3 stat cards) → KPI row 2 (2 donuts) → Quick actions row.
- **Right rail** (top → bottom): Replies awaiting approval panel → Recent activity feed.

### KPIs

Five tiles total, split 3 + 2:

1. **Total leads** — stat card, all-time count + "+N this week" delta chip.
2. **Assigned** — split stat card, two rows: "Assigned to me: N" / "Assigned to [VA name]: M".
3. **Not in a drip campaign** — stat card, click-through to filtered list for bulk enroll.
4. **Hot leads donut** — `interested` + `offer_sent` over total non-terminal leads.
5. **Skip-trace coverage donut** — properties with any cache row over total non-terminal leads.

### Definitions

- **Hot leads**: properties with `status` in (`interested`, `offer_sent`). `under_contract` is "won pending close" and not hot. `offer_declined` is on hold.
- **"Not in a drip campaign"**: properties with no row in `sequence_enrollments` where `status='active'` for that property *right now*. Paused, completed, or opted-out enrollments don't count as in-drip.
- **"Skip-traced"**: any row exists in `skip_trace_cache` for the property's `address_normalized` — irrespective of `match_count`. We count the request, not the result.
- **Total non-terminal leads** (donut denominators): properties with status not in (`closed`, `dead`, `prospect`).

### Needs Attention strip — 5 alert rows

Single horizontal strip directly under the page header. Each row hides when count = 0. When all 5 are 0, the strip collapses to a single green "All clear ✓" line.

| # | Severity | Metric | Threshold | Click-through |
|---|---|---|---|---|
| 1 | Red `#dc2626` | Escalated, unhandled | escalation_reason set, no human outbound from same property since, escalation >1hr ago | `/messages?filter=escalated_unhandled` |
| 2 | Orange `#f59e0b` | Approvals aging | AI draft pending approval, created >2hr ago | `/messages?filter=pending_approval_aged` |
| 3 | Yellow `#eab308` | Stale conversations | last inbound >7d ago, status non-terminal, no outbound since | `/leads?filter=stale_conversations` |
| 4 | Yellow `#eab308` | Sequences ended without follow-up | enrollment.status=completed, completed_at >24hr ago, no manual outbound since | `/leads?filter=sequence_ended_no_followup` |
| 5 | Grey `#6b7280` | Unassigned leads | assigned_user_id IS NULL, status non-terminal | `/leads?filter=unassigned` |

### Vendor-agnostic UI labels

The skip-trace provider name (Tracerfy or any future swap) **never** appears on the dashboard. The hero strip is labeled "Skip-Trace Credits" — the capability, not the vendor. Provider names live only on `/admin/skip-trace-settings` where the operator picks them. Swapping providers is a config + adapter change; the dashboard reads the balance through the common provider interface.

### Skip-Trace Credits hero strip

- Label "SKIP-TRACE CREDITS" (label-caps), large credit count + "credits remaining".
- Horizontal pill-rounded progress bar: filled portion = `current / last_topup_amount`, clamped to [0, 1].
- Progress fill color: green ≥100, orange 20–99, red <20.
- Caption "Last topped up [date]" using timestamp of most recent positive credit delta.
- Right side: pill text-link "Top up →" routing to `/admin/skip-trace-settings`.
- Failure mode: when provider is misconfigured or balance unknown, render single line "Skip-trace credits unavailable — check settings", no bar.

### Right rail

**Replies awaiting approval panel**
- 5 oldest pending AI drafts by created_at.
- Header chip: "N total · M aged" where M = drafts >2hr old. "M aged" portion in red, hidden if M = 0.
- Each row: avatar (initials), lead name + truncated address, AI draft preview (single line, italic, truncated), age timestamp. Timestamp red if >2hr.
- Row click → `/messages/[lead_id]?action=approve`.
- "View all (N) →" link → `/messages?filter=pending_approval`.
- Empty state: "No replies waiting — nice work".

**Recent activity feed**
- 10 most recent events across: new inbound message, sequence completion, import job done, skip-trace job done, AI escalation.
- Per row: type icon + one-line summary + timestamp.
- Timestamps: relative ("12m ago") for <24hr, absolute ("Apr 27 3:40pm") for older.
- Row click → most relevant detail page (lead, list, etc.).
- Empty state: "No recent activity".

### Quick actions row

Three equal-width pill buttons at the bottom of main content:
1. "Import a list" (outlined) → `/import`
2. "Start a sequence" (solid charcoal) → `/sequences/new`
3. "View messages" (outlined) → `/messages`

### Routing & sidebar

- New page at `src/app/(dashboard)/dashboard/page.tsx` — URL is `/dashboard`.
- Sidebar (`src/components/dashboard-sidebar.tsx`): add new top entry "Dashboard" above Leads, with a gauge / home icon, highlighted active when route is `/dashboard`.
- Auth callback or root `src/app/page.tsx`: redirect authenticated users to `/dashboard` instead of `/leads`. Unauthenticated → `/auth/login` (existing behavior).

## Data model touchpoints — existing schema only, no migration

| Need | Source |
|---|---|
| Total leads, delta vs last 7d | `properties` table, scoped to org via RLS |
| Assigned counts | `properties.assigned_user_id` (migration 010), grouped by user, joined to org members for VA name |
| Not in a drip | `properties` LEFT JOIN `sequence_enrollments` where `enrollments.status='active'` IS NULL |
| Hot leads | `properties.status` in (`interested`, `offer_sent`) (migration 014 enum) |
| Skip-trace coverage | `properties.address_normalized` ↔ `skip_trace_cache.address_normalized` join, count distinct on left side |
| Skip-trace credit balance | configured provider's `getBalance()` via the common interface |
| Pending AI drafts | the AI responder pending-state table from migrations 019/020 |
| Stale conversations | `messages` table, `last_inbound_at` vs `last_outbound_at` per property |
| Unassigned leads | `properties.assigned_user_id IS NULL` |
| Recent activity | union over messages, enrollments, jobs (skip_trace + import), escalations — newest 10 |

All queries scoped to the user's organization via existing RLS — no cross-org leakage paths.

## Performance

- All counts batched into a single Supabase RPC (`dashboard_summary`) returning a JSON object — not 8 separate round-trips. Counts use database aggregates, never client-side filtering.
- Skip-trace credit balance fetched separately (vendor call), with a 60s server-side cache. If the vendor call fails or times out, the hero strip degrades to "unavailable" without blocking the rest of the page.
- First-paint target ≤500ms on warm cache. Streaming SSR is fine — KPI tiles can render with skeleton placeholders while the RPC resolves.
- The page is server-rendered; counts are server props, never `useState` mirrors (per the project rule). Click-throughs use `router.replace` + `router.refresh()` if data depends on query params.

## File structure

**New files:**

```
src/app/(dashboard)/dashboard/
  page.tsx
  _actions.ts                          # dashboard_summary RPC call + skip-trace balance fetch
  _components/
    skip-trace-credits-hero.tsx
    needs-attention-strip.tsx
    kpi-stat-card.tsx                  # shared by Total leads, Not in a drip
    kpi-assigned-card.tsx              # split-row variant
    kpi-donut-card.tsx                 # shared by Hot leads + Skip-trace coverage
    approvals-panel.tsx
    activity-feed.tsx
    quick-actions.tsx

supabase/migrations/025_dashboard_summary_rpc.sql   # RPC only, no schema change
```

**Files to modify:**

```
src/components/dashboard-sidebar.tsx   # add Dashboard nav entry at top
src/app/page.tsx                       # authenticated → /dashboard
src/app/(dashboard)/layout.tsx         # verify warm-paper Page shell renders correctly with right rail
```

**Filter handlers** — the click-through filter params on `/leads` and `/messages` already exist for some (e.g. `status=`) but new ones need wiring (`filter=stale_conversations`, `filter=sequence_ended_no_followup`, `filter=unassigned`, `filter=no_active_sequence`, `assignee=me|<id>`, `skip_traced=false`, `filter=pending_approval`, `filter=pending_approval_aged`, `filter=escalated_unhandled`). Each needs a query builder branch in the existing leads/messages list pages.

## Open questions to resolve during build

1. **Sidebar icon for Dashboard** — gauge, home, or grid? Default to gauge (matches "morning triage" framing).
2. **Activity feed event types** — confirm the union is exhaustive. May need to add: contact added, status changed, tag applied. Keep V1 to the 5 listed; expand if Jarrad asks.
3. **Donut chart library** — recharts is likely already in deps from the leads/properties pages. If not, add `recharts` (small footprint) rather than building SVG donuts by hand. Verify before installing.
4. **First-day empty state** — when org has 0 leads, the whole dashboard is empty. Render a single full-page "Import your first list →" CTA instead of 5 zero-tiles. Out of scope for V1 if Jarrad has data already; trivial to add later.

## Test cases

### A. Routing & shell

1. Hitting `/dashboard` while authenticated renders the dashboard page.
2. Hitting `/` while authenticated redirects to `/dashboard`.
3. Hitting `/dashboard` while signed out redirects to `/auth/login`.
4. The sidebar shows a new top entry "Dashboard" above Leads, highlighted as active when on `/dashboard`.
5. The page renders inside the existing Page + PageHeader shell — warm-paper bg, no white sheets behind.
6. Page header shows greeting "Good morning, [first name]" + today's date.

### B. Skip-Trace Credits hero

7. Hero strip shows current credit balance from the configured provider via the common interface.
8. Progress bar fill = `current / last_topup_amount`, clamped to [0, 1].
9. Bar is green when balance ≥100, orange 20–99, red <20.
10. Caption shows "Last topped up [date]" from the timestamp of the most recent positive credit delta.
11. "Top up →" link routes to `/admin/skip-trace-settings`.
12. When provider is misconfigured or credits unknown, the strip renders a single "Skip-trace credits unavailable — check settings" line, no bar.

### C. Needs Attention strip

13. Each row queries its own count and only renders when `count > 0`.
14. When all 5 counts are 0, the strip collapses to a single green "All clear ✓" line.
15. Row 1 (escalated, unhandled) counts: AI escalation_reason set, no human outbound from same property since, escalation timestamp >1hr ago.
16. Row 2 (approvals aging) counts: AI drafts pending approval, created >2hr ago.
17. Row 3 (stale conversations) counts: properties with last inbound >7d ago, status not in (`closed`, `dead`, `under_contract`), no outbound since last inbound.
18. Row 4 (sequences ended without follow-up) counts: enrollments with status='completed', completed_at >24hr ago, no manual outbound since.
19. Row 5 (unassigned) counts: properties with assigned_user_id IS NULL, status not in (`closed`, `dead`).
20. Each row click-through navigates to a filtered `/leads` or `/messages` view with the corresponding filter param applied.
21. Counts are scoped to the org via existing RLS — no cross-org leakage.

### D. KPI row 1

22. Total leads card shows count of properties with status != 'dead' for the org.
23. Delta chip "+N this week" = properties created in the last 7 days, hidden if N = 0.
24. Total leads card click-through routes to `/leads`.
25. Assigned card shows two rows: "Assigned to me" = count where assigned_user_id = current_user.id; "Assigned to [VA name]" = count where assigned_user_id = each other org member. If org has only one user, the card collapses to a single row.
26. Each assigned-to row click-through routes to `/leads?assignee=[user_id]`.
27. Not in a drip card shows count of properties with no row in sequence_enrollments where status='active' for that property.
28. Not in a drip click-through routes to `/leads?filter=no_active_sequence`.

### E. KPI row 2 — donuts

29. Hot leads donut numerator = properties with status in (`interested`, `offer_sent`); denominator = properties with status not in (`closed`, `dead`, `prospect`).
30. Donut center shows percentage; below shows "(N of M)" raw counts.
31. Hot leads click-through routes to `/leads?status=hot` (filter maps to `interested|offer_sent`).
32. Skip-trace coverage donut numerator = properties whose address_normalized has at least one row in skip_trace_cache regardless of match_count; denominator = total non-terminal properties.
33. Click-through routes to `/leads?skip_traced=false` (the gap, not the covered portion).
34. When denominator is 0, donut renders a "—" placeholder, no divide-by-zero error.

### F. Right rail — Replies awaiting approval

35. Panel lists 5 oldest pending AI drafts by created_at.
36. Header chip shows "N total · M aged" where M = drafts older than 2hr; "M aged" hidden when 0.
37. Each row shows: lead first name + last initial, address (city + state, truncated), AI draft preview (single line, ellipsized), age timestamp.
38. Row timestamp displays in red text when draft age >2hr.
39. Row click-through routes to `/messages/[lead_id]?action=approve`.
40. "View all" link routes to `/messages?filter=pending_approval`.
41. When 0 drafts pending, panel shows "No replies waiting — nice work" empty state.

### G. Right rail — Recent activity

42. Feed shows 10 most recent events across: new inbound message, sequence completion, import job done, skip-trace job done, AI escalation.
43. Each row: type icon + one-line summary + timestamp; icons distinct per type.
44. Events older than 24hr show absolute timestamp ("Apr 27 3:40pm"); newer show relative ("12m ago").
45. Row click-through routes to the most relevant detail page.
46. When 0 events in last 7 days, panel shows "No recent activity" empty state.

### H. Quick actions

47. "Import a list" routes to `/import`.
48. "Start a sequence" routes to `/sequences/new`.
49. "View messages" routes to `/messages`.

### I. Performance & data freshness

50. All counts use a single batched Supabase RPC, not 8 separate round-trips.
51. Page first-paint ≤500ms on warm cache; counts use DB aggregates, never client-side filtering of large lists.
52. Counts respect RLS — switching user/org gives different results without code change.
53. `router.refresh()` after navigating to a click-through filter and back updates all counts (no useState mirroring of server props).

### J. Vendor abstraction

54. No occurrence of "Tracerfy" or any provider name in any dashboard UI string. Provider names appear only in `/admin/skip-trace-settings`.
55. Swapping the configured provider in env doesn't require any dashboard code change — only the credit-balance source updates via the common provider interface.
