/**
 * Every house a homeowner owns in the org ("Owns N houses" badge). One query per call, so a page of queue
 * rows costs one round trip. Runs on the caller's own Supabase client: RLS keeps it inside the caller's org,
 * and the explicit org filter keeps a multi-org member to the org being viewed. Never use a service-role client.
 */

export type HomeownerHouse = {
  propertyId: string;
  /** "123 Main St, Kansas City, MO". */
  address: string;
  assignedUserId: string | null;
  /** Assigned to the viewer. False for another rep's lead and for an unassigned one. */
  isMine: boolean;
};

export type HomeownerHouses = { count: number; houses: HomeownerHouse[] };

type HouseRow = {
  id: string;
  address: string | null;
  city: string | null;
  state: string | null;
  assigned_user_id: string | null;
  homeowner_contact_id: string | null;
};

type HousesQuery = {
  eq(column: string, value: string): HousesQuery;
  in(column: string, values: string[]): HousesQuery;
  is(column: string, value: null): HousesQuery;
  order(column: string, options: { ascending: boolean }): HousesQuery;
  limit(count: number): PromiseLike<{ data: HouseRow[] | null; error: { message?: string } | null }>;
};

export type HousesClient = { from(table: "properties"): { select(columns: string): HousesQuery } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_HOMEOWNER_IDS = 100;
/** A ceiling on rows read for one page; a portfolio owner past it still shows the houses that fit. */
const MAX_ROWS = 1000;

export function houseAddress(row: Pick<HouseRow, "address" | "city" | "state">): string {
  return [row.address, row.city, row.state].map((part) => part?.trim()).filter(Boolean).join(", ");
}

/**
 * Houses per homeowner contact id. Ids with no readable houses are absent from the result.
 * Throws on a read error; callers that decorate another view should catch and show no badge.
 */
export async function loadHomeownerHouses(
  client: HousesClient,
  input: { orgId: string; viewerId: string; contactIds: readonly (string | null | undefined)[] },
): Promise<Record<string, HomeownerHouses>> {
  const ids = [...new Set(input.contactIds.filter((id): id is string => typeof id === "string" && UUID.test(id)))];
  if (ids.length === 0) return {};
  if (ids.length > MAX_HOMEOWNER_IDS) throw new Error("Too many homeowners in one read");
  const { data, error } = await client
    .from("properties")
    .select("id,address,city,state,assigned_user_id,homeowner_contact_id")
    .eq("org_id", input.orgId)
    .in("homeowner_contact_id", ids)
    .is("deleted_at", null)
    .order("address", { ascending: true })
    .limit(MAX_ROWS);
  if (error) throw new Error(`Homeowner houses read failed: ${error.message ?? "unknown error"}`);
  const result: Record<string, HomeownerHouses> = {};
  for (const row of data ?? []) {
    const contactId = row.homeowner_contact_id;
    if (!contactId) continue;
    const entry = (result[contactId] ??= { count: 0, houses: [] });
    entry.count += 1;
    entry.houses.push({
      propertyId: row.id,
      address: houseAddress(row) || "Address unavailable",
      assignedUserId: row.assigned_user_id,
      isMine: row.assigned_user_id !== null && row.assigned_user_id === input.viewerId,
    });
  }
  return result;
}
