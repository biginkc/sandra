import { createClient } from "@/lib/supabase/server";

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
