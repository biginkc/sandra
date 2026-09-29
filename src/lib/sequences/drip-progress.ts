import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { dripStatus, pauseReasonText, type DripStatus } from "./drip-status";

export type DripProgress = {
  propertyId: string;
  enrollmentId: string;
  sequenceId: string;
  sequenceName: string;
  step: number;
  totalSteps: number;
  nextTextAt: string | null;
  lastText: { sentAt: string; preview: string } | null;
  status: DripStatus;
  reason: string | null;
};

const CHUNK_SIZE = 100;
function chunks<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK_SIZE) result.push(items.slice(i, i + CHUNK_SIZE));
  return result;
}
function assertQuery(error: { message: string } | null, table: string): void {
  if (error) throw new Error(`Could not read ${table}: ${error.message}`);
}

/** Read-only, RLS-scoped progress for the most relevant enrollment per lead. */
export async function listDripProgress(client: SupabaseClient<Database>, propertyIds: string[]): Promise<DripProgress[]> {
  const ids = [...new Set(propertyIds)];
  if (!ids.length) return [];
  const enrollments: Database["public"]["Tables"]["sequence_enrollments"]["Row"][] = [];
  for (const batch of chunks(ids)) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await client.from("sequence_enrollments")
        .select("id, property_id, sequence_id, status, pause_reason, current_step_index, next_run_at, enrolled_at, completed_at")
        .in("property_id", batch).order("id").range(offset, offset + 999);
      assertQuery(error, "sequence enrollments");
      enrollments.push(...(data ?? []) as typeof enrollments);
      if (!data || data.length < 1000) break;
    }
  }
  if (!enrollments.length) return [];
  const selected = new Map<string, (typeof enrollments)[number]>();
  for (const enrollment of enrollments) {
    const prior = selected.get(enrollment.property_id);
    const live = (status: string) => status === "active" || status === "paused";
    if (!prior || (live(enrollment.status) && !live(prior.status)) ||
      (live(enrollment.status) === live(prior.status) && enrollment.enrolled_at > prior.enrolled_at)) {
      selected.set(enrollment.property_id, enrollment);
    }
  }
  const chosen = [...selected.values()];
  const sequenceIds = [...new Set(chosen.map((row) => row.sequence_id))];
  const names = new Map<string, string>();
  const stepsBySequence = new Map<string, Array<{ step_index: number; action_type: string; delay_after_previous_minutes: number }>>();
  for (const batch of chunks(sequenceIds)) {
    const sequences = await client.from("sequences").select("id, name").in("id", batch);
    assertQuery(sequences.error, "sequences");
    for (const sequence of sequences.data ?? []) names.set(sequence.id, sequence.name);
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await client.from("sequence_steps")
        .select("id, sequence_id, step_index, action_type, delay_after_previous_minutes")
        .in("sequence_id", batch).order("id").range(offset, offset + 999);
      assertQuery(error, "sequence steps");
      for (const step of data ?? []) {
        const own = stepsBySequence.get(step.sequence_id) ?? [];
        own.push(step);
        stepsBySequence.set(step.sequence_id, own);
      }
      if (!data || data.length < 1000) break;
    }
  }
  const runs: Array<{ enrollment_id: string; message_id: string | null; run_at: string | null }> = [];
  for (const batch of chunks(chosen.map((row) => row.id))) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await client.from("sequence_step_runs")
        .select("id, enrollment_id, message_id, run_at").in("enrollment_id", batch).order("id").range(offset, offset + 999);
      assertQuery(error, "sequence runs");
      runs.push(...data ?? []);
      if (!data || data.length < 1000) break;
    }
  }
  const lastRunAt = new Map<string, string>();
  for (const run of runs) if (run.run_at && (!lastRunAt.has(run.enrollment_id) || run.run_at > lastRunAt.get(run.enrollment_id)!)) lastRunAt.set(run.enrollment_id, run.run_at);
  const messages = new Map<string, { body: string; created_at: string; sent_at: string | null }>();
  for (const batch of chunks([...new Set(runs.flatMap((run) => run.message_id ? [run.message_id] : []))])) {
    const { data, error } = await client.from("messages").select("id, body, created_at, sent_at").in("id", batch);
    assertQuery(error, "sent texts");
    for (const message of data ?? []) messages.set(message.id, message);
  }
  const canceled = new Set<string>();
  for (const batch of chunks(chosen.filter((row) => row.status === "completed").map((row) => row.property_id))) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await client.from("lead_events").select("property_id, event_type, payload")
        .in("property_id", batch).eq("event_type", "sequence_canceled").range(offset, offset + 999);
      assertQuery(error, "lead events");
      for (const event of data ?? []) if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) && typeof event.payload.enrollment_id === "string") canceled.add(event.payload.enrollment_id);
      if (!data || data.length < 1000) break;
    }
  }
  const repliedAfterLast = new Set<string>();
  const completed = chosen.filter((row) => row.status === "completed" && !canceled.has(row.id) && lastRunAt.has(row.id));
  for (const batch of chunks(completed)) {
    const earliest = batch.reduce((min, row) => {
      const at = lastRunAt.get(row.id)!;
      return at < min ? at : min;
    }, lastRunAt.get(batch[0].id)!);
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await client.from("messages").select("property_id, created_at")
        .in("property_id", batch.map((row) => row.property_id)).eq("direction", "inbound")
        .gt("created_at", earliest).range(offset, offset + 999);
      assertQuery(error, "inbound replies");
      for (const message of data ?? []) for (const row of batch) {
        if (message.property_id === row.property_id && message.created_at > lastRunAt.get(row.id)!) repliedAfterLast.add(row.id);
      }
      if (!data || data.length < 1000) break;
    }
  }
  return chosen.map((row) => {
    const lastSent = runs.filter((run) => run.enrollment_id === row.id && run.message_id && run.run_at && messages.get(run.message_id)?.sent_at)
      .sort((a, b) => b.run_at!.localeCompare(a.run_at!))[0];
    const message = lastSent?.message_id ? messages.get(lastSent.message_id) : null;
    const steps = (stepsBySequence.get(row.sequence_id) ?? []).sort((a, b) => a.step_index - b.step_index);
    const textSteps = steps.filter((step) => step.action_type === "send_sms");
    const totalSteps = textSteps.length;
    const step = Math.min(totalSteps, Math.max(1, textSteps.filter((item) => item.step_index <= row.current_step_index).length));
    const nextText = steps.find((item) => item.step_index >= row.current_step_index && item.action_type === "send_sms");
    const delay = nextText && row.next_run_at ? steps.filter((item) => item.step_index > row.current_step_index && item.step_index <= nextText.step_index)
      .reduce((sum, item) => sum + item.delay_after_previous_minutes, 0) : 0;
    return {
      propertyId: row.property_id,
      enrollmentId: row.id,
      sequenceId: row.sequence_id,
      sequenceName: names.get(row.sequence_id) ?? "Drip",
      step: totalSteps ? step : 0,
      totalSteps,
      nextTextAt: row.status === "active" && nextText && row.next_run_at ? new Date(new Date(row.next_run_at).getTime() + delay * 60_000).toISOString() : null,
      lastText: message?.sent_at ? { sentAt: message.sent_at, preview: message.body.replace(/\s+/g, " ").trim().slice(0, 100) } : null,
      status: dripStatus(row.status, row.pause_reason, canceled.has(row.id), repliedAfterLast.has(row.id)),
      reason: pauseReasonText(row.pause_reason),
    };
  });
}
