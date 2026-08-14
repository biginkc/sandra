import Link from "next/link";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { getCallerMemberships } from "@/lib/auth/memberships";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import { createClient } from "@/lib/supabase/server";
import { addDaysInZone, getDayBoundsInZone, wallTimeToUtc } from "@/lib/time/zoned";

import { fetchCalendarAppointments, fetchOrgRoster } from "./queries";
import { resolveAssigneeId } from "./scoping";
import type {
  CalendarDayBounds,
  CalendarSearchParams,
  CalendarViewMode,
  CalendarViewerRole,
} from "./types";
// Owned by a separate lane (src/app/(dashboard)/calendar/_components/**),
// building against the `CalendarViewProps` contract in ./types.ts. Not
// created here — this import is expected to be unresolved until that
// lane's PR lands; final integration happens post-lanes.
import { CalendarView } from "./_components/calendar-view";

export const dynamic = "force-dynamic";

const WEEK_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Resolves the zone-local day-of-week (0=Sunday..6=Saturday) of a UTC
 * instant AS OBSERVED in `timeZone` — used to walk an anchor day back to
 * its week's Sunday. Formatting the same instant through the target zone
 * (rather than reading UTC fields) is what keeps this correct regardless
 * of what zone the server process itself runs in.
 */
function weekdayIndexInZone(instant: Date, timeZone: string): number {
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(instant);
  return WEEKDAY_INDEX[label] ?? 0;
}

/**
 * YYYY-MM-DD label of `instant`'s zone-local calendar date. Built from
 * `formatToParts` (numeric y/m/d, then joined explicitly) rather than a
 * locale-string shortcut like `en-CA` — same defensive approach as
 * `zoned.ts`'s internal `getZonedParts`, which this mirrors: don't trust
 * a locale's formatted output to always come back in a fixed shape.
 */
function zonedDateLabel(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return `${map.year}-${map.month}-${map.day}`;
}

/**
 * Resolves the anchor day (from `?week=`, defaulting to "today") to its
 * containing week's 7 zone-local day bounds, Sunday through Saturday (no
 * existing week-start convention found elsewhere in the app — Sunday per
 * the plan's fallback).
 *
 * The anchor string is converted through `wallTimeToUtc` at a fixed
 * midday wall-time rather than `new Date(anchor)` — parsing a bare
 * YYYY-MM-DD as UTC midnight and then asking "what zone-local day is
 * this" can land on the WRONG calendar day for zones behind UTC (e.g.
 * Pacific): midday avoids that edge entirely for every zone this app
 * supports, and reuses the same DST-safe wall-time boundary the rest of
 * the appointment feature is built on instead of ad hoc date math.
 */
function resolveWeek(
  anchor: string | undefined,
  timeZone: string,
): { weekStartDate: string; days: CalendarDayBounds[] } {
  let anchorInstant: Date;
  if (anchor && WEEK_DATE_RE.test(anchor)) {
    const converted = wallTimeToUtc({ date: anchor, time: "12:00", timeZone });
    anchorInstant = converted.ok ? converted.utc : new Date();
  } else {
    anchorInstant = new Date();
  }

  const { dayStart: anchorDayStart } = getDayBoundsInZone(anchorInstant, timeZone);
  const weekday = weekdayIndexInZone(anchorDayStart, timeZone);
  const weekStart =
    weekday === 0 ? anchorDayStart : addDaysInZone(anchorDayStart, -weekday, timeZone);

  const days: CalendarDayBounds[] = [];
  let cursor = weekStart;
  for (let i = 0; i < 7; i++) {
    const next = addDaysInZone(cursor, 1, timeZone);
    days.push({
      date: zonedDateLabel(cursor, timeZone),
      startUtc: cursor.toISOString(),
      endUtc: next.toISOString(),
    });
    cursor = next;
  }

  return { weekStartDate: days[0].date, days };
}

/**
 * Rebuilds the current `/calendar` URL from the already-parsed
 * `searchParams` (Codex round 2 retry link) — a plain re-request of the
 * same view/week/assignee, not a reset to defaults, so retrying after a
 * transient failure lands back where the viewer was.
 */
function currentCalendarHref(params: CalendarSearchParams): string {
  const sp = new URLSearchParams();
  if (params.week) sp.set("week", params.week);
  if (params.assignee) sp.set("assignee", params.assignee);
  if (params.view) sp.set("view", params.view);
  const qs = sp.toString();
  return qs ? `/calendar?${qs}` : "/calendar";
}

