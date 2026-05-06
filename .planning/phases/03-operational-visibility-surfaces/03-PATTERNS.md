# Phase 03: Operational Visibility Surfaces - Pattern Map

**Mapped:** 2026-05-05
**Files analyzed:** 8 new/modified files
**Analogs found:** 8 / 8

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/lib/notifications/types.ts` | model | request-response | itself (extend in place) | exact |
| `src/lib/notifications/format.ts` | utility | transform | itself (extend in place) | exact |
| `src/lib/notifications/dispatch.ts` | service | request-response | itself (extend in place) | exact |
| `src/app/api/webhooks/dialpad/sms/route.ts` | controller | event-driven | itself (extend in place) | exact |
| `src/app/(dashboard)/dashboard/_components/kpi-cards.tsx` | component | request-response | itself (extend in place) | exact |
| `src/app/(dashboard)/messages/inbox-filters.tsx` | component | event-driven | itself (extend in place) | exact |
| `src/lib/messages/list-threads.ts` | service | CRUD | itself (extend in place) | exact |
| `src/app/(dashboard)/messages/cockpit-view.tsx` | component | event-driven | itself (extend in place) | exact |

All 8 files are modifications of existing files — no new files are created. Patterns below are extracted from the exact files being modified, providing the precise lines each change must slot into.

---

## Pattern Assignments

### NOTIF-01a: `src/lib/notifications/types.ts` (model, transform)

**Change:** Add `messageBody?: string | null` to `FormatPayload`.

**Existing `FormatPayload` block** (lines 39–49 — full block to modify):
```typescript
export type FormatPayload = {
  propertyAddress?: string | null;
  assignerName?: string | null;
  jobType?: string | null;
  state?: string | null;
  succeeded?: number;
  failed?: number;
  /** For skip_trace_requested: who asked + how many properties. */
  requesterEmail?: string | null;
  propertyCount?: number;
};
```

**After change — add one field before the closing brace:**
```typescript
  /** For owner_message_added: truncated SMS preview text. */
  messageBody?: string | null;
