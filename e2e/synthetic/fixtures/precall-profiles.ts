import type { CoachCallContext } from "@/lib/coach/types";
import type { SoftphoneTarget } from "@/lib/dialer/actions";

/** Fictional reserved-number fixtures. Never used by the real-call lane. */
export const precallProfiles: {
  label: string;
  target: SoftphoneTarget;
  context: CoachCallContext;
  operatorId: string;
}[] = Array.from({ length: 8 }, (_, i) => {
  const id = i === 6 ? null : `00000000-0000-4000-8000-00000000A10${i}`;
  const rep = i % 2 ? "Morgan Lee" : "Alex Rivera";
  const name = [
    "Casey Owner",
    "",
    "Taylor Seller",
    "Jamie Context",
    "Robin Landlord",
    "Avery Vacant",
    "Manual Homeowner",
    "Zoë D’Arcy 王 — a very long fictional homeowner name",
  ][i];
  const address = i === 3 ? "" : `${101 + i} Fictional Avenue`;
  const phoneE164 = `+1816555010${i + 1}`;
  return {
    label: `Profile ${i + 1}`,
    operatorId: i % 2 ? "rep-morgan" : "rep-alex",
    target: {
      propertyId: id,
      contactId: null,
      phoneE164,
      maskedPhone: phoneE164,
      name,
      address,
      state: "MO",
      startedAt: "2026-09-10T12:00:00Z",
    },
    context: {
      sellerName: name || null,
      propertyAddress: address || null,
      propertyCounty: null,
      repName: i === 2 ? null : rep,
      authenticatedRepName: i === 2 ? null : rep,
      repPhoneE164: "+18165550100",
      sellerPhoneE164: phoneE164,
      leadId: id,
      motivation: "move closer to family",
      coldCallerName: null,
      yearBuilt: i === 3 ? null : "1962",
      leadSource: "cold_call",
      occupancy:
        i === 4 ? "tenant_occupied" : i === 5 ? "vacant" : "owner_occupied",
    },
  };
});
