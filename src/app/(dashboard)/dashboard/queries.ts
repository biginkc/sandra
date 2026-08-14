import { createClient } from "@/lib/supabase/server";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import { type SendilloSmsHealthResult } from "@/lib/messages/sendillo-health";
import { getStoredSendilloSmsHealth } from "@/lib/messages/sendillo-health-snapshot";
import { getDayBoundsInZone } from "@/lib/time/zoned";

export type AssignedRow = {
  user_id: string;
  count: number;
};

export type ThreadRow = {
  property_id: string;
  address: string;
  city: string | null;
  state: string;
  last_ai_escalation_at: string | null;
  last_ai_escalation_reason: string | null;
  homeowner_first_name: string | null;
  homeowner_last_name: string | null;
  homeowner_entity_name: string | null;
};

export type ActivityRow =
  | {
      kind: "inbound_message";
      at: string;
      property_id: string | null;
      address: string | null;
      city: string | null;
      state: string | null;
      preview: string;
    }
  | {
      kind: "sequence_completed";
      at: string;
      property_id: string;
      sequence_name: string;
    }
  | {
      kind: "skip_trace_done";
      at: string;
      /** Added in migration 028 — lets the activity feed deep-link to
       *  /jobs/<id> instead of /jobs (the list). */
      job_id: string;
      job_type: string;
      job_status: string;
    }
  | {
      kind: "import_done";
      at: string;
      /** Added in migration 028 — see skip_trace_done note above. */
      job_id: string;
      job_type: string;
      job_status: string;
    }
  | {
      kind: "ai_escalation";
      at: string;
      property_id: string;
      address: string | null;
      city: string | null;
      state: string | null;
      reason: string | null;
    };

export type TaskRow = {
  id: string;
  type: string;
  title: string;
  /** ISO timestamptz */
  due_at: string;
  /** ISO timestamptz — appointment-only (PR 1 CHECK ties this to
   *  type='appointment'); null for every other task type. Drives the
   *  compact time-range subtitle on appointment rows. */
  end_at: string | null;
  /** Null for personal blocks and contact-only appointments — no property
   *  attached. Address/city/state are null exactly when this is null. */
  property_id: string | null;
  /** Set on contact-only rows (no property) so the panel can link to the
   *  Messages thread instead. */
  contact_id: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
};

export type DashboardSummary = {
  total_leads: number;
  new_this_week: number;
  not_in_drip: number;
  hot_leads: { numerator: number; denominator: number };
  skip_trace_coverage: { numerator: number; denominator: number };
  assigned: AssignedRow[];
  needs_attention: {
    escalated_unhandled: number;
    stale_conversations: number;
    sequence_ended_no_followup: number;
    unassigned: number;
  };
  threads_needing_attention: ThreadRow[];
  recent_activity: ActivityRow[];
};

export async function fetchDashboardSummary(): Promise<DashboardSummary | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("dashboard_summary");
  if (error) {
    // PostgrestError has non-enumerable props that JSON.stringify hides;
    // unpack the fields explicitly so log lines are useful in Vercel.
    console.error("[dashboard] dashboard_summary RPC failed", {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    });
    return null;
  }
  return data as unknown as DashboardSummary;
}

export async function fetchDashboardSendilloSmsHealth(): Promise<SendilloSmsHealthResult> {
  const supabase = await createClient();
  return getStoredSendilloSmsHealth(supabase);
}

/**
 * Loads the viewer's open tasks split into Overdue / Today / Upcoming
 * buckets, in the assignee's own timezone.
 *
 * Overdue = due_at before the assignee's zone-local day start (status is
 * already 'open' — everything returned by this query is, by filter).
 * Today = due_at within the assignee's zone-local day.
 * Upcoming = due_at on or after the assignee's zone-local tomorrow.
 *
 * Day boundaries come from getDayBoundsInZone, which does the DST-safe
 * wall-time math; the zone itself is the assignee's
 * user_integration_prefs.timezone (loadIntegrationPrefs already falls
 * back to "America/Chicago" when unset).
 *
 * The property join is now a LEFT join — appointment-type tasks may have
 * no related_property_id (personal blocks, contact-only appointments),
 * so a property-less row is legitimate, not an error. property_id/
 * address/city/state come back null together in that case.
 *
 * Returns empty buckets on error rather than null — the panel renders
 * the all-clear empty state, which is a reasonable failure mode.
 */
export async function fetchMyTasks(userId: string): Promise<{
  overdue: TaskRow[];
  today: TaskRow[];
  upcoming: TaskRow[];
  /** The zone the buckets were computed in — the panel must format due
   *  labels with this same zone or labels and buckets can disagree. */
  timezone: string;
}> {
  const supabase = await createClient();
  const prefs = await loadIntegrationPrefs(supabase, userId);
  const { dayStart, dayEnd } = getDayBoundsInZone(new Date(), prefs.timezone);

  let { data, error } = await supabase
    .from("tasks")
    .select(
      "id, type, title, due_at, end_at, related_property_id, contact_id, properties(address, city, state, deleted_at)",
    )
    .eq("assignee_id", userId)
    .eq("status", "open")
    .order("due_at", { ascending: true });

  // Post-deploy pre-migration window: contact_id/end_at don't exist yet
  // and Postgres answers 42703 (undefined column). Retry with the legacy
  // column list rather than hiding every task behind the "all caught up"
  // empty state; both map to null (no appointment rows can exist before
  // the schema does).
  if (error?.code === "42703") {
    const legacy = await supabase
      .from("tasks")
      .select(
        "id, type, title, due_at, related_property_id, properties(address, city, state, deleted_at)",
      )
      .eq("assignee_id", userId)
      .eq("status", "open")
      .order("due_at", { ascending: true });
    error = legacy.error;
    data =
      legacy.data?.map((row) => ({ ...row, contact_id: null, end_at: null })) ??
      null;
  }

  if (error || !data) {
    if (error) {
      console.error("[dashboard] fetchMyTasks failed", {
        message: error.message,
        code: error.code,
      });
    }
    return { overdue: [], today: [], upcoming: [], timezone: prefs.timezone };
  }

  const dayStartMs = dayStart.getTime();
  const dayEndMs = dayEnd.getTime();

  const overdue: TaskRow[] = [];
  const today: TaskRow[] = [];
  const upcoming: TaskRow[] = [];

  for (const row of data) {
    // The left join returns null for property-less tasks (expected —
    // personal blocks / contact-only appointments), plus soft-deleted or
    // malformed property rows, both of which we also degrade to "no
    // property" rather than dropping the task entirely.
    const prop = row.properties as unknown as {
      address: string | null;
      city: string | null;
      state: string | null;
      deleted_at: string | null;
    } | null;
    const propertyLinked = Boolean(
      prop && prop.deleted_at === null && prop.address && prop.state,
    );

    const taskRow: TaskRow = {
      id: row.id,
      type: row.type,
      title: row.title,
      due_at: row.due_at,
      end_at: row.end_at ?? null,
      property_id: propertyLinked ? row.related_property_id : null,
      contact_id: row.contact_id,
      address: propertyLinked ? (prop!.address ?? null) : null,
      city: propertyLinked ? (prop!.city ?? null) : null,
      state: propertyLinked ? (prop!.state ?? null) : null,
    };

    const dueMs = new Date(row.due_at).getTime();
    if (dueMs < dayStartMs) {
      overdue.push(taskRow);
    } else if (dueMs < dayEndMs) {
      today.push(taskRow);
    } else {
      upcoming.push(taskRow);
    }
  }

  return { overdue, today, upcoming, timezone: prefs.timezone };
}
