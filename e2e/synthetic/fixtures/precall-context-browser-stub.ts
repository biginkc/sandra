import type { CoachCallContext } from "@/lib/coach/types";
const context: CoachCallContext = {
  sellerName: "Synthetic Homeowner",
  repName: "Synthetic Coach",
  authenticatedRepName: "Synthetic Coach",
  propertyAddress: "100 Test Avenue",
  propertyCounty: null,
  repPhoneE164: "+18165550100",
  sellerPhoneE164: "+18165550101",
  leadId: "synthetic-lead-123456",
  motivation: null,
  coldCallerName: null,
  yearBuilt: "1962",
  leadSource: "cold_call",
  occupancy: "owner_occupied",
};
export async function loadPrecallContext() {
  return { operatorId: "synthetic-rep", context, error: null };
}

export { prepareLeadCall as prepareSetupCall } from "./dialer-actions-browser-stub";
