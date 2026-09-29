import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/types";

const MARKER = "SMOKE TEST — safe to delete";

export async function cleanupCanary(
  client: SupabaseClient<Database>, sequenceId: string, canaryUserId: string, fixturePropertyId: string,
): Promise<void> {
  const { data: sequence, error: sequenceError } = await client.from("sequences")
    .select("id, name, created_by").eq("id", sequenceId).maybeSingle();
  if (sequenceError) throw new Error(`Canary lookup: ${sequenceError.message}`);
  if (!sequence) return;
  if (!sequence.name.startsWith(`${MARKER} `) || sequence.created_by !== canaryUserId) {
    throw new Error(`Refusing to clean unowned sequence ${sequenceId}`);
  }
  const { data: enrollments, error: enrollmentError } = await client.from("sequence_enrollments")
    .select("id, property_id").eq("sequence_id", sequenceId);
  if (enrollmentError) throw new Error(`Canary enrollments lookup: ${enrollmentError.message}`);
  if ((enrollments ?? []).some((row) => row.property_id !== fixturePropertyId)) {
    throw new Error(`Refusing cleanup: sequence ${sequenceId} has a non-fixture property`);
  }
  const enrollmentIds = (enrollments ?? []).map((row) => row.id);
  let messageIds: string[] = [];
  if (enrollmentIds.length) {
    const { data: runs, error: runsError } = await client.from("sequence_step_runs")
      .select("message_id").in("enrollment_id", enrollmentIds);
    if (runsError) throw new Error(`Canary step runs lookup: ${runsError.message}`);
    messageIds = [...new Set((runs ?? []).flatMap((row) => row.message_id ? [row.message_id] : []))];
  }
  async function checked(label: string, request: PromiseLike<{ error: { message: string } | null }>) {
    const { error } = await request;
    if (error) throw new Error(`Canary cleanup ${label}: ${error.message}`);
  }
  if (messageIds.length) await checked("messages", client.from("messages").delete().in("id", messageIds));
  await checked("enrollments", client.from("sequence_enrollments").delete().eq("sequence_id", sequenceId));
  await checked("steps", client.from("sequence_steps").delete().eq("sequence_id", sequenceId));
  await checked("sequence", client.from("sequences").delete().eq("id", sequenceId));
}

export async function cleanupAllCanaries(client: SupabaseClient<Database>, canaryUserId: string, fixturePropertyId: string): Promise<number> {
  const { data, error } = await client.from("sequences").select("id")
    .eq("created_by", canaryUserId).like("name", `${MARKER}%`).limit(501);
  if (error) throw new Error(`Canary discovery: ${error.message}`);
  if ((data?.length ?? 0) > 500) throw new Error("Canary discovery exceeded 500; refusing partial cleanup");
  // Validate all candidate enrollments before the first destructive action.
  for (const row of data ?? []) {
    const { data: enrollments, error: enrollmentError } = await client.from("sequence_enrollments")
      .select("property_id").eq("sequence_id", row.id);
    if (enrollmentError) throw new Error(`Canary enrollments lookup: ${enrollmentError.message}`);
    if ((enrollments ?? []).some((enrollment) => enrollment.property_id !== fixturePropertyId)) {
      throw new Error(`Refusing cleanup: sequence ${row.id} has a non-fixture property`);
    }
  }
  for (const row of data ?? []) await cleanupCanary(client, row.id, canaryUserId, fixturePropertyId);
  return data?.length ?? 0;
}
