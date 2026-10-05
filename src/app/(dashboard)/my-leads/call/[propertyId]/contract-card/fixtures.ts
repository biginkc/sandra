import { ESIGN_NOVATION_FIELD_NAMES, ESIGN_RESIDENTIAL_FIELD_NAMES } from "@/lib/esign/contracts";
import type { BuyerEntity, TitleCompany } from "@/lib/contract-defaults/resolve";
import type { PrefillBase } from "./contract-prefill";

/** Synthetic test data only. */
export const TITLE: TitleCompany = {
  id: "11111111-1111-4111-8111-111111111111", name: "Test Title Co", closingAgentName: "Test Agent",
  closingAgentPhone: "555-0100", closingAgentAddress: "1 Test St", closingAgentEmail: null, isActive: true,
};
export const BUYER: BuyerEntity = {
  id: "22222222-2222-4222-8222-222222222222", name: "Test Buyer LLC", phone: "555-0101", email: "buyer@example.test",
  attorneyInFact: "Test Attorney", isActive: true,
};
export const NOW = new Date("2026-10-04T12:00:00Z");
export const FULL_DEFAULTS: Record<string, string> = {
  seller_closing_cost_cap: "$1.00", due_diligence_days: "1", access_days_per_week: "1", access_hours_per_visit: "1",
  offer_expiration: "2026-10-10", acceptance_date: "2026-10-05", release_date: "2026-10-06",
};

export const novationBase = (over: Partial<PrefillBase> = {}): PrefillBase => ({
  schemaVersion: "novation-v1",
  fieldNames: ESIGN_NOVATION_FIELD_NAMES,
  lead: { sellerName: "Sam Seller", sellerEmail: "sam@example.test", sellerPhone: "555-0102", street: "9 Test Rd", city: "Testville", state: "MO", zip: "64000", fullAddress: "9 Test Rd, Testville, MO 64000" },
  comp: { legalDescription: "LOT 1 TEST SUB", legalComplete: true, confidence: "high", fetchedAt: "2026-09-20T00:00:00Z", provider: "attom", ownerOfRecord: "SELLER SAM" },
  settings: { earnestMoneyCents: 50000, templateFieldDefaults: FULL_DEFAULTS },
  ...over,
});

export const residentialBase = (): PrefillBase => ({
  ...novationBase(), schemaVersion: "residential-v1", fieldNames: ESIGN_RESIDENTIAL_FIELD_NAMES,
});
