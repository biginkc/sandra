/**
 * Contract defaults (TECH-PLAN-2026-10 §3.5). Pure: safe for client bundles.
 * Title companies and buyer entities start EMPTY; nothing here invents a name.
 */
export type TitleCompany = {
  id: string;
  name: string;
  closingAgentName: string;
  closingAgentPhone: string | null;
  closingAgentAddress: string | null;
  closingAgentEmail: string | null;
  isActive: boolean;
};

export type BuyerEntity = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  attorneyInFact: string | null;
  isActive: boolean;
};

export type MarketDefault = { market: string; stateCode: string | null; titleCompanyId: string };

export type ContractDefaults = {
  /** null = unset: the card requires the rep to type it. There is no built-in value. */
  earnestMoneyCents: number | null;
  templateFieldDefaults: Record<string, string>;
  defaultTitleCompanyId: string | null;
  defaultBuyerEntityId: string | null;
  titleCompanies: TitleCompany[];
  buyerEntities: BuyerEntity[];
  marketDefaults: MarketDefault[];
};

export const EMPTY_CONTRACT_DEFAULTS: ContractDefaults = {
  earnestMoneyCents: null,
  templateFieldDefaults: {},
  defaultTitleCompanyId: null,
  defaultBuyerEntityId: null,
  titleCompanies: [],
  buyerEntities: [],
  marketDefaults: [],
};

/** exact (market, state) -> (market, null) -> default title company -> null (picker required). Inactive excluded. */
export function resolveTitleCompany(
  defaults: ContractDefaults,
  where: { market: string | null; state: string | null },
): TitleCompany | null {
  const active = new Map(defaults.titleCompanies.filter((t) => t.isActive).map((t) => [t.id, t]));
  const market = where.market;
  const state = where.state?.toUpperCase() ?? null;
  const tiers: Array<string | null | undefined> = [];
  if (market) {
    tiers.push(defaults.marketDefaults.find((d) => d.market === market && state && d.stateCode === state)?.titleCompanyId);
    tiers.push(defaults.marketDefaults.find((d) => d.market === market && d.stateCode === null)?.titleCompanyId);
  }
  tiers.push(defaults.defaultTitleCompanyId);
  for (const id of tiers) {
    const hit = id ? active.get(id) : undefined;
    if (hit) return hit;
  }
  return null;
}

export function resolveBuyerEntity(defaults: ContractDefaults): BuyerEntity | null {
  const id = defaults.defaultBuyerEntityId;
  return defaults.buyerEntities.find((b) => b.id === id && b.isActive) ?? null;
}
