import "server-only";

import { schemaReady } from "@/lib/my-leads/schema-ready";

import {
  EMPTY_CONTRACT_DEFAULTS,
  type BuyerEntity,
  type ContractDefaults,
  type MarketDefault,
  type TitleCompany,
} from "./resolve";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClient = any;
type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/**
 * Loads the org's defaults through the caller's RLS client. Not ready, or any read error, returns
 * the EMPTY defaults so the card stays blocked ("Add a title company in Settings").
 */
export async function loadContractDefaults(
  client: LooseClient,
  orgId: string,
  deps: { schemaReady?: typeof schemaReady } = {},
): Promise<ContractDefaults> {
  if (!(await (deps.schemaReady ?? schemaReady)("contract_defaults"))) return EMPTY_CONTRACT_DEFAULTS;
  try {
    const [settings, titles, buyers, markets] = await Promise.all([
      client.from("acquisition_contract_settings").select("*").eq("org_id", orgId).maybeSingle(),
      client.from("acquisition_contract_title_companies").select("*").eq("org_id", orgId).eq("is_active", true),
      client.from("acquisition_contract_buyer_entities").select("*").eq("org_id", orgId).eq("is_active", true),
      client.from("acquisition_contract_title_market_defaults").select("*").eq("org_id", orgId),
    ]);
    for (const r of [settings, titles, buyers, markets]) if (r.error) return EMPTY_CONTRACT_DEFAULTS;
    const s = (settings.data ?? null) as Row | null;
    const fieldDefaults: Record<string, string> = {};
    if (s?.template_field_defaults && typeof s.template_field_defaults === "object") {
      for (const [k, v] of Object.entries(s.template_field_defaults as Row)) if (typeof v === "string") fieldDefaults[k] = v;
    }
    return {
      earnestMoneyCents: s?.earnest_money_cents == null || !Number.isFinite(Number(s.earnest_money_cents)) ? null : Number(s.earnest_money_cents),
      templateFieldDefaults: fieldDefaults,
      defaultTitleCompanyId: str(s?.default_title_company_id),
      defaultBuyerEntityId: str(s?.default_buyer_entity_id),
      titleCompanies: ((titles.data ?? []) as Row[]).map((r): TitleCompany => ({
        id: String(r.id), name: String(r.name), closingAgentName: String(r.closing_agent_name ?? ""),
        closingAgentPhone: str(r.closing_agent_phone), closingAgentAddress: str(r.closing_agent_address),
        closingAgentEmail: str(r.closing_agent_email), isActive: r.is_active !== false,
      })),
      buyerEntities: ((buyers.data ?? []) as Row[]).map((r): BuyerEntity => ({
        id: String(r.id), name: String(r.name), phone: str(r.phone), email: str(r.email),
        attorneyInFact: str(r.attorney_in_fact), isActive: r.is_active !== false,
      })),
      marketDefaults: ((markets.data ?? []) as Row[]).map((r): MarketDefault => ({
        market: String(r.market), stateCode: str(r.state_code), titleCompanyId: String(r.title_company_id),
      })),
    };
  } catch {
    return EMPTY_CONTRACT_DEFAULTS;
  }
}
