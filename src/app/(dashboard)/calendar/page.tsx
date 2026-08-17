import Link from "next/link";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { getCallerMemberships } from "@/lib/auth/memberships";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import { createClient } from "@/lib/supabase/server";
import {
  fetchAssigneeEmails,
  fetchCalendarAppointments,
  fetchCalendarAppointmentsForWindows,
  fetchOrgRoster,
} from "./queries";
import { resolveMonth, resolveWeek } from "./range";
import { resolveAssigneeId } from "./scoping";
import { todayDateKeyInZone } from "./_components/calendar-shared";
import type {
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

/**
 * Rebuilds the current `/calendar` URL from the already-parsed
 * `searchParams` (Codex round 2 retry link) — a plain re-request of the
 * same view/week/assignee, not a reset to defaults, so retrying after a
 * transient failure lands back where the viewer was.
 */
function currentCalendarHref(params: CalendarSearchParams): string {
  const sp = new URLSearchParams();
  if (params.week) sp.set("week", params.week);
  if (params.month) sp.set("month", params.month);
  if (params.assignee) sp.set("assignee", params.assignee);
  if (params.view) sp.set("view", params.view);
  const qs = sp.toString();
  return qs ? `/calendar?${qs}` : "/calendar";
}

function dateKeyAsUtcNoon(dateKey: string): Date {
  return new Date(`${dateKey}T12:00:00.000Z`);
}

function monthYearLabel(dateKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(dateKeyAsUtcNoon(dateKey));
}

function weekRangeLabel(days: { date: string }[]): string {
  const first = dateKeyAsUtcNoon(days[0].date);
  const last = dateKeyAsUtcNoon(days[days.length - 1].date);
  const monthDay = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
  return `Week of ${monthDay.format(first)} – ${monthDay.format(last)}`;
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
  const view: CalendarViewMode =
    params.view === "agenda"
      ? "agenda"
      : params.view === "month"
        ? "month"
        : "week";

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

  // Loaded BEFORE resolving the assignee filter (Codex round 9) — the
  // active roster is the source of truth for which `?assignee=<id>` values
  // are representable in the selector. Resolving the filter first let a
  // deep link for a removed/suspended teammate pass straight through to
  // the query while the selector (built from this same roster) rendered
  // blank for that value — query scope and visible selector state
  // diverged. This is also independent of `appointments` (Codex round 1),
  // not just the ids referenced in the current week's rows, so the filter
  // dropdown (both roles, now that members get one too) always lists every
  // active teammate, including one with zero appointments in the
  // displayed week.
  const rosterResult = await fetchOrgRoster(orgId);
  // A roster IDENTITY failure (Codex round 3) — the set of valid assignee
  // ids is unknown — is treated exactly like an appointments-fetch
  // failure: the filter and ownership attribution are untrustworthy, so
  // this renders the same explicit retry state rather than misrepresenting
  // org rows under a viewer-only claim or leaving lifecycle controls on
  // rows whose ownership can't be verified. (Round 2's "showing your own
  // appointments only" fallback is gone — it silently narrowed scope
  // instead of surfacing the failure.) It also has to run before the
  // assignee filter can be resolved at all now (round 9), so it can no
  // longer be skipped by an appointments-fetch failure the way it used to.
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
  const rosterIds = new Set(rosterResult.roster.map((entry) => entry.id));

  const assigneeId = resolveAssigneeId(
    viewerRole,
    params.assignee,
    user.id,
    rosterIds,
  );
  const scopeDescription =
    assigneeId === undefined
      ? "All team appointments."
      : assigneeId === user.id
        ? "Your appointments."
        : `Appointments assigned to ${assignees[assigneeId] ?? "the selected teammate"}.`;

  const prefs = await loadIntegrationPrefs(supabase, user.id);
  const timezone = prefs.timezone;
  const requestNow = new Date();
  const nowMs = requestNow.getTime();
  const todayKey = todayDateKeyInZone(timezone, requestNow);

  // Month view always resolves a fixed six-week grid. Its single-snapshot
  // RPC enforces the existing cap independently for every week rather than
  // stretching a week-sized limit over the whole 42-day range.
  const monthAnchor = params.month ? `${params.month}-01` : params.week;
  const monthRange =
    view === "month" ? resolveMonth(monthAnchor, timezone, requestNow) : null;
  const { weekStartDate, days } =
    monthRange ?? resolveWeek(params.week, timezone, requestNow);
  const monthKey = monthRange?.monthKey ?? null;
  const currentWeekStart = resolveWeek(
    todayKey,
    timezone,
    requestNow,
  ).weekStartDate;
  const isCurrentPeriod =
    view === "month"
      ? monthKey === todayKey.slice(0, 7)
      : weekStartDate === currentWeekStart;
  const weekStartUtc = days[0].startUtc;
  const weekEndUtc = days[days.length - 1].endUtc;

  // Month view supplies six adjacent weekly windows to one RPC statement:
  // per-week caps stay intact without assembling six different snapshots.
  const appointmentsResult =
    view === "month"
      ? await fetchCalendarAppointmentsForWindows(orgId, {
          assigneeId,
          windows: Array.from({ length: days.length / 7 }, (_, w) => ({
            startUtc: days[w * 7].startUtc,
            endUtc: days[w * 7 + 6].endUtc,
          })),
        })
      : await fetchCalendarAppointments(orgId, {
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

  // Codex round 4 — the roster (`assignees`, active memberships only) is
  // NOT the full set of ids that can show up on an appointment row: a
  // teammate suspended/removed after being assigned an appointment still
  // owns that row, and dropping their label would misattribute it (silent
  // "no owner shown" on a real row) instead of degrading gracefully. Build
  // a superset label map — active roster + a resolved-or-fallback label
  // for every OTHER assignee_id actually referenced in this week's rows —
  // and keep it entirely separate from `assignees`, which stays
  // roster-only so the filter never offers a former teammate as an option.
  const inactiveAssigneeIds = Array.from(
    new Set(
      appointments
        .map((appt) => appt.assignee_id)
        .filter((id) => !rosterIds.has(id)),
    ),
  );
  const inactiveEmails =
    inactiveAssigneeIds.length > 0
      ? await fetchAssigneeEmails(inactiveAssigneeIds)
      : {};
  const assigneeLabels: Record<string, string> = { ...assignees };
  for (const id of inactiveAssigneeIds) {
    assigneeLabels[id] =
      inactiveEmails[id] ?? `Former teammate (${id.slice(0, 8)})`;
  }

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Calendar" }]}
        title="Calendar"
        description={scopeDescription}
        actions={
          <div className="ml-auto text-right">
            <div
              className="text-[26px] leading-[1.1] font-black tracking-[-0.02em] whitespace-nowrap"
              data-testid="calendar-range-label"
            >
              {view === "month" && monthKey
                ? monthYearLabel(`${monthKey}-01`)
                : monthYearLabel(days[0].date)}
            </div>
            {view !== "month" ? (
              <div className="text-muted-foreground mt-0.5 text-xs font-bold whitespace-nowrap">
                {weekRangeLabel(days)}
              </div>
            ) : null}
          </div>
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
        month={monthKey}
        isCurrentPeriod={isCurrentPeriod}
        days={days}
        appointments={appointments}
        timezone={timezone}
        viewerRole={viewerRole}
        assignees={assignees}
        assigneeLabels={assigneeLabels}
        currentUserId={user.id}
        nowMs={nowMs}
        todayKey={todayKey}
      />
    </Page>
  );
}
