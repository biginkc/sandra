import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

export function formatMessageDripLabel(name: string, text: number, total: number): string | null {
  return text > 0 && total > 0 ? `Drip · ${name} · text ${text} of ${total}` : null;
}

/** RLS-scoped labels, linked only through durable step runs (never inferred from message text). */
export async function messageDripLabels(client: SupabaseClient<Database>, messageIds: string[]): Promise<Record<string, string>> {
  const ids = [...new Set(messageIds)];
  if (!ids.length) return {};
  const runs: Array<{ message_id: string | null; step_id: string }> = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await client.from("sequence_step_runs").select("message_id, step_id").in("message_id", ids.slice(i, i + 100));
    if (error) throw error;
    runs.push(...(data ?? []));
  }
  if (!runs.length) return {};
  const stepIds = [...new Set(runs.map((run) => run.step_id))];
  const sentSteps: Array<{ id: string; sequence_id: string; step_index: number }> = [];
  for (let i = 0; i < stepIds.length; i += 100) {
    const { data, error } = await client.from("sequence_steps").select("id, sequence_id, step_index").in("id", stepIds.slice(i, i + 100));
    if (error) throw error;
    sentSteps.push(...(data ?? []));
  }
  const sequenceIds = [...new Set(sentSteps.map((step) => step.sequence_id))];
  const allSteps: Array<{ id: string; sequence_id: string; step_index: number; action_type: string }> = [];
  const names: Record<string, string> = {};
  for (let i = 0; i < sequenceIds.length; i += 100) {
    const batch = sequenceIds.slice(i, i + 100);
    const [steps, sequences] = await Promise.all([
      client.from("sequence_steps").select("id, sequence_id, step_index, action_type").in("sequence_id", batch),
      client.from("sequences").select("id, name").in("id", batch),
    ]);
    if (steps.error) throw steps.error;
    if (sequences.error) throw sequences.error;
    allSteps.push(...(steps.data ?? []));
    for (const sequence of sequences.data ?? []) names[sequence.id] = sequence.name;
  }
  const stepCountBySequence = new Map<string, number>();
  for (const step of allSteps) stepCountBySequence.set(step.sequence_id, (stepCountBySequence.get(step.sequence_id) ?? 0) + 1);
  const stepsById = new Map(sentSteps.map((step) => [step.id, step]));
  const labels: Record<string, string> = {};
  for (const run of runs) {
    if (!run.message_id) continue;
    const step = stepsById.get(run.step_id);
    if (!step) continue;
    const label = formatMessageDripLabel(names[step.sequence_id] ?? "Drip", step.step_index + 1, stepCountBySequence.get(step.sequence_id) ?? 0);
    if (label) labels[run.message_id] = label;
  }
  return labels;
}