/**
 * Shared explicit couldn't-load/Retry state (Codex round 3) — used for
 * BOTH an appointments-fetch failure and a roster-identity failure
 * (`fetchOrgRoster` returning `ok: false`). A roster-identity failure
 * means the set of valid assignee ids is unknown, so the filter and any
 * per-appointment ownership attribution are untrustworthy: it is not safe
 * to relabel or narrow to a viewer-only view, only to say the page didn't
 * load and offer a retry that re-requests the same view/week/assignee.
 */
function retryState(params: CalendarSearchParams) {
  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Calendar" }]}
        title="Calendar"
      />
      <div className="text-destructive flex items-center gap-2 text-sm">
        <span>Calendar couldn&apos;t load.</span>
        <Link
          href={currentCalendarHref(params)}
          className="font-bold underline underline-offset-4"
        >
          Retry
        </Link>
      </div>
    </Page>
  );
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams?: Promise<CalendarSearchParams>;
}) {
  const params = (await searchParams) ?? {};
  const view: CalendarViewMode = params.view === "agenda" ? "agenda" : "week";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <Page>
        <PageHeader title="Calendar" />
        <div className="text-destructive text-sm">Not signed in.</div>
      </Page>
    );
  }

  const memberships = await getCallerMemberships();
  const activeMemberships = memberships.filter((m) => m.user_id === user.id);
  if (activeMemberships.length !== 1) {
    return (
      <Page>
        <PageHeader title="Calendar" />
        <div className="text-destructive text-sm">
          {activeMemberships.length > 1
            ? "You belong to more than one org — the calendar can't resolve a single scope."
            : "You don't belong to an org."}
        </div>
      </Page>
    );
  }
  const orgId = activeMemberships[0].org_id;
  const viewerRole: CalendarViewerRole = activeMemberships[0].role;

  const assigneeId = resolveAssigneeId(viewerRole, params.assignee, user.id);

  const prefs = await loadIntegrationPrefs(supabase, user.id);
  const timezone = prefs.timezone;

  const { weekStartDate, days } = resolveWeek(params.week, timezone);
  const weekStartUtc = days[0].startUtc;
  const weekEndUtc = days[6].endUtc;

  const appointmentsResult = await fetchCalendarAppointments(orgId, {
    assigneeId,
    weekStartUtc,
    weekEndUtc,
  });

  // A query failure is NOT an empty week (Codex round 2) — render an
  // explicit retry state instead of silently showing "no appointments".
  // The link re-requests the exact same view/week/assignee, not a reset.
  if (!appointmentsResult.ok) {
    return retryState(params);
  }
  const appointments = appointmentsResult.rows;

  // Loaded independently of `appointments` — the org roster (Codex round
  // 1), not just the ids referenced in the current week's rows, so the
  // filter dropdown (both roles, now that members get one too) always
  // lists every active teammate, including one with zero appointments in
  // the displayed week.
  const rosterResult = await fetchOrgRoster(orgId);
  // A roster IDENTITY failure (Codex round 3) — the set of valid assignee
  // ids is unknown — is treated exactly like an appointments-fetch
  // failure: the filter and ownership attribution are untrustworthy, so
  // this renders the same explicit retry state rather than misrepresenting
  // org rows under a viewer-only claim or leaving lifecycle controls on
  // rows whose ownership can't be verified. (Round 2's "showing your own
  // appointments only" fallback is gone — it silently narrowed scope
  // instead of surfacing the failure.)
  if (!rosterResult.ok) {
    return retryState(params);
  }
  const assignees: Record<string, string> = {};
  for (const entry of rosterResult.roster) {
    assignees[entry.id] = entry.label;
  }
  // LABELS-only degradation (some/all emails unresolved) keeps the full
  // roster, controls, and unmistakable ownership (fallback labels carry
  // the real id prefix) — only the display note changes.
  const labelsDegraded = rosterResult.labelsDegraded;

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Calendar" }]}
        title="Calendar"
        description={
          viewerRole === "owner"
            ? "Org-wide appointments — filter to a teammate below."
            : "Your appointments."
        }
      />
      {labelsDegraded && (
        <div className="text-muted-foreground text-xs">
          Some teammate names are unavailable — showing IDs instead.
        </div>
      )}
      <CalendarView
        view={view}
        week={weekStartDate}
        days={days}
        appointments={appointments}
        timezone={timezone}
        viewerRole={viewerRole}
        assignees={assignees}
        currentUserId={user.id}
      />
    </Page>
  );
}
