import "server-only";

import { schemaReady } from "@/lib/my-leads/schema-ready";

import {
  EMPTY_CONTRACT_DEFAULTS,
  type BuyerEntity,
  type ContractDefaults,
  type TitleCompany,
} from "./resolve";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;
type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/**
 * Loads the org's defaults through the caller's RLS client. Not ready, or any read error, returns
 * the EMPTY defaults so the card keeps blank pickers.
 */
export async function loadContractDefaults(
  client: LooseClient,
  orgId: string,
  deps: { schemaReady?: typeof schemaReady } = {},
): Promise<ContractDefaults> {
  if (!(await (deps.schemaReady ?? schemaReady)("contract_defaults"))) return EMPTY_CONTRACT_DEFAULTS;
  try {
    const [settings, titles, buyers] = await Promise.all([
      client.from("acquisition_contract_settings").select("template_field_defaults").eq("org_id", orgId).maybeSingle(),
      client.from("acquisition_contract_title_companies").select("*").eq("org_id", orgId).eq("is_active", true),
      client.from("acquisition_contract_buyer_entities").select("*").eq("org_id", orgId).eq("is_active", true),
    ]);
    for (const r of [settings, titles, buyers]) if (r.error) return EMPTY_CONTRACT_DEFAULTS;
    const s = (settings.data ?? null) as Row | null;
    const fieldDefaults: Record<string, string> = {};
    if (s?.template_field_defaults && typeof s.template_field_defaults === "object") {
      for (const [k, v] of Object.entries(s.template_field_defaults as Row)) if (typeof v === "string") fieldDefaults[k] = v;
    }
    return {
      templateFieldDefaults: fieldDefaults,
      titleCompanies: ((titles.data ?? []) as Row[]).map((r): TitleCompany => ({
        id: String(r.id), name: String(r.name), closingAgentName: String(r.closing_agent_name ?? ""),
        closingAgentPhone: str(r.closing_agent_phone), closingAgentAddress: str(r.closing_agent_address),
        closingAgentEmail: str(r.closing_agent_email), isActive: r.is_active !== false,
      })),
      buyerEntities: ((buyers.data ?? []) as Row[]).map((r): BuyerEntity => ({
        id: String(r.id), name: String(r.name), phone: str(r.phone), email: str(r.email),
        attorneyInFact: str(r.attorney_in_fact), isActive: r.is_active !== false,
      })),
    };
  } catch {
    return EMPTY_CONTRACT_DEFAULTS;
  }
}
