import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "./normalize";
import type { Database, Json } from "@/lib/supabase/types";

const PAGE_SIZE = 500;
const RPC_CONCURRENCY = 12;

type AssignsPhone = { value?: unknown; type?: unknown };
type SourceAttributes = { phones?: unknown };

export type AssignsPhoneRecoverySummary = {
  scannedContacts: number;
  sourceUnknownPhones: number;
  added: number;
  alreadyPresent: number;
  noOpenSlot: number;
  unavailable: number;
  invalid: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sourceUnknownPhonesForRecovery(value: Json): string[] {
  if (!isRecord(value)) return [];
  const phones = (value as SourceAttributes).phones;
  if (!Array.isArray(phones)) return [];
  return phones.flatMap((phone): string[] => {
    if (!isRecord(phone)) return [];
    // These are exactly the slots skipped by the Assigns importer. Do not
    // replay typed values or interpret DNC/litigator source metadata here.
    if ((phone as AssignsPhone).type !== "unknown") return [];
    const normalized = normalizePhone(String((phone as AssignsPhone).value ?? ""));
    return normalized ? [normalized] : [];
  });
}

async function inBatches<T>(
  items: readonly T[],
  task: (item: T) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += RPC_CONCURRENCY) {
    await Promise.all(items.slice(offset, offset + RPC_CONCURRENCY).map(task));
  }
}

/**
 * Restore only unknown-type Assigns phone slots from a completed import's
 * immutable contact ledger. The recovery deliberately leaves all source DNC
 * and litigation attributes alone; it merely writes normalized phone values
 * to their already-associated contact via the narrow database RPC.
 */
export async function recoverAssignsUnknownPhones(
  supabase: SupabaseClient<Database>,
  input: { jobId: string; orgId: string },
): Promise<AssignsPhoneRecoverySummary> {
  const summary: AssignsPhoneRecoverySummary = {
    scannedContacts: 0,
    sourceUnknownPhones: 0,
    added: 0,
    alreadyPresent: 0,
    noOpenSlot: 0,
    unavailable: 0,
    invalid: 0,
  };
  const submitted = new Set<string>();

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data: outcomes, error: outcomesError } = await supabase
      .from("csv_import_contact_outcomes")
      .select("property_id, contact_id, source_identity")
      .eq("job_id", input.jobId)
      .eq("org_id", input.orgId)
      .order("property_id", { ascending: true })
      .order("contact_id", { ascending: true })
      .order("source_identity", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (outcomesError) throw new Error(`read Assigns contact outcomes: ${outcomesError.message}`);
    if (!outcomes?.length) break;

    // An outcome page contains at most 500 exact source identities. Query in
    // small identity batches, not just by property: a property can have eight
    // contacts and PostgREST's default row cap would otherwise silently omit
    // relations from a large property page.
    const relations: Array<{
      property_id: string;
      contact_id: string;
      source_identity: string;
      source_attributes: Json;
    }> = [];
    const identities = outcomes.map((outcome) => outcome.source_identity);
    for (let start = 0; start < identities.length; start += 100) {
      const { data, error: relationsError } = await supabase
        .from("property_contacts")
        .select("property_id, contact_id, source_identity, source_attributes")
        .eq("org_id", input.orgId)
        .eq("relationship", "assigns_contact")
        .in("source_identity", identities.slice(start, start + 100));
      if (relationsError) throw new Error(`read Assigns contact source rows: ${relationsError.message}`);
      relations.push(...(data ?? []));
    }

    const relationByKey = new Map(
      (relations ?? []).map((relation) => [
        `${relation.property_id}:${relation.contact_id}:${relation.source_identity}`,
        relation,
      ]),
    );
    const candidates: Array<{ contactId: string; phone: string }> = [];
    for (const outcome of outcomes) {
      const relation = relationByKey.get(
        `${outcome.property_id}:${outcome.contact_id}:${outcome.source_identity}`,
      );
      if (!relation) continue;
      summary.scannedContacts++;
      for (const phone of sourceUnknownPhonesForRecovery(relation.source_attributes)) {
        summary.sourceUnknownPhones++;
        const key = `${outcome.contact_id}:${phone}`;
        if (submitted.has(key)) continue;
        submitted.add(key);
        candidates.push({ contactId: outcome.contact_id, phone });
      }
    }

    await inBatches(candidates, async ({ contactId, phone }) => {
      const { data, error } = await supabase.rpc("save_unverified_lead_phone", {
        p_org_id: input.orgId,
        p_phone: phone,
        p_contact_id: contactId,
        p_first_name: null,
        p_last_name: null,
        p_email: null,
      });
      if (error) {
        if (error.message.includes("INVALID_PHONE")) summary.invalid++;
        else summary.unavailable++;
        return;
      }
      const outcome = data?.[0]?.outcome;
      if (outcome === "appended") summary.added++;
      else if (outcome === "already_present") summary.alreadyPresent++;
      else if (outcome === "no_open_phone_slot") summary.noOpenSlot++;
      else summary.unavailable++;
    });

    if (outcomes.length < PAGE_SIZE) break;
  }
  return summary;
}
