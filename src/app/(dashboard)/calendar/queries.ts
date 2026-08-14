import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import type { CalendarAppointmentRow } from "./types";

/**
 * Discriminated result so a query failure is never indistinguishable from a
 * genuinely empty week (Codex round 2 — the previous signature coerced
 * both to `[]`, which made the calendar silently render "no appointments
 * this week" on a DB error). `page.tsx` renders an explicit retry state on
 * `{ ok: false }` and only shows the empty-week UI for `{ ok: true, rows: [] }`.
 */
export type FetchCalendarAppointmentsResult =
  | { ok: true; rows: CalendarAppointmentRow[] }
  | { ok: false };

/**
 * Loads open + completed appointment-type tasks whose `due_at` falls in
 * `[weekStartUtc, weekEndUtc)`, left-joined to `properties` (personal
 * blocks / contact-only appointments legitimately have none — same
 * degrade-not-drop pattern as `dashboard/queries.ts:fetchMyTasks`) and
 * `contacts` (for the display name on contact-only rows).
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
 * Paginates internally with KEYSET pagination (Codex round 5 — `.range()`
 * offset pagination skips/duplicates rows when concurrent writes shift the
 * result set between page requests: a delete before the cursor position
 * shifts every later row left by one, so an offset-based next page
 * re-reads one row and silently drops another). Each page after the first
 * filters strictly beyond the last (due_at, id) tuple already seen instead
 * of trusting a numeric offset, so mutation between page requests can
 * never skip or duplicate a row. See the loop below for why a query
 * failure on ANY page — or exhausting MAX_PAGES on a still-full final
 * page — fails the whole load rather than returning a truncated result.
 */
const APPOINTMENTS_PAGE_SIZE = 1_000;
const MAX_PAGES = 100;

/** Keyset cursor: the (due_at, id) of the last row on the previous page. */
type AppointmentsCursor = { dueAt: string; id: string };

/**
 * PostgREST `.or()` keyset filter for "strictly after (due_at, id)" —
 * same raw-grammar-with-quoted-timestamp shape as
 * `messages/queued-cursor.ts`'s `buildQueuedCursorFilter`. Unlike that
 * cursor, `dueAt`/`id` here are never client input — they come straight
 * off the previous page's own row data — so they don't need that file's
 * closed-form validation against injection; they only need correct
 * PostgREST encoding (ISO timestamp double-quoted so the colons in it
 * can't be misparsed as filter grammar).
 *
 * `due_at` is NOT NULL for `type='appointment'` rows (PR 1 CHECK), so
 * there's no null-tail case to handle (contrast the outbox cursor, whose
 * `scheduled_for` can be null).
 */
function buildAppointmentsKeysetFilter(cursor: AppointmentsCursor): string {
  return (
    `due_at.gt."${cursor.dueAt}",` +
    `and(due_at.eq."${cursor.dueAt}",id.gt.${cursor.id})`
  );
}

function buildAppointmentsQuery(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  opts: { assigneeId?: string; weekStartUtc: string; weekEndUtc: string },
) {
  let query = supabase
    .from("tasks")
    .select(
      "id, title, description, due_at, end_at, status, outcome, assignee_id, related_property_id, contact_id, properties(address, city, state, deleted_at), contacts(first_name, last_name, entity_name)",
    )
    .eq("org_id", orgId)
    .eq("type", "appointment")
    .in("status", ["open", "completed"])
    .gte("due_at", opts.weekStartUtc)
    .lt("due_at", opts.weekEndUtc);

  if (opts.assigneeId) {
    query = query.eq("assignee_id", opts.assigneeId);
  }

  return query;
}

type AppointmentQueryResult = Awaited<ReturnType<typeof buildAppointmentsQuery>>;
type RawAppointmentRow = NonNullable<AppointmentQueryResult["data"]>[number];

