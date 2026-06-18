import { createClient } from "@/lib/supabase/server";
import {
  EMPTY_SENDILLO_SMS_HEALTH,
  loadSendilloSmsHealth,
  type SendilloSmsHealth,
  type SendilloSmsHealthResult,
} from "@/lib/messages/sendillo-health";

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
  property_id: string;
  address: string;
  city: string | null;
  state: string;
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

const SENDILLO_HEALTH_CACHE_MS = 5 * 60 * 1000;

let sendilloHealthCache:
  | {
      health: SendilloSmsHealth;
      updatedAt: string;
      expiresAt: number;
    }
  | null = null;

export async function fetchDashboardSendilloSmsHealth(): Promise<SendilloSmsHealthResult> {
  const now = Date.now();
  if (sendilloHealthCache && sendilloHealthCache.expiresAt > now) {
    return {
      status: "available",
      health: sendilloHealthCache.health,
      updatedAt: sendilloHealthCache.updatedAt,
    };
  }

  const supabase = await createClient();
  try {
    const health = await loadSendilloSmsHealth(supabase);
    const updatedAt = new Date(now).toISOString();
    sendilloHealthCache = {
      health,
      updatedAt,
      expiresAt: now + SENDILLO_HEALTH_CACHE_MS,
    };
    return {
      status: "available",
      health,
      updatedAt,
    };
  } catch (error) {
    console.error("[dashboard] Sendillo SMS health failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "unavailable",
      health: EMPTY_SENDILLO_SMS_HEALTH,
      message: "Sendillo SMS health unavailable",
    };
  }
}

/**
 * Loads the viewer's open tasks split into Today / Upcoming buckets.
 *
 * Today = due_at on the current calendar day (server timezone, which is
 * UTC on Vercel — adequate for the dashboard panel; per-user timezone
 * support lands with the V2 Calendar integration when we already need
 * timezone resolution for event creation).
 *
 * Upcoming = due_at strictly after today (the partial index on
 * (assignee_id, due_at) WHERE status='open' covers this filter).
 *
 * Returns empty buckets on error rather than null — the panel renders
 * the all-clear empty state, which is a reasonable failure mode.
 */
export async function fetchMyTasks(
  userId: string,
): Promise<{ today: TaskRow[]; upcoming: TaskRow[] }> {
  const supabase = await createClient();
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from("tasks")
    .select(
      "id, type, title, due_at, related_property_id, properties!inner(address, city, state, deleted_at)",
    )
    .eq("assignee_id", userId)
    .eq("status", "open")
    .gte("due_at", todayStart.toISOString())
    .order("due_at", { ascending: true });

  if (error || !data) {
    if (error) {
      console.error("[dashboard] fetchMyTasks failed", {
        message: error.message,
        code: error.code,
      });
    }
    return { today: [], upcoming: [] };
  }

  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);
  const tomorrowMs = tomorrowStart.getTime();

  const today: TaskRow[] = [];
  const upcoming: TaskRow[] = [];

  for (const row of data) {
    // Drop tasks whose property has been soft-deleted — the !inner join
    // already excluded properties without a row, but `deleted_at IS NULL`
    // can't ride along an !inner select shorthand, so we filter in JS.
    const prop = row.properties as unknown as {
      address: string | null;
      city: string | null;
      state: string | null;
      deleted_at: string | null;
    } | null;
    if (!prop || prop.deleted_at !== null) continue;
    if (!prop.address || !prop.state) continue;

    const taskRow: TaskRow = {
      id: row.id,
      type: row.type,
      title: row.title,
      due_at: row.due_at,
      property_id: row.related_property_id,
      address: prop.address,
      city: prop.city,
      state: prop.state,
    };

    const dueMs = new Date(row.due_at).getTime();
    if (dueMs < tomorrowMs) {
      today.push(taskRow);
    } else {
      upcoming.push(taskRow);
    }
  }

  return { today, upcoming };
}
