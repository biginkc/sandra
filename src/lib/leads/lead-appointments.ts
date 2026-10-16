export const LEAD_APPOINTMENT_HISTORY_PAGE_SIZE = 20;

export type LeadAppointmentRow = {
  id: string;
  title: string;
  /** ISO timestamptz */
  due_at: string;
  end_at: string | null;
  assignee_id: string;
  type: "appointment" | "callback" | "follow_up";
  status: "open" | "snoozed" | "completed" | "cancelled";
  outcome: string | null;
};

export type LeadAppointmentCursor = { dueAt: string; id: string };

export const LEAD_APPOINTMENT_COLUMNS =
  "id, title, due_at, end_at, assignee_id, type, status, outcome";

const LIVE_STATUSES = new Set(["open", "snoozed"]);

export function isLiveAppointment(row: Pick<LeadAppointmentRow, "status">) {
  return LIVE_STATUSES.has(row.status);
}

/**
 * Same rule as the My Leads detail panel: lifecycle controls only for
 * open/snoozed work, and only for the task's assignee or an org owner.
 */
export function canActOnLeadAppointment(
  row: Pick<LeadAppointmentRow, "status" | "assignee_id">,
  viewerId: string | null,
  viewerIsOwner: boolean,
) {
  if (!isLiveAppointment(row) || !viewerId) return false;
  return row.assignee_id === viewerId || viewerIsOwner;
}

export function groupLeadAppointments(
  live: LeadAppointmentRow[],
  nowMs: number,
) {
  const byDue = (a: LeadAppointmentRow, b: LeadAppointmentRow) =>
    new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
  const liveRows = live.filter(isLiveAppointment);
  return {
    upcoming: liveRows.filter((r) => new Date(r.due_at).getTime() > nowMs).sort(byDue),
    pastDue: liveRows.filter((r) => new Date(r.due_at).getTime() <= nowMs).sort(byDue),
  };
}

/** Owner of the lead's own org — an owner role in another org does not count. */
export function isLeadOrgOwner(
  memberships: ReadonlyArray<{ user_id: string; org_id: string; role: string }>,
  viewerId: string | null | undefined,
  leadOrgId: string,
) {
  return memberships.some(
    (m) => m.user_id === viewerId && m.org_id === leadOrgId && m.role === "owner",
  );
}