export async function fetchCalendarAppointments(
  orgId: string,
  opts: {
    assigneeId?: string;
    weekStartUtc: string;
    weekEndUtc: string;
  },
): Promise<FetchCalendarAppointmentsResult> {
  const supabase = await createClient();

  const allRows: RawAppointmentRow[] = [];

  // Deterministic pagination (Codex round 4): `due_at` alone can tie
  // (multiple appointments in the same minute), so `id` is a secondary
  // sort key giving every page a stable, gap-free cursor — without it,
  // Postgres is free to reorder tied rows between page requests and a row
  // can be silently skipped or duplicated across pages. ANY page failure
  // fails the whole load (`ok: false`) rather than returning a
  // truncated week as if it were complete.
  let cursor: AppointmentsCursor | null = null;
  let complete = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = buildAppointmentsQuery(supabase, orgId, opts);
    if (cursor) {
      query = query.or(buildAppointmentsKeysetFilter(cursor));
    }

    const { data, error } = await query
      .order("due_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(APPOINTMENTS_PAGE_SIZE);

    if (error || !data) {
      if (error) {
        console.error("[calendar] fetchCalendarAppointments failed", {
          message: error.message,
          code: error.code,
        });
      }
      return { ok: false };
    }

    allRows.push(...data);
    if (data.length < APPOINTMENTS_PAGE_SIZE) {
      complete = true;
      break;
    }
    const last = data[data.length - 1] as unknown as {
      due_at: string;
      id: string;
    };
    cursor = { dueAt: last.due_at, id: last.id };
  }

  // MAX_PAGES exhausted with the final page still full — there could be
  // more rows beyond it. Never return that as a truncated success; a
  // pathological org should surface as a load failure, not silent data
  // loss (Codex round 5).
  if (!complete) {
    console.error(
      "[calendar] fetchCalendarAppointments exhausted MAX_PAGES without a short page",
      { orgId, maxPages: MAX_PAGES },
    );
    return { ok: false };
  }

  const rows = allRows.map((row) => {
    const prop = row.properties as unknown as {
      address: string | null;
      city: string | null;
      state: string | null;
      deleted_at: string | null;
    } | null;
    const propertyLinked = Boolean(
      prop && prop.deleted_at === null && prop.address && prop.state,
    );

    const contact = row.contacts as unknown as {
      first_name: string | null;
      last_name: string | null;
      entity_name: string | null;
    } | null;
    const contactName = contact
      ? (contact.entity_name ??
        ([contact.first_name, contact.last_name].filter(Boolean).join(" ") ||
          null))
      : null;

    const appt: CalendarAppointmentRow = {
      id: row.id,
      title: row.title,
      description: row.description ?? null,
      due_at: row.due_at,
      // end_at is always populated for type='appointment' rows (PR 1
      // CHECK) — the `?? row.due_at` is a defensive fallback only, never
      // expected to fire, so the UI can treat this field as non-optional.
      end_at: row.end_at ?? row.due_at,
      status: row.status,
      outcome: row.outcome ?? null,
      assignee_id: row.assignee_id,
      property_id: propertyLinked ? row.related_property_id : null,
      address: propertyLinked ? (prop!.address ?? null) : null,
      city: propertyLinked ? (prop!.city ?? null) : null,
      state: propertyLinked ? (prop!.state ?? null) : null,
      contact_id: row.contact_id,
      contact_name: contactName,
    };
    return appt;
  });

  return { ok: true, rows };
}

/**
 * One roster entry: a real ACTIVE membership `id` (identity, from the
 * `memberships` table) paired with a display `label` that may be a real
 * email or a safe fallback (see `labelsDegraded` below).
 */
export type OrgRosterEntry = { id: string; label: string };

