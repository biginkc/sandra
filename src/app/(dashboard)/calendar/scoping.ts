import type { CalendarViewerRole } from "./types";

/**
 * Resolves the `assigneeId` filter passed to `fetchCalendarAppointments`
 * from the raw `?assignee=` param. Pulled into its own module (rather than
 * living inline in page.tsx) so it's unit-testable without dragging in the
 * page's server-only import chain (`next/headers`, Supabase clients, etc).
 *
 * Scoping (plan contract reactive-puzzling-crane v9, decision 7 — "VA
 * member: own items" is a DEFAULT, not a lockout). PR 2/3's assignee-select
 * + `dispatchTaskAssigned`/Slack-notify design (Codex-approved) deliberately
 * supports cross-user booking — a VA booking an appointment on a
 * teammate's behalf is the primary business pattern — so a member who can
 * book for a teammate must also be able to see what they booked; hard-
 * pinning the view to "own items only" contradicted the booking design it
 * sits next to. Every viewer's explicit `?assignee=` is honored the same
 * way regardless of role (same org; RLS plus the explicit `orgId` already
 * passed into `fetchCalendarAppointments` scope visibility, so there's no
 * additional exposure in letting a member ask for a teammate or "all").
 * Only the no-param DEFAULT differs by role: owner defaults to org-wide,
 * member defaults to their own items.
 *
 * `"me"` and `"all"` are explicit sentinels (not just "param absent") so
 * the calendar filter's "Everyone" selection can round-trip through the
 * URL for a member without being indistinguishable from "no param" (whose
 * meaning differs by role) — see `CalendarView`'s `onAssigneeChange`.
 */
export function resolveAssigneeId(
  viewerRole: CalendarViewerRole,
  rawAssignee: string | undefined,
  userId: string,
): string | undefined {
  if (rawAssignee === "me") return userId;
  if (rawAssignee === "all") return undefined;
  if (rawAssignee !== undefined) return rawAssignee;
  return viewerRole === "member" ? userId : undefined;
}
