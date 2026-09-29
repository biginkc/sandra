"use server";

import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import type { PropertyStatus } from "@/app/(dashboard)/leads/actions";
import { listSequenceNeedsPersonPage, type NeedsPersonBucket, type NeedsPersonRow } from "../actions";

export type NeedsPersonLead = NeedsPersonRow & { address: string; status: PropertyStatus; threadId: string | null };

export async function listNeedsPersonLeads(bucket: NeedsPersonBucket, page: number): Promise<Result<NeedsPersonLead[]>> {
  const result = await listSequenceNeedsPersonPage(bucket, page);
  if (!result.ok) return result;
  if (result.data.length === 0) return ok([]);
  try {
    const supabase = await createClient();
    const ids = result.data.map((row) => row.property_id);
    const chunks = Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => ids.slice(index * 100, (index + 1) * 100));
    const lookups = await Promise.all(chunks.map((chunk) => supabase.from("properties")
      .select("id, address, status")
      .in("id", chunk)
      .is("deleted_at", null)));
    const failed = lookups.find((lookup) => lookup.error);
    if (failed?.error) return { ok: false, error: { code: "NEEDS_PERSON_PROPERTIES_FAILED", message: failed.error.message } };
    const byId = new Map(lookups.flatMap((lookup) => lookup.data ?? []).map((property) => [property.id, property]));
    const conversations = new Map<string, string>();
    // Each property needs its own latest conversation. A shared homeowner can
    // have a newer conversation on another property, and a global LIMIT would
    // hide quieter properties on a busy page.
    const threadChunks = Array.from({ length: Math.ceil(ids.length / 10) }, (_, index) => ids.slice(index * 10, (index + 1) * 10));
    for (const chunk of threadChunks) {
      const threads = await Promise.all(chunk.map((propertyId) => supabase.from("messages")
        .select("conversation_id")
        .eq("property_id", propertyId)
        .eq("channel", "sms")
        .not("conversation_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()));
      const threadFailure = threads.find((thread) => thread.error);
      if (threadFailure?.error) return { ok: false, error: { code: "NEEDS_PERSON_THREADS_FAILED", message: threadFailure.error.message } };
      threads.forEach((thread, index) => {
        if (thread.data?.conversation_id) conversations.set(chunk[index], thread.data.conversation_id);
      });
    }
    return ok(result.data.flatMap((row) => {
      const property = byId.get(row.property_id);
      return property ? [{ ...row, address: property.address, status: property.status as PropertyStatus, threadId: conversations.get(row.property_id) ?? null }] : [];
    }));
  } catch (error) {
    return errFromUnknown(error, "NEEDS_PERSON_PROPERTIES_FAILED");
  }
}