```

---

### NOTIF-01b: `src/lib/notifications/format.ts` (utility, transform)

**Change:** Update the `owner_message_added` case to append a truncated SMS preview to the body when `payload.messageBody` is non-empty and not a bare URL. Truncate at 80 chars (consistent with activity-feed line 173 in migration 028).

**Existing `owner_message_added` case** (lines 39–44 — the block to replace):
```typescript
case "owner_message_added": {
  const address = payload.propertyAddress ?? "a property";
  return {
    title: "New SMS reply",
    body: `Reply from ${address}`,
  };
}
```

**After change — append preview when body is usable:**
```typescript
case "owner_message_added": {
  const address = payload.propertyAddress ?? "a property";
  const raw = payload.messageBody?.trim() ?? "";
  // Bare URLs (e.g. a media MMS stub) are not useful as a preview.
  const isUrl = /^https?:\/\//i.test(raw);
  const preview = raw && !isUrl
    ? `\n"${raw.length > 80 ? raw.slice(0, 80) + "…" : raw}"`
    : "";
  return {
    title: "New SMS reply",
    body: `Reply from ${address}${preview}`,
  };
}
```

**Pattern notes:**
- The bell already renders body with `{n.body && <div className="text-muted-foreground mt-0.5 text-xs">{n.body}</div>}` — no UI change needed. The `\n` in the string is presentational; if the bell renders inside a `whitespace-pre-wrap` container this works automatically. If not, the planner should confirm rendering or split into two lines via another separator character (e.g. `" — "`).
- 80-char limit is canonical from `dashboard_summary()` activity feed (migration 028, line 173).

---

### NOTIF-01c: `src/lib/notifications/dispatch.ts` (service, request-response)

**Change:** Add `messageBody?: string | null` to the `dispatchOwnerMessageAdded` params block and thread it into the `payload` passed to `createNotification`.

**Existing `dispatchOwnerMessageAdded` signature** (lines 72–78):
```typescript
export async function dispatchOwnerMessageAdded(
  supabase: SupabaseClient<Database>,
  params: {
    propertyId: string;
    adminUserIds: readonly string[];
  },
): Promise<{ inserted: number }> {
```

**After change — extend params:**
```typescript
export async function dispatchOwnerMessageAdded(
  supabase: SupabaseClient<Database>,
  params: {
    propertyId: string;
    adminUserIds: readonly string[];
    messageBody?: string | null;
  },
): Promise<{ inserted: number }> {
```

**Existing `createNotification` call site** (lines 91–98 — the payload line to extend):
```typescript
  return createNotification(supabase, {
    orgId: property.org_id,
    eventType: "owner_message_added",
    entityType: "property",
    entityId: property.id,
    payload: { propertyAddress: property.address },
    recipients,
  });
```

**After change — pass messageBody into payload:**
```typescript
    payload: { propertyAddress: property.address, messageBody: params.messageBody },
```

---

### NOTIF-01d: `src/app/api/webhooks/dialpad/sms/route.ts` (controller, event-driven)

**Change:** Pass `ev.body` as `messageBody` to `dispatchOwnerMessageAdded` at the call site.

**Existing dispatch call** (lines 395–398):
```typescript
          await dispatchOwnerMessageAdded(supabase, {
            propertyId,
            adminUserIds,
          });
```

**After change:**
```typescript
          await dispatchOwnerMessageAdded(supabase, {
            propertyId,
            adminUserIds,
            messageBody: ev.body,
          });
```

**Context:** `ev.body` is already in scope at this point — it is the raw inbound SMS text. The regular-message branch is reached only after STOP/HELP/DNC/WRONG_NUMBER have been filtered out, so `ev.body` at this point is a genuine conversational reply.

---

### DASH-01: `src/app/(dashboard)/dashboard/_components/kpi-cards.tsx` (component, request-response)

**Change (D-05):** Update the `<Link href>` on the skip-trace coverage donut card from `/leads?skip_traced=false` to a route that shows all properties without skip-trace data (prospects + leads combined).

**RPC verification (D-04 — confirmed no migration needed):**
Migration 028, lines 64–72:
```sql
select count(distinct p.id) into v_traced_num
from properties p
join skip_trace_cache c on c.address_normalized = p.address_normalized
where p.deleted_at is null
  and p.address_normalized is not null;

select count(*) into v_traced_den
from properties
where deleted_at is null;
```
The denominator (`v_traced_den`) counts ALL non-deleted properties with no `status` filter. The numerator counts all non-deleted properties with a skip-trace cache hit regardless of status. Correct — no migration needed.

**Existing skip-trace card block** (lines 158–176):
```tsx
      <Link
        href="/leads?skip_traced=false"
        className="border-border bg-card hover:border-foreground/30 group rounded-2xl border px-6 py-5 transition-colors"
      >
        <div className="text-muted-foreground text-[11px] font-bold tracking-widest uppercase">
          Skip-trace coverage
        </div>
        <div className="mt-4 flex items-center justify-center">
          <Donut
            numerator={summary.skip_trace_coverage.numerator}
            denominator={summary.skip_trace_coverage.denominator}
          />
        </div>
        <div className="text-muted-foreground mt-3 text-center text-xs font-medium">
          Phone numbers gathered
        </div>
      </Link>
```

**Single-line change — the href attribute:**
```tsx
        href="/properties?skip_traced=false"
```

**Planner note:** The planner should verify whether `/properties` supports a `?skip_traced=false` filter param. If the properties route does not yet support that filter, the safest fallback is `/properties` (landing on all properties) rather than `/leads?skip_traced=false` which excludes prospects. Check `src/app/(dashboard)/properties/page.tsx` for existing searchParam handling before finalizing the href.

**Link card pattern (for reference — copy from KpiRowOne lines 26–41):**
```tsx
<Link
  href="/leads"
  className="border-border bg-card hover:border-foreground/30 group rounded-2xl border px-6 py-5 transition-colors"
>
  <div className="text-muted-foreground text-[11px] font-bold tracking-widest uppercase">
    Total leads
  </div>
  <div className="text-foreground mt-2 text-4xl font-extrabold tracking-tight tabular-nums">
    {totalLeads.toLocaleString()}
  </div>
</Link>
```

---

### MSG-01a: `src/app/(dashboard)/messages/inbox-filters.tsx` (component, event-driven)

**Change (D-06 + D-07):** Add `"unread"` to `InboxFilter` union; add `unreadCount` prop to `InboxFilters`; add the Unread `FilterChip` with badge.

**Existing `InboxFilter` union** (lines 7–12 — add `"unread"`):
```typescript
export type InboxFilter =
  | "all"
  | "mine"
  | "unassigned"
  | "unknown"
  | "dismissed";
```
**After change:**
```typescript
export type InboxFilter =
  | "all"
  | "mine"
  | "unassigned"
  | "unknown"
  | "unread"
  | "dismissed";
```

**Existing `Props` type** (lines 14–19 — add `unreadCount`):
```typescript
type Props = {
  active: InboxFilter;
  unknownCount: number;
  /** Hide Mine + Unassigned chips when no auth user is on the request. */
  showAssignmentChips: boolean;
};
```
**After change:**
```typescript
type Props = {
  active: InboxFilter;
  unknownCount: number;
  unreadCount: number;
  /** Hide Mine + Unassigned chips when no auth user is on the request. */
  showAssignmentChips: boolean;
};
```

**`FilterChip` pattern with badge (copy from Unknown chip, lines 67–73):**
```tsx
<FilterChip
  label="Unknown"
  active={active === "unknown"}
  badge={unknownCount > 0 ? String(unknownCount) : undefined}
  onClick={() => setFilter("unknown")}
  testId="filter-unknown"
/>
```

**New Unread chip — insert after Unknown chip (before Dismissed):**
```tsx
<FilterChip
  label="Unread"
  active={active === "unread"}
  badge={unreadCount > 0 ? String(unreadCount) : undefined}
  onClick={() => setFilter("unread")}
  testId="filter-unread"
/>
```

**`setFilter` / `router.replace` pattern (lines 34–41 — already handles any InboxFilter value):**
```typescript
const setFilter = (next: InboxFilter) => {
  const sp = new URLSearchParams(searchParams.toString());
  if (next === "all") sp.delete("filter");
  else sp.set("filter", next);
  sp.delete("thread"); // clear selection when switching filters
  const qs = sp.toString();
  router.replace(qs ? `/messages?${qs}` : "/messages");
};
```
No change required — `setFilter` already handles any valid `InboxFilter` value generically.

**`FilterChip` component internals (lines 84–113 — copy as-is, no changes):**
```tsx
function FilterChip({
  label,
  active,
  onClick,
  badge,
  testId,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: string;
  testId: string;
}) {
  return (
    <Button
      variant={active ? "default" : "outline"}
      size="sm"
      onClick={onClick}
      data-testid={testId}
      data-active={active || undefined}
    >
      <span>{label}</span>
      {badge ? (
        <span className="bg-background text-foreground ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px]">
          {badge}
        </span>
      ) : null}
    </Button>
  );
}
```

---

### MSG-01b: `src/lib/messages/list-threads.ts` (service, CRUD)

**Change (D-08):** Add `unreadOnly?: boolean` to `ListThreadsOpts`; when true, filter out threads where `unreadCount === 0` before returning.

**Existing `ListThreadsOpts` type** (lines 19–26 — add field):
```typescript
export type ListThreadsOpts = {
  /** Window for "active" conversations. Defaults to 90 days. */
  sinceDays?: number;
  /** When set, returns only threads on properties assigned to this user. */
  assigneeId?: string;
  /** When true, returns only threads on properties with no assignee. */
  unassignedOnly?: boolean;
};
```
**After change:**
```typescript
export type ListThreadsOpts = {
  /** Window for "active" conversations. Defaults to 90 days. */
  sinceDays?: number;
  /** When set, returns only threads on properties assigned to this user. */
  assigneeId?: string;
  /** When true, returns only threads on properties with no assignee. */
  unassignedOnly?: boolean;
  /** When true, returns only threads with at least one unread inbound message. */
  unreadOnly?: boolean;
};
```

**Existing filter guard pattern** (lines 114–115 — copy this exact pattern for unreadOnly):
```typescript
    if (opts.assigneeId && p?.assigned_user_id !== opts.assigneeId) continue;
    if (opts.unassignedOnly && p?.assigned_user_id) continue;
```
**Add after these two lines (before the `threads.push()` call):**
```typescript
    if (opts.unreadOnly && bucket.unreadCount === 0) continue;
```

**`unreadCount` is already computed per-thread** (lines 72–75 — no new DB query needed):
```typescript
    if (m.direction === "inbound" && m.read_at === null) {
      bucket.unreadCount += 1;
    }
```

---

### MSG-01c: `src/app/(dashboard)/messages/cockpit-view.tsx` (component, event-driven)

**Change (D-09):** Add `"unread"` to the `THREAD_FILTERS` set so the thread list renders (not the unknown-sender list) when the Unread filter is active.

**Existing `THREAD_FILTERS` constant** (line 41):
```typescript
const THREAD_FILTERS = new Set<InboxFilter>(["all", "mine", "unassigned"]);
```
**After change:**
```typescript
const THREAD_FILTERS = new Set<InboxFilter>(["all", "mine", "unassigned", "unread"]);
```

**How it is consumed** (line 69):
```typescript
const showThreadList = THREAD_FILTERS.has(filter);
```
When `filter === "unread"`, `showThreadList` becomes `true` — the `InboxThreadList` renders instead of `UnknownSenderList`. The threads passed in are already filtered by `unreadOnly: true` from the server (see MSG-01d below).

---

### MSG-01d: `src/app/(dashboard)/messages/page.tsx` (server component, CRUD)

**Change:** Add `"unread"` to the `filter` parse block; set `threadOpts.unreadOnly = true` when active; compute `unreadCount` from threads for the badge; pass `unreadCount` to `CockpitView` (which passes it to `InboxFilters`).

**Existing filter parse block** (lines 50–59 — add unread branch):
```typescript
  const filter: InboxFilter =
    sp.filter === "unknown"
      ? "unknown"
      : sp.filter === "dismissed"
        ? "dismissed"
        : sp.filter === "mine"
          ? "mine"
          : sp.filter === "unassigned"
            ? "unassigned"
            : "all";
```
**After change:**
```typescript
  const filter: InboxFilter =
    sp.filter === "unknown"
      ? "unknown"
      : sp.filter === "dismissed"
        ? "dismissed"
        : sp.filter === "mine"
          ? "mine"
          : sp.filter === "unassigned"
            ? "unassigned"
            : sp.filter === "unread"
              ? "unread"
              : "all";
```

**Existing `threadOpts` resolution block** (lines 68–70 — add unreadOnly):
```typescript
  const threadOpts: ListThreadsOpts = {};
  if (filter === "mine" && currentUser) threadOpts.assigneeId = currentUser.id;
  if (filter === "unassigned") threadOpts.unassignedOnly = true;
```
**After change — add one line:**
```typescript
  if (filter === "unread") threadOpts.unreadOnly = true;
```

**Deriving `unreadCount` for the badge (D-07 — from the already-fetched threads):**

The full thread list is fetched regardless of active filter (badge counts need it). However when `unreadOnly` is true the returned threads are pre-filtered — so `unreadCount` must be derived from a full-list fetch. The cleanest approach (no extra DB call): always fetch threads without `unreadOnly`, compute the badge count in JS, then apply a client-side JS filter if `filter === "unread"`. Alternatively, fetch threads twice — once filtered and once for the count. The planner should pick the approach that minimises DB round-trips; the simplest is:

```typescript
  // Always fetch the unfiltered thread list for badge computation.
  const allThreadsForBadge = filter === "unread"
    ? await listThreads(supabase, { ...threadOpts, unreadOnly: false })
    : threads; // threads is already the full set when filter !== "unread"

  const unreadCount = allThreadsForBadge.filter(t => t.unreadCount > 0).length;
```

Pass `unreadCount` through to `CockpitView` → `InboxFilters` as the new `unreadCount` prop.

---

## Shared Patterns

### URL-based filter state
**Source:** `src/app/(dashboard)/messages/inbox-filters.tsx` lines 34–41 and `src/app/(dashboard)/messages/page.tsx` lines 50–70
**Apply to:** All MSG-01 changes

Pattern: searchParam `?filter=<value>` → server parses to typed `InboxFilter` → `ListThreadsOpts` → `listThreads` → `CockpitView` → `InboxFilters` (active prop). Client-side chip click → `new URLSearchParams` → `router.replace`. The `"unread"` filter follows this chain exactly.

### Opt-in field extension (notifications)
**Source:** `src/lib/notifications/types.ts` `FormatPayload` type — all fields `optional`
**Apply to:** NOTIF-01a/b/c/d

Pattern: `FormatPayload` is a single loose-typed object covering all event types. New fields are always `?: optional` so existing dispatch call sites compile without modification. Only the specific dispatch function (`dispatchOwnerMessageAdded`) is updated to accept + forward the new field.

### Best-effort dispatch (never throw across webhook boundary)
**Source:** `src/app/api/webhooks/dialpad/sms/route.ts` lines 386–406
**Apply to:** NOTIF-01d

```typescript
        try {
          await dispatchOwnerMessageAdded(supabase, {
            propertyId,
            adminUserIds,
          });
        } catch (e) {
          // Notifications are best-effort — never fail the webhook.
          reportError(e, {
            tags: { surface: "dialpad_webhook_notification_dispatch" },
            extra: { propertyId, externalId: ev.externalId },
          });
        }
```
The existing `try/catch` wrapper already handles errors — the `messageBody` field is just added inside the object literal. No structural change to the error handling.

### `continue`-guard filter pattern in `listThreads`
**Source:** `src/lib/messages/list-threads.ts` lines 114–115
**Apply to:** MSG-01b

```typescript
    if (opts.assigneeId && p?.assigned_user_id !== opts.assigneeId) continue;
    if (opts.unassignedOnly && p?.assigned_user_id) continue;
    // new line slots here:
    if (opts.unreadOnly && bucket.unreadCount === 0) continue;
```
All three guards sit in the same `for` loop over `byContact` entries, before the `threads.push()` call. Add `unreadOnly` guard last in the sequence.

---

## No Analog Found

None — all 8 files are direct modifications of existing files with clear, concrete patterns to follow.

---

## Metadata

**Analog search scope:** `src/lib/notifications/`, `src/app/api/webhooks/dialpad/`, `src/app/(dashboard)/dashboard/_components/`, `src/app/(dashboard)/messages/`, `src/lib/messages/`, `supabase/migrations/`
**Files read:** 9 source files + 1 migration
**Pattern extraction date:** 2026-05-05
