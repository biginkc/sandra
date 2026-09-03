import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadOrgTeamMembers } from "@/lib/auth/team-roster";
import { teamMemberOptionLabel } from "@/lib/auth/team-member";

import type { CalendarAppointmentRow } from "./types";

/**
 * Discriminated result so a query failure is never indistinguishable from a
 * genuinely empty week (Codex round 2 — the previous signature coerced
 * both to `[]`, which made the calendar silently render "no appointments
 * this week" on a DB error). `page.tsx` renders an explicit retry state on
 * `{ ok: false }` and only shows the empty-week UI for `{ ok: true, rows: [] }`.
 */
export type FetchCalendarAppointmentsResult =
  { ok: true; rows: CalendarAppointmentRow[] } | { ok: false };

/**
 * Loads open + completed appointment-type tasks whose `due_at` falls in
 * `[weekStartUtc, weekEndUtc)` through the same single-snapshot RPC the month
 * view uses. One implementation now owns status/chain visibility, joins,
 * ordering, and fail-closed volume caps for both Calendar views.
 *
 * `orgId` is an explicit filter, not just RLS: this query is called from
 * the org-wide owner view where `assigneeId` is unset, so RLS's
 * membership-scoping alone isn't enough to pin the result to one org —
 * the caller (page.tsx) already resolved `orgId` via `requireOrgMembership`.
 *
 * Cancelled appointments are excluded (lifecycle policy — cancel closes
 * the task with a terminal status other than 'open'/'completed', and the
 * calendar surface never shows them).
 *
 * The RPC evaluates the one week window and its cap inside one Postgres
 * statement. It also suppresses completed/rescheduled predecessors only when
 * a cancelled row exists in the same org+chain, without rewriting audit rows.
 */
export async function fetchCalendarAppointments(
  orgId: string,
  opts: {
    assigneeId?: string;
    weekStartUtc: string;
    weekEndUtc: string;
  },
): Promise<FetchCalendarAppointmentsResult> {
  return fetchCalendarAppointmentsForWindows(orgId, {
    assigneeId: opts.assigneeId,
    windows: [{ startUtc: opts.weekStartUtc, endUtc: opts.weekEndUtc }],
  });
}

/**
 * One roster entry: an active or former membership id paired with a
 * human-readable label. Former members remain filterable so their existing
 * appointments never become unreachable.
 */
export type OrgRosterEntry = { id: string; label: string };

/**
 * Full membership roster for `orgId` — used to populate the
 * calendar's assignee filter (and per-appointment assignee labels)
 * independently of which appointments happen to fall in the displayed
 * week (Codex round 1 — the previous roster was built only from the
 * current week's `appointments` + the caller, so a teammate with zero
 * appointments this week silently dropped out of the filter).
 *
 * Codex round 3 — identity and labels are two different failure domains,
 * and they used to be conflated:
 *
 * - IDENTITY = the `memberships` query (who is actually on this org's
 *   roster). This is load-bearing: `page.tsx` uses it for the assignee
 *   filter's set of valid ids AND (indirectly, via the appointments query)
 *   for ownership attribution. If this fails, `ok: false` — there is no
 *   safe partial roster to fall back to, so the caller must treat it like
 *   any other load failure, not silently narrow to "just me."
 * - LABELS = the authoritative display name (with email fallback) from
 *   `auth.users`. This is cosmetic. If that lookup fails or is partial, no
 *   identity is dropped and no UUID fragment is exposed; the safe fallback
 *   is "Name not set" and `labelsDegraded` lets the caller explain why.
 *
 * Unlike an assignment picker, this filter includes inactive memberships.
 * That is deliberate: records owned by a former teammate must remain
 * reachable even though that teammate can no longer receive new work.
 */
export type FetchOrgRosterResult =
  | { ok: true; roster: OrgRosterEntry[]; labelsDegraded: boolean }
  | { ok: false };

// Single statement, single snapshot — same rationale as
// `APPOINTMENTS_CAP` above: a membership add/remove between page requests
// could desync a multi-page keyset load exactly like a reschedule desyncs
// the appointments one, and a per-org roster is just as naturally bounded.
const ROSTER_CAP = 400; // sentinel-safe under the same 1000-row transport ceiling

export async function fetchOrgRoster(
  orgId: string,
): Promise<FetchOrgRosterResult> {
  let members;
  try {
    members = await loadOrgTeamMembers(orgId, {
      includeInactiveMembers: true,
    });
  } catch (error) {
    console.error("[calendar] fetchOrgRoster failed", { error });
    return { ok: false };
  }

  // The extra (CAP+1)th row came back — the org has more members than the
  // cap covers. Fail closed rather than silently truncate the
  // roster (dropping real teammates from both the filter and ownership
  // attribution would be worse than a visible load failure).
  if (members.length > ROSTER_CAP) {
    console.error("[calendar] fetchOrgRoster exceeded ROSTER_CAP", {
      orgId,
      cap: ROSTER_CAP,
    });
    return { ok: false };
  }

  const labelsDegraded = members.some((member) => !member.displayName);
  const roster: OrgRosterEntry[] = members.map((member) => ({
    id: member.id,
    label: teamMemberOptionLabel(member),
  }));

  return { ok: true, roster, labelsDegraded };
}

