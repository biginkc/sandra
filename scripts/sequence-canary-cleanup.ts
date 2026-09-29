import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/types";

const MARKER = "SMOKE TEST — safe to delete";
const PROPERTY_MARKER = "E2E PROD SMOKE";

export async function cleanupCanary(
  client: SupabaseClient<Database>,
  sequenceId: string,
  canaryUserId: string,
): Promise<void> {
  const { data: sequence, error: sequenceError } = await client.from("sequences")
    .select("id, org_id, name, created_by").eq("id", sequenceId).maybeSingle();
  if (sequenceError) throw new Error(`Canary lookup: ${sequenceError.message}`);
  if (!sequence) return;
  if (!sequence.name.startsWith(MARKER) || sequence.created_by !== canaryUserId) {
    throw new Error(`Refusing to clean unowned sequence ${sequenceId}`);
  }
  const { data: enrollments, error: enrollmentError } = await client.from("sequence_enrollments")
    .select("id, property_id, contact_id").eq("sequence_id", sequenceId);
  if (enrollmentError) throw new Error(`Canary enrollments lookup: ${enrollmentError.message}`);
  const stamp = sequence.name.slice(MARKER.length).trim();
  const { data: taggedProperties, error: taggedError } = await client.from("properties")
    .select("id, homeowner_contact_id").eq("org_id", sequence.org_id).eq("address", `${PROPERTY_MARKER} ${stamp}`);
  if (taggedError) throw new Error(`Canary property discovery: ${taggedError.message}`);
  const { data: taggedContacts, error: contactsError } = await client.from("contacts")
    .select("id").eq("org_id", sequence.org_id).eq("last_name", `Prod ${stamp}`).eq("first_name", "Smoke");
  if (contactsError) throw new Error(`Canary contact discovery: ${contactsError.message}`);
  const propertyIds = [...new Set([
    ...(enrollments ?? []).map((row) => row.property_id),
    ...(taggedProperties ?? []).map((row) => row.id),
  ])];
  const contactIds = [...new Set([
    ...(enrollments ?? []).flatMap((row) => row.contact_id ? [row.contact_id] : []),
    ...(taggedProperties ?? []).flatMap((row) => row.homeowner_contact_id ? [row.homeowner_contact_id] : []),
    ...(taggedContacts ?? []).map((row) => row.id),
  ])];
  if (propertyIds.length) {
    const { data: properties, error } = await client.from("properties").select("id, org_id, address").in("id", propertyIds);
    if (error) throw new Error(`Canary properties lookup: ${error.message}`);
    if (properties?.length !== propertyIds.length || properties.some((row) => row.org_id !== sequence.org_id || row.address !== `${PROPERTY_MARKER} ${stamp}`)) {
      throw new Error(`Refusing cleanup: sequence ${sequenceId} has a non-canary property`);
    }
  }
  if (contactIds.length) {
    const { data: contacts, error } = await client.from("contacts").select("id, org_id, first_name, last_name").in("id", contactIds);
    if (error) throw new Error(`Canary contacts lookup: ${error.message}`);
    if (contacts?.length !== contactIds.length || contacts.some((row) => row.org_id !== sequence.org_id || row.first_name !== "Smoke" || row.last_name !== `Prod ${stamp}`)) {
      throw new Error(`Refusing cleanup: sequence ${sequenceId} has a non-canary contact`);
    }
  }
  async function checked(label: string, request: PromiseLike<{ error: { message: string } | null }>) {
    const { error } = await request;
    if (error) throw new Error(`Canary cleanup ${label}: ${error.message}`);
  }
  // Enrollment deletion cascades to runtime-owned step runs. Their write guard
  // forbids direct app deletes, even with an authenticated user session.
  for (const id of contactIds) await checked("messages", client.from("messages").delete().eq("contact_id", id));
  for (const id of contactIds) await checked("consent", client.from("consent_events").delete().eq("contact_id", id));
  await checked("enrollments", client.from("sequence_enrollments").delete().eq("sequence_id", sequenceId));
  await checked("steps", client.from("sequence_steps").delete().eq("sequence_id", sequenceId));
  for (const id of propertyIds) await checked("property", client.from("properties").delete().eq("id", id));
  for (const id of contactIds) await checked("contact", client.from("contacts").delete().eq("id", id));
  await checked("sequence", client.from("sequences").delete().eq("id", sequenceId));
}

export async function cleanupAllCanaries(client: SupabaseClient<Database>, canaryUserId: string): Promise<number> {
  const { data, error } = await client.from("sequences").select("id, name")
    .eq("created_by", canaryUserId).like("name", `${MARKER}%`).limit(500);
  if (error) throw new Error(`Canary discovery: ${error.message}`);
  for (const row of data ?? []) await cleanupCanary(client, row.id, canaryUserId);
  return data?.length ?? 0;
}
