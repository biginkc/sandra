import { reportError } from "@/lib/errors/report";
import { loadHomeownerHouses, type HomeownerHouses, type HousesClient } from "@/lib/leads/homeowner-houses";

/** The lead's homeowner's houses for the "Owns N houses" badge; null (no badge) when unknown or on a read error. */
export async function loadLeadOwnerHouses(
  supabase: unknown,
  input: { orgId: string; viewerId: string | null; contactId: string | null },
): Promise<HomeownerHouses | null> {
  if (!input.contactId) return null;
  try {
    const byContact = await loadHomeownerHouses(supabase as HousesClient, {
      orgId: input.orgId,
      viewerId: input.viewerId ?? "",
      contactIds: [input.contactId],
    });
    return byContact[input.contactId] ?? null;
  } catch (error) {
    reportError(error instanceof Error ? error : new Error("lead homeowner houses read failed"), {
      errorClass: "database",
      tags: { surface: "database", operation: "lead_homeowner_houses" },
    });
    return null;
  }
}
