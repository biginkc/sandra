/**
 * Every house a homeowner owns in the org ("Owns N houses" badge). One query per call, so a page of queue
 * rows costs one round trip; only when that query hits its row ceiling does it fall back to one exact query
 * per homeowner (in parallel). Runs on the caller's own Supabase client: RLS keeps it inside the caller's
 * org, and the explicit org filter keeps a multi-org member to the org being viewed. Never use a
 * service-role client.
 */

export type HomeownerHouse = {
  propertyId: string;
  /** "123 Main St, Kansas City, MO". */
  address: string;
  assignedUserId: string | null;
  /** Assigned to the viewer. False for another rep's lead and for an unassigned one. */
  isMine: boolean;
};

/** count is exact; houses lists at most MAX_LISTED_HOUSES of them. */
export type HomeownerHouses = { count: number; houses: HomeownerHouse[] };

type HouseRow = {
  id: string;
  address: string | null;
  city: string | null;
  state: string | null;
  assigned_user_id: string | null;
  homeowner_contact_id: string | null;
};

type HousesResult = { data: HouseRow[] | null; error: { message?: string } | null; count?: number | null };

type HousesQuery = {
  eq(column: string, value: string): HousesQuery;
  in(column: string, values: string[]): HousesQuery;
  is(column: string, value: null): HousesQuery;
  order(column: string, options: { ascending: boolean }): HousesQuery;
  limit(count: number): PromiseLike<HousesResult>;
};

export type HousesClient = {
  from(table: "properties"): { select(columns: string, options?: { count: "exact" }): HousesQuery };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = "id,address,city,state,assigned_user_id,homeowner_contact_id";
export const MAX_HOMEOWNER_IDS = 100;
/** Houses listed per homeowner; the count stays exact past it. */
export const MAX_LISTED_HOUSES = 50;
/** Row ceiling for the single page query; reaching it means some homeowner's rows may be missing. */
export const MAX_PAGE_ROWS = 1000;

export function houseAddress(row: Pick<HouseRow, "address" | "city" | "state">): string {
  return [row.address, row.city, row.state].map((part) => part?.trim()).filter(Boolean).join(", ");
}

function toHouse(row: HouseRow, viewerId: string): HomeownerHouse {
  return {
    propertyId: row.id,
    address: houseAddress(row) || "Address unavailable",
    assignedUserId: row.assigned_user_id,
    isMine: row.assigned_user_id !== null && row.assigned_user_id === viewerId,
  };
}

function readFailed(error: { message?: string }): Error {
  return new Error(`Homeowner houses read failed: ${error.message ?? "unknown error"}`);
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
  const base = (options?: { count: "exact" }) =>
    client.from("properties").select(COLUMNS, options).eq("org_id", input.orgId).is("deleted_at", null);

  const { data, error } = await base()
    .in("homeowner_contact_id", ids)
    .order("address", { ascending: true })
    .limit(MAX_PAGE_ROWS);
  if (error) throw readFailed(error);
  const rows = data ?? [];

  const result: Record<string, HomeownerHouses> = {};
  if (rows.length < MAX_PAGE_ROWS) {
    for (const row of rows) {
      const contactId = row.homeowner_contact_id;
      if (!contactId) continue;
      const entry = (result[contactId] ??= { count: 0, houses: [] });
      entry.count += 1;
      if (entry.houses.length < MAX_LISTED_HOUSES) entry.houses.push(toHouse(row, input.viewerId));
    }
    return result;
  }

  // The page query was cut off, so its rows can't be trusted for any homeowner: read each one exactly.
  const perOwner = await Promise.all(
    ids.map(async (contactId) => {
      const owner = await base({ count: "exact" })
        .eq("homeowner_contact_id", contactId)
        .order("address", { ascending: true })
        .limit(MAX_LISTED_HOUSES);
      if (owner.error) throw readFailed(owner.error);
      const houses = (owner.data ?? []).map((row) => toHouse(row, input.viewerId));
      return [contactId, { count: Math.max(owner.count ?? 0, houses.length), houses }] as const;
    }),
  );
  for (const [contactId, entry] of perOwner) if (entry.count > 0) result[contactId] = entry;
  return result;
}
