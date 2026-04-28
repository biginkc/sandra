import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import { normalizeAddress } from "./normalize";

export type AddressMatchInput = {
  address: string | null | undefined;
};

export type PropertyForMatch = {
  id: string;
  homeowner_contact_id: string | null;
  agent_contact_id: string | null;
  status: string;
  motivation_level: string | null;
  address: string | null;
  address_normalized: string | null;
};

export type AddressMatchResult =
  | { kind: "matched"; property: PropertyForMatch }
  | { kind: "unmatched"; reason: "no-address-match" | "blank-address" };

const SELECT_COLS =
  "id, homeowner_contact_id, agent_contact_id, status, motivation_level, address, address_normalized";

export async function matchPropertyByAddress(
  supabase: SupabaseClient<Database>,
  input: AddressMatchInput,
): Promise<AddressMatchResult> {
  const normalized = normalizeAddress(input.address ?? null);
  if (!normalized) {
    return { kind: "unmatched", reason: "blank-address" };
  }
  const { data, error } = await supabase
    .from("properties")
    .select(SELECT_COLS)
    .eq("address_normalized", normalized)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    throw new Error(`matchPropertyByAddress lookup failed: ${error.message}`);
  }
  if (!data) {
    return { kind: "unmatched", reason: "no-address-match" };
  }
  return { kind: "matched", property: data as PropertyForMatch };
}
