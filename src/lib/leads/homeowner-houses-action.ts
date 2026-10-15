"use server";

import { getCallerMemberships } from "@/lib/auth/memberships";
import { createClient } from "@/lib/supabase/server";

import { loadHomeownerHouses, MAX_HOMEOWNER_IDS, type HomeownerHouses, type HousesClient } from "./homeowner-houses";

/**
 * Client-callable "Owns N houses" read for surfaces that render on the client (the Messages conversation
 * header). One query for every id passed; the signed-in user's client and single active org. Returns {} when
 * signed out, in more or fewer than one org, or on a read error, so a caller simply shows no badge.
 */
export async function loadHomeownerHousesAction(contactIds: string[]): Promise<Record<string, HomeownerHouses>> {
  if (!Array.isArray(contactIds) || contactIds.length === 0 || contactIds.length > MAX_HOMEOWNER_IDS) return {};
  try {
    const client = await createClient();
    const { data: { user } } = await client.auth.getUser();
    if (!user) return {};
    const memberships = (await getCallerMemberships()).filter((m) => m.user_id === user.id);
    if (memberships.length !== 1) return {};
    return await loadHomeownerHouses(client as unknown as HousesClient, {
      orgId: memberships[0].org_id,
      viewerId: user.id,
      contactIds,
    });
  } catch (error) {
    console.error("[leads] homeowner houses action failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}
