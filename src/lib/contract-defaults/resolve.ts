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

/**
 * Saved reusable lists and org-wide text defaults. Title company, buyer entity and earnest money vary by seller,
 * so NOTHING here preselects them: the card starts blank and the rep picks or types each per contract. The
 * default_* / earnest_money_cents / market-default columns remain in the database but are no longer read.
 */
export type ContractDefaults = {
  templateFieldDefaults: Record<string, string>;
  titleCompanies: TitleCompany[];
  buyerEntities: BuyerEntity[];
};

export const EMPTY_CONTRACT_DEFAULTS: ContractDefaults = {
  templateFieldDefaults: {},
  titleCompanies: [],
  buyerEntities: [],
};
