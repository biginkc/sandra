import type { LooseSupabase } from "./queries";
import type { PipelineRun, RunLabel } from "./types";

const CHUNK = 50;

function chunk<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** "(816) 555-0142" / "+18165550142" -> "···0142". Never exposes more than 4 digits. */
export function redactPhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `···${digits.slice(-4)}` : null;
}

export function formatRunLabel(input: {
  firstName: string | null;
  address: string | null;
  city: string | null;
  fromAddress: string | null;
}): RunLabel {
  const addr = [input.address, input.city].filter(Boolean).join(", ");
  const first = input.firstName?.trim();
  if (first) return { name: first, address: addr || null };
  const tail = redactPhone(input.fromAddress);
  return { name: tail ? `Unknown ${tail}` : "Unknown sender", address: addr || null };
}

/**
 * Minimal display join for the feed: contact first name, property address +
 * city, and (only for senders with no contact) the last 4 of the phone.
 * Safe to call from the browser client; RLS scopes every table.
 */
export async function loadRunLabels(
  supabase: LooseSupabase,
  runs: readonly Pick<PipelineRun, "id" | "contact_id" | "property_id" | "inbound_message_id">[],
): Promise<Map<string, RunLabel>> {
  const contactIds = [...new Set(runs.map((r) => r.contact_id).filter((v): v is string => !!v))];
  const propertyIds = [...new Set(runs.map((r) => r.property_id).filter((v): v is string => !!v))];
  const unknownMsgIds = runs.filter((r) => !r.contact_id && r.inbound_message_id).map((r) => r.inbound_message_id);

  const contacts = new Map<string, string | null>();
  const properties = new Map<string, { address: string | null; city: string | null }>();
  const phones = new Map<string, string | null>();

  await Promise.all([
    ...chunk(contactIds).map(async (ids) => {
      const { data } = await supabase.from("contacts").select("id, first_name").in("id", ids);
      for (const row of (data ?? []) as Array<{ id: string; first_name: string | null }>) {
        contacts.set(row.id, row.first_name);
      }
    }),
    ...chunk(propertyIds).map(async (ids) => {
      const { data } = await supabase.from("properties").select("id, address, city").in("id", ids);
      for (const row of (data ?? []) as Array<{ id: string; address: string | null; city: string | null }>) {
        properties.set(row.id, { address: row.address, city: row.city });
      }
    }),
    ...chunk(unknownMsgIds).map(async (ids) => {
      const { data } = await supabase.from("messages").select("id, from_address").in("id", ids);
      for (const row of (data ?? []) as Array<{ id: string; from_address: string | null }>) {
        phones.set(row.id, row.from_address);
      }
    }),
  ]);

  const out = new Map<string, RunLabel>();
  for (const run of runs) {
    const prop = run.property_id ? properties.get(run.property_id) : undefined;
    out.set(
      run.id,
      formatRunLabel({
        firstName: run.contact_id ? (contacts.get(run.contact_id) ?? null) : null,
        address: prop?.address ?? null,
        city: prop?.city ?? null,
        fromAddress: run.contact_id ? null : (phones.get(run.inbound_message_id) ?? null),
      }),
    );
  }
  return out;
}
