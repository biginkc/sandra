/**
 * Every house a homeowner owns in the org ("Owns N houses" badge). One query per call, so a page of queue
 * rows costs one round trip; only when that query hits its row ceiling does it add ONE batched exact-count
 * call (fn_homeowner_house_counts), so a page never costs more than two round trips. Runs on the caller's own Supabase client: RLS keeps it inside the caller's
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
  range(from: number, to: number): PromiseLike<HousesResult>;
};

type HouseCountRow = { homeowner_contact_id: string | null; house_count: number | string | null };

export type HousesClient = {
  from(table: "properties"): { select(columns: string, options?: { count: "exact" }): HousesQuery };
  rpc(
    fn: "fn_homeowner_house_counts",
    args: { p_org_id: string; p_contact_ids: string[] },
  ): PromiseLike<{ data: HouseCountRow[] | null; error: { message?: string } | null }>;
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
    .order("id", { ascending: true })
    .limit(MAX_PAGE_ROWS);
  if (error) throw readFailed(error);
  const rows = data ?? [];

  const result: Record<string, HomeownerHouses> = {};
  for (const row of rows) {
    const contactId = row.homeowner_contact_id;
    if (!contactId) continue;
    const entry = (result[contactId] ??= { count: 0, houses: [] });
    entry.count += 1;
    if (entry.houses.length < MAX_LISTED_HOUSES) entry.houses.push(toHouse(row, input.viewerId));
  }
  if (rows.length < MAX_PAGE_ROWS) return result;

  // The page read was cut off, so its per-owner counts may be short. Rows come back in one global
  // (address, id) order, so each owner's listed houses are still the start of that owner's own list and
  // "Show more" continues from there; only the counts need one exact batched read.
  const counts = await client.rpc("fn_homeowner_house_counts", { p_org_id: input.orgId, p_contact_ids: ids });
  if (counts.error) throw readFailed(counts.error);
  for (const countRow of counts.data ?? []) {
    const contactId = countRow.homeowner_contact_id;
    const exact = Number(countRow.house_count ?? 0);
    if (!contactId || !ids.includes(contactId) || !(exact > 0)) continue;
    const entry = (result[contactId] ??= { count: 0, houses: [] });
    entry.count = Math.max(exact, entry.houses.length);
  }
  return result;
}

/** Largest offset a "Show more" page may ask for. */
export const MAX_HOUSES_OFFSET = 100_000;

export type HomeownerHousesPage = { houses: HomeownerHouse[]; count: number; nextOffset: number | null };

/**
 * The next MAX_LISTED_HOUSES houses of one homeowner, in the same order as the first paint (address, then id),
 * so "Show more" from offset N continues exactly where the list stopped.
 */
export async function loadHomeownerHousesPage(
  client: HousesClient,
  input: { orgId: string; viewerId: string; contactId: string; offset: number },
): Promise<HomeownerHousesPage> {
  if (!UUID.test(input.contactId)) throw new Error("Invalid homeowner");
  if (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > MAX_HOUSES_OFFSET) throw new Error("Invalid offset");
  const { data, error, count } = await client
    .from("properties")
    .select(COLUMNS, { count: "exact" })
    .eq("org_id", input.orgId)
    .is("deleted_at", null)
    .eq("homeowner_contact_id", input.contactId)
    .order("address", { ascending: true })
    .order("id", { ascending: true })
    .range(input.offset, input.offset + MAX_LISTED_HOUSES - 1);
  if (error) throw readFailed(error);
  const houses = (data ?? []).map((row) => toHouse(row, input.viewerId));
  const total = Math.max(count ?? 0, input.offset + houses.length);
  const next = input.offset + houses.length;
  return { houses, count: total, nextOffset: houses.length > 0 && next < total ? next : null };
}
