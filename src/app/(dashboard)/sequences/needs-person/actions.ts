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
      .select("id, address, status, homeowner_contact_id")
      .in("id", chunk)
      .is("deleted_at", null)));
    const failed = lookups.find((lookup) => lookup.error);
    if (failed?.error) return { ok: false, error: { code: "NEEDS_PERSON_PROPERTIES_FAILED", message: failed.error.message } };
    const byId = new Map(lookups.flatMap((lookup) => lookup.data ?? []).map((property) => [property.id, property]));
    return ok(result.data.flatMap((row) => {
      const property = byId.get(row.property_id);
      return property ? [{ ...row, address: property.address, status: property.status as PropertyStatus, threadId: property.homeowner_contact_id }] : [];
    }));
  } catch (error) {
    return errFromUnknown(error, "NEEDS_PERSON_PROPERTIES_FAILED");
  }
}
