/**
 * Shared contract between the Calendar page (page.tsx/queries.ts, owned by
 * the data-layer lane) and `_components/**` (owned by a separate lane,
 * builds `<CalendarView>` against this file). Settled early and kept
 * deliberately minimal — both lanes import this file; DO NOT widen it
 * without checking the other lane isn't mid-build against the old shape.
 */

/** Desktop = week or month grid; mobile is the same data, day-agenda
 *  layout via CSS-only `md:` dual render (no separate fetch/route). */
export type CalendarViewMode = "week" | "agenda" | "month";

export type CalendarViewerRole = "owner" | "member";

/** One zone-local calendar day's UTC instant bounds — `[startUtc, endUtc)`.
 *  `date` is the YYYY-MM-DD label in the viewer's own timezone (the same
 *  zone `startUtc`/`endUtc` were derived in via `getDayBoundsInZone` /
 *  `addDaysInZone`), safe to use as a display heading or a grouping key. */
export type CalendarDayBounds = {
  /** YYYY-MM-DD, zone-local. */
  date: string;
  /** ISO UTC instant of this day's zone-local midnight. */
  startUtc: string;
  /** ISO UTC instant of the next day's zone-local midnight (exclusive). */
  endUtc: string;
};

/**
 * One appointment-type task row for the calendar grid/agenda. Open +
 * completed appointments only (never cancelled — lifecycle policy keeps
 * cancelled appointments off the calendar surface); `due_at`/`end_at` are
 * both always populated for `type='appointment'` rows (PR 1 CHECK).
 *
 * Exactly one of `property_id` / `contact_id` / neither is set — never
 * both are meaningfully absent AND present at once beyond what the DB
 * already allows (personal blocks: neither; property-linked: property
 * only; contact-only: contact only). `address`/`city`/`state` are null
 * exactly when `property_id` is null; `contact_name` is null exactly when
 * `contact_id` is null.
 */
export type CalendarAppointmentRow = {
  id: string;
  title: string;
  description: string | null;
  /** ISO timestamptz. */
  due_at: string;
  /** ISO timestamptz — always non-null for type='appointment' rows. */
  end_at: string;
  status: string;
  outcome: string | null;
  assignee_id: string;
  property_id: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  contact_id: string | null;
  /** True when the linked property is under the permanent DNC ratchet. */
  is_dnc_locked: boolean;
  /** Display label derived from contacts.entity_name, or
   *  "first_name last_name", or null when neither is set. */
  contact_name: string | null;
};

/**
 * Props for `_components`' `<CalendarView>`, built by the page from the
 * data-layer fetches. `week` is the zone-local YYYY-MM-DD anchor of the
 * displayed week's first day (matches `days[0].date`) — carried separately
 * from `days` so the component can build prev/next-week hrefs
 * (`?week=<anchor>`) without re-deriving it from the array.
 */
export type CalendarViewProps = {
  view: CalendarViewMode;
  /** YYYY-MM-DD, zone-local — the displayed range's first day (week view:
   *  the week's Sunday; month view: the GRID's first cell, which can fall
   *  in the previous month). */
  week: string;
  /** YYYY-MM zone-local month key of the displayed month when
   *  `view === "month"`, else null. Drives the month grid's
   *  outside-month muting and the month-step prev/next nav. */
  month: string | null;
  /** Week view: exactly 7 entries. Month view: exactly 42 entries (the
   *  fixed six-row Sunday-to-Saturday grid). Always
   *  `days[0].date === week`, consecutive zone-local days in order. */
  days: CalendarDayBounds[];
  appointments: CalendarAppointmentRow[];
  /** IANA zone every date/time above was computed in — the viewer's own
   *  `user_integration_prefs.timezone` (loadIntegrationPrefs, self). */
  timezone: string;
  viewerRole: CalendarViewerRole;
  /** user_id -> email, for the ACTIVE org roster only (both roles now get
   *  the filter). This is the set the assignee filter's option list is
   *  built from — it must NEVER include a former/inactive member (Codex
   *  round 4), since offering an id you can no longer assign appointments
   *  to would be a dead filter option. Empty map is a valid state (lookup
   *  failure degrades to showing no email labels, never breaks the page). */
  assignees: Record<string, string>;
  /** user_id -> label for EVERY assignee referenced by `appointments`
   *  (Codex round 4) — a superset of `assignees` that also covers a
   *  suspended/former teammate still attributed on a past appointment row
   *  (fallback label `"Former teammate (<id-prefix>)"` when no email is
   *  resolvable). Used ONLY for the per-appointment "whose appointment"
   *  label — never for the filter's option list, so an inactive id can be
   *  labeled without becoming a selectable filter value. */
  assigneeLabels: Record<string, string>;
  currentUserId: string;
  /** One request-captured instant shared by every calendar surface. */
  nowMs: number;
  /** Zone-local date key derived from the same request-captured instant. */
  todayKey: string;
};

/** `?week=&assignee=&view=` — parsed by page.tsx from the awaited
 *  `searchParams` promise (Next.js 15 async searchParams contract). */
export type CalendarSearchParams = {
  /** YYYY-MM-DD, zone-local anchor of the desired range; any day within
   *  the week (or month, for view=month) works — the page derives the
   *  range containing it. Defaults to "today" in the viewer's zone when
   *  absent/unparseable. */
  week?: string;
  /** A specific assignee's user id, or the sentinel `"me"`/`"all"` — see
   *  `resolveAssigneeId` in page.tsx. Owner default (param absent):
   *  org-wide. Member default (param absent): `"me"`. Both roles can set
   *  an explicit `?assignee=` to see a teammate or `"all"` (plan decision
   *  7 — "own items" is a default, not a lockout, since the booking flow
   *  already lets a member book on a teammate's behalf). */
  assignee?: string;
  view?: CalendarViewMode;
};