/**
 * Full ACTIVE-membership roster for `orgId` — used to populate the
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
 * - LABELS = the display string for each identity, resolved via
 *   `fetchAssigneeEmails` (the `auth.users` lookup). This is cosmetic. If
 *   `listUsers` errors, throws, paginates only partially, or simply has no
 *   email for a given id, that id is NEVER dropped from the roster — it
 *   keeps its real membership id with a safe fallback label
 *   (`"Teammate (<id-prefix>)"`), and `labelsDegraded` is set so the
 *   caller can show a muted "names unavailable" note. Ownership and
 *   filtering stay correct even when every label falls back, because the
 *   underlying id is still the real one.
 *
 * Reuses the exact active/non-deletion-prepared/unexpired membership
 * predicate `listBookingAssignees` uses
 * (`components/appointments/book-appointment-action.ts`) so "who can be
 * assigned an appointment" and "who shows up in the calendar filter" never
 * disagree.
 */
export type FetchOrgRosterResult =
  | { ok: true; roster: OrgRosterEntry[]; labelsDegraded: boolean }
  | { ok: false };

const ROSTER_PAGE_SIZE = 1_000;

export async function fetchOrgRoster(orgId: string): Promise<FetchOrgRosterResult> {
  const admin = createAdminClient();
  const activeAt = new Date().toISOString();

  const memberships: { user_id: string }[] = [];

  // KEYSET pagination on `user_id` (Codex round 5 — same rationale as the
  // appointments query above: `.range()` offsets skip/duplicate rows when
  // a membership is added or removed between page requests). `user_id` is
  // unique per row here (one active membership per user per org), so a
  // plain `.gt("user_id", cursor)` is enough — no composite tie-break
  // needed. Any page failure, or exhausting MAX_PAGES on a still-full
  // final page, fails the whole roster load (Codex round 4/5: a large
  // org's roster silently truncating would drop real teammates from BOTH
  // the filter and ownership attribution, not just cosmetics).
  let cursor: string | null = null;
  let complete = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let query = admin
      .from("memberships")
      .select("user_id")
      .eq("org_id", orgId)
      .eq("access_status", "active")
      .is("deletion_prepared_at", null)
      .or(`access_expires_at.is.null,access_expires_at.gt.${activeAt}`);
    if (cursor) {
      query = query.gt("user_id", cursor);
    }

    const { data, error } = await query
      .order("user_id", { ascending: true })
      .limit(ROSTER_PAGE_SIZE);

    if (error || !data) {
      if (error) {
        console.error("[calendar] fetchOrgRoster failed (membership identity)", {
          message: error.message,
          code: error.code,
        });
      }
      return { ok: false };
    }

    memberships.push(...data);
    if (data.length < ROSTER_PAGE_SIZE) {
      complete = true;
      break;
    }
    cursor = data[data.length - 1].user_id as string;
  }

  if (!complete) {
    console.error(
      "[calendar] fetchOrgRoster exhausted MAX_PAGES without a short page",
      { orgId, maxPages: MAX_PAGES },
    );
    return { ok: false };
  }

  const ids = memberships.map((m) => m.user_id as string);
  const emails = await fetchAssigneeEmails(ids);
  // Any id whose email didn't come back — whatever the cause (error,
  // throw, partial pagination, or the user simply has none) — is a
  // labels-degraded roster, but the identity is kept with a fallback
  // label rather than dropped.
  const labelsDegraded = ids.some((id) => !emails[id]);

  const roster: OrgRosterEntry[] = ids.map((id) => ({
    id,
    label: emails[id] ?? `Teammate (${id.slice(0, 8)})`,
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
    let page = 1;
    const perPage = 200;
    while (true) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
      if (error) {
        console.error("[calendar] fetchAssigneeEmails failed", {
          message: error.message,
        });
        return emails;
      }
      for (const u of data?.users ?? []) {
        if (u.email && needed.has(u.id)) emails[u.id] = u.email;
      }
      if (!data?.nextPage || (data?.users.length ?? 0) === 0) break;
      page = data.nextPage;
    }
  } catch (e) {
    console.error("[calendar] fetchAssigneeEmails threw", { error: e });
  }

  return emails;
}
