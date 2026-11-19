"use server";

import { reportError } from "@/lib/errors/report";
import { getCallerMemberships } from "@/lib/auth/memberships";
import { createClient } from "@/lib/supabase/server";

import {
  loadHomeownerHouses,
  loadHomeownerHousesPage,
  MAX_HOMEOWNER_IDS,
  MAX_HOUSES_OFFSET,
  type HomeownerHouses,
  type HomeownerHousesPage,
  type HousesClient,
} from "./homeowner-houses";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function viewer() {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) return null;
  const memberships = (await getCallerMemberships()).filter((m) => m.user_id === user.id);
  if (memberships.length !== 1) return null;
  return { client: client as unknown as HousesClient, orgId: memberships[0].org_id, userId: user.id };
}

function report(operation: string, error: unknown) {
  reportError(error instanceof Error ? error : new Error(`${operation} failed`), {
    errorClass: "database",
    tags: { surface: "database", operation },
  });
}

/**
 * Client-callable "Owns N houses" read for surfaces that render on the client (the Messages conversation
 * header). One query for every id passed; the signed-in user's client and single active org. Returns {} when
 * signed out, in more or fewer than one org, or on a read error, so a caller simply shows no badge.
 */
export async function loadHomeownerHousesAction(contactIds: string[]): Promise<Record<string, HomeownerHouses>> {
  if (!Array.isArray(contactIds) || contactIds.length === 0 || contactIds.length > MAX_HOMEOWNER_IDS) return {};
  try {
    const v = await viewer();
    if (!v) return {};
    return await loadHomeownerHouses(v.client, { orgId: v.orgId, viewerId: v.userId, contactIds });
  } catch (error) {
    report("homeowner_houses_action", error);
    return {};
  }
}

export type HomeownerHousesPageResult = ({ ok: true } & HomeownerHousesPage) | { ok: false; message: string };

/** "Show more": the next page of one homeowner's houses, from `offset` (how many are already listed). */
export async function loadMoreHomeownerHousesAction(input: {
  contactId: string;
  offset: number;
}): Promise<HomeownerHousesPageResult> {
  if (
    !input || typeof input.contactId !== "string" || !UUID.test(input.contactId) ||
    !Number.isInteger(input.offset) || input.offset < 0 || input.offset > MAX_HOUSES_OFFSET
  )
    return { ok: false, message: "Those houses could not be loaded." };
  try {
    const v = await viewer();
    if (!v) return { ok: false, message: "Sign in to see these houses." };
    const page = await loadHomeownerHousesPage(v.client, {
      orgId: v.orgId,
      viewerId: v.userId,
      contactId: input.contactId,
      offset: input.offset,
    });
    return { ok: true, ...page };
  } catch (error) {
    report("homeowner_houses_more_action", error);
    return { ok: false, message: "More houses could not load. Try again." };
  }
}
