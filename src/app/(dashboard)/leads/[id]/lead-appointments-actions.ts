"use server";

import { createClient } from "@/lib/supabase/server";
import {
  LEAD_APPOINTMENT_COLUMNS,
  LEAD_APPOINTMENT_HISTORY_PAGE_SIZE,
  type LeadAppointmentCursor,
  type LeadAppointmentRow,
} from "@/lib/leads/lead-appointments";

export type LeadAppointmentHistoryResult =
  | {
      ok: true;
      rows: LeadAppointmentRow[];
      hasMore: boolean;
      cursor: LeadAppointmentCursor | null;
    }
  | { ok: false; message: string };

/**
 * One page of finished (completed / cancelled) appointment and callback tasks
 * for a lead, newest first. Reads under the caller's own RLS.
 */
export async function loadLeadAppointmentHistory(
  propertyId: string,
  cursor: LeadAppointmentCursor | null = null,
): Promise<LeadAppointmentHistoryResult> {
  const failure = {
    ok: false as const,
    message: "Appointment history could not be loaded. Retry.",
  };
  try {
    // The cursor is interpolated into a PostgREST filter; accept only a
    // timestamptz as PostgREST returns it, and a UUID. The string is passed
    // through unchanged so sub-millisecond precision is not lost at the page
    // boundary.
    const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      !UUID.test(propertyId) ||
      (cursor &&
        (!UUID.test(cursor.id) || !TIMESTAMP.test(cursor.dueAt)))
    ) {
      return failure;
    }
    const safeDueAt = cursor ? cursor.dueAt : null;
    const supabase = await createClient();
    let query = supabase
      .from("tasks")
      .select(LEAD_APPOINTMENT_COLUMNS)
      .eq("related_property_id", propertyId)
      .in("type", ["appointment", "callback", "follow_up"])
      .in("status", ["completed", "cancelled"])
      .order("due_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(LEAD_APPOINTMENT_HISTORY_PAGE_SIZE + 1);
    if (cursor) {
      query = query.or(
        `due_at.lt."${safeDueAt}",and(due_at.eq."${safeDueAt}",id.lt."${cursor.id}")`,
      );
    }
    const { data, error } = await query;
    if (error || !data) return failure;
    const all = data as unknown as LeadAppointmentRow[];
    const rows = all.slice(0, LEAD_APPOINTMENT_HISTORY_PAGE_SIZE);
    const last = rows.at(-1);
    const hasMore = all.length > LEAD_APPOINTMENT_HISTORY_PAGE_SIZE;
    return {
      ok: true,
      rows,
      hasMore,
      cursor: hasMore && last ? { dueAt: last.due_at, id: last.id } : null,
    };
  } catch {
    return failure;
  }
}
