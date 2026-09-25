import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import Papa from "papaparse";

import { parseAssignsContactBlocks } from "./assigns-contact-blocks";
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
  input: { jobId: string; orgId: string; storagePath: string; datasetSha256: string },
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
  const { data: blob, error: downloadError } = await supabase.storage
    .from("csv-imports")
    .download(input.storagePath);
  if (downloadError || !blob) {
    throw new Error(`download reviewed Assigns dataset: ${downloadError?.message ?? "no file"}`);
  }
  const text = await blob.text();
  if (createHash("sha256").update(text).digest("hex") !== input.datasetSha256) {
    throw new Error("reviewed Assigns dataset checksum mismatch");
  }
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: false });
  if (parsed.errors.length > 0) {
    throw new Error(`reviewed Assigns dataset parse failed: ${parsed.errors[0]?.message ?? "unknown error"}`);
  }
  const rows = parsed.data;

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data: outcomes, error: outcomesError } = await supabase
      .from("csv_import_row_outcomes")
      .select("property_id, source_row_index")
      .eq("job_id", input.jobId)
      .eq("org_id", input.orgId)
      .order("source_row_index", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (outcomesError) throw new Error(`read import property outcomes: ${outcomesError.message}`);
    if (!outcomes?.length) break;

    const sourceByKey = new Map<string, string[]>();
    for (const outcome of outcomes) {
      const row = rows[outcome.source_row_index];
      if (!row) throw new Error(`reviewed dataset has no source row ${outcome.source_row_index}`);
      const blocks = parseAssignsContactBlocks(row["Assigns Contact Blocks"]);
      for (const block of blocks) {
        if (!block.sourceIdentity) continue;
        const phones = sourceUnknownPhonesForRecovery({ phones: block.phones ?? [] });
        if (phones.length > 0) {
          sourceByKey.set(`${outcome.property_id}:${block.sourceIdentity}`, phones);
        }
      }
    }

    // Query exact source identities in small batches. Unlike the newer
    // contact-outcome ledger, the row ledger existed when this import began;
    // replaying the reviewed source file keeps the fallback exact to this job.
    const relations: Array<{
      property_id: string;
      contact_id: string;
      source_identity: string;
      source_attributes: Json;
    }> = [];
    const identities = [...new Set([...sourceByKey.keys()].map((key) => key.split(":").slice(1).join(":")))];
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
        `${relation.property_id}:${relation.source_identity}`,
        relation,
      ]),
    );
    const candidates: Array<{ contactId: string; phone: string }> = [];
    for (const outcome of outcomes) {
      const row = rows[outcome.source_row_index];
      const blocks = parseAssignsContactBlocks(row?.["Assigns Contact Blocks"]);
      for (const block of blocks) {
        if (!block.sourceIdentity) continue;
        const relation = relationByKey.get(
          `${outcome.property_id}:${block.sourceIdentity}`,
        );
        const phones = sourceByKey.get(`${outcome.property_id}:${block.sourceIdentity}`);
        if (!relation || !phones) continue;
        summary.scannedContacts++;
        for (const phone of phones) {
          summary.sourceUnknownPhones++;
          const key = `${relation.contact_id}:${phone}`;
          if (submitted.has(key)) continue;
          submitted.add(key);
          candidates.push({ contactId: relation.contact_id, phone });
        }
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
