import type { CoachCallContext } from "@/lib/coach/types";
import { prepareLeadCall, prepareManualCall } from "./dialer-actions-browser-stub";
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

export async function prepareSetupCall(input: {
  operatorId: string | null;
  propertyId: string | null;
  phoneE164: string;
}) {
  const result = input.propertyId
    ? await prepareLeadCall(input.propertyId)
    : await prepareManualCall(input.phoneE164);
  return result.ok ? { ...result, operatorId: input.operatorId ?? "synthetic-rep" } : result;
}