/**
 * user_id -> email for every id in `userIds`. `auth.users` isn't
 * RLS-accessible to end-users, so this goes through the admin client's
 * `listUsers`, same pattern as `leads/[id]/page.tsx` (batched, filtered to
 * the ids actually needed rather than building a full-org map when only a
 * handful of assignees are on screen). A lookup failure degrades to an
 * empty map — callers show no email label rather than failing the page.
 */
export async function fetchAssigneeEmails(
  userIds: string[],
): Promise<Record<string, string>> {
  const needed = new Set(userIds);
  const emails: Record<string, string> = {};
  if (needed.size === 0) return emails;

  try {
    const admin = createAdminClient();
    const perPage = 200;
    // Page numbers advance LOCALLY, never from data.nextPage: the installed
    // @supabase/auth-js (2.104.x) mis-parses multi-digit page numbers from
    // the Link header (page 9 reports nextPage=1), which would loop this
    // privileged call forever on projects with 1,800+ users. Termination:
    // short page, every needed identity resolved, or the hard page bound.
    const MAX_AUTH_PAGES = 25; // 25 * 200 = 5,000 users — far beyond this app
    for (let page = 1; page <= MAX_AUTH_PAGES; page++) {
      const { data, error } = await admin.auth.admin.listUsers({
        page,
        perPage,
      });
      if (error) {
        console.error("[calendar] fetchAssigneeEmails failed", {
          message: error.message,
        });
        return emails;
      }
      const users = data?.users ?? [];
      for (const u of users) {
        if (u.email && needed.has(u.id)) emails[u.id] = u.email;
      }
      const allResolved = Object.keys(emails).length >= needed.size;
      if (users.length < perPage || allResolved) break;
    }
  } catch (e) {
    console.error("[calendar] fetchAssigneeEmails threw", { error: e });
  }

  return emails;
}

/**
 * Month-view retrieval, third design (Codex month-view rounds 2+3):
 * a 42-day grid must neither stretch the per-WEEK `APPOINTMENTS_CAP`
 * over six weeks (round 2 — a month at plausible weekly volumes would
 * fail closed while every individual week loads) nor be assembled from
 * per-week SELECTs (round 3 — each statement reads its own snapshot, so
 * an appointment rescheduled mid-fetch between windows can be omitted by
 * every window or returned twice). `fn_calendar_month_appointments`
 * (migration 20260816100000) is a single-statement SECURITY INVOKER SQL
 * function: one snapshot for all windows, the same per-week cap enforced
 * INSIDE that snapshot, plus a total cap kept under PostgREST's 1000-row
 * response ceiling so the result can never be silently truncated in
 * transit. Any breach RAISEs and the month fails closed into the same
 * explicit retry state as week view.
 */
type MonthRpcRow = {
  id: string;
  title: string;
  description: string | null;
  due_at: string;
  end_at: string | null;
  status: string;
  outcome: string | null;
  assignee_id: string;
  related_property_id: string | null;
  contact_id: string | null;
  property_address: string | null;
  property_city: string | null;
  property_state: string | null;
  property_deleted_at: string | null;
  property_is_dnc_locked: boolean | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_entity_name: string | null;
};

type MonthRpcClient = {
  rpc(
    fn: "fn_calendar_month_appointments",
    args: {
      p_org: string;
      p_assignee: string | null;
      p_week_starts: string[];
      p_week_ends: string[];
    },
  ): Promise<{
    data: MonthRpcRow[] | null;
    error: { message: string; code?: string } | null;
  }>;
};

export async function fetchCalendarAppointmentsForWindows(
  orgId: string,
  opts: {
    assigneeId?: string;
    windows: { startUtc: string; endUtc: string }[];
  },
): Promise<FetchCalendarAppointmentsResult> {
  const supabase = await createClient();
  const { data, error } = await (supabase as unknown as MonthRpcClient).rpc(
    "fn_calendar_month_appointments",
    {
      p_org: orgId,
      p_assignee: opts.assigneeId ?? null,
      p_week_starts: opts.windows.map((w) => w.startUtc),
      p_week_ends: opts.windows.map((w) => w.endUtc),
    },
  );

  if (error || !data) {
    if (error) {
      console.error("[calendar] fetchCalendarAppointmentsForWindows failed", {
        message: error.message,
        code: error.code,
      });
    }
    return { ok: false };
  }

  // Same shaping rules as the week path's PostgREST-join mapping —
  // property linkage only counts when the property is alive and
  // addressable; contact display name prefers entity_name.
  const rows: CalendarAppointmentRow[] = data.map((row) => {
    const propertyLinked = Boolean(
      row.related_property_id &&
      row.property_deleted_at === null &&
      row.property_address &&
      row.property_state,
    );
    const contactName =
      row.contact_entity_name ??
      ([row.contact_first_name, row.contact_last_name]
        .filter(Boolean)
        .join(" ") ||
        null);
    return {
      id: row.id,
      title: row.title,
      description: row.description ?? null,
      due_at: row.due_at,
      end_at: row.end_at ?? row.due_at,
      status: row.status,
      outcome: row.outcome ?? null,
      assignee_id: row.assignee_id,
      property_id: propertyLinked ? row.related_property_id : null,
      address: propertyLinked ? row.property_address : null,
      city: propertyLinked ? row.property_city : null,
      state: propertyLinked ? row.property_state : null,
      contact_id: row.contact_id,
      contact_name: row.contact_id ? contactName : null,
      is_dnc_locked: row.property_is_dnc_locked === true,
    };
  });

  return { ok: true, rows };
}
