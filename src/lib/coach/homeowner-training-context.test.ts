import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { createClient } = vi.hoisted(() => ({createClient: vi.fn()}));
vi.mock("@/lib/supabase/server", () => ({createClient}));
import { loadCoachCallContext } from "./coach-context-actions";
const operator = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const phone = "+12025550196";
const profile = {id: "training-property",address: "Fictional lane",source: "other",is_vacant: false,absentee_flag: false,year_built: 1978,county: null,homeowner: {first_name: "Jordan",last_name: "Ellis",phone_1: phone}};
const input = {propertyId: null,sellerPhoneE164: phone,repPhoneE164: "+12025550197"};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HOMEOWNER_TRAINING_NUMBER", phone);
  vi.stubEnv("HOMEOWNER_TRAINING_ENABLED", "true");
  vi.stubEnv("HOMEOWNER_TRAINING_OPERATOR_IDS", operator);
});
afterEach(() => vi.unstubAllEnvs());
function database(rows: unknown[] = [profile]) {
  const eq = vi.fn(() => query);
  const query = {select: () => query,eq,limit: async () => ({data: rows,error: null})};
  const from = vi.fn(() => query);
  createClient.mockResolvedValue({auth: {getUser: async () => ({data: {user: {id: operator,email: "alex.rep@example.test",user_metadata: {display_name: "Alex Rep"}}},error: null})},from});
  return {from,eq};
}
describe("training coach context from protected server profile", () => {
  it("fills actual profile and authenticated rep fields without customer association or hidden offer values", async () => {
    const db = database();
    const context = await loadCoachCallContext(input);
    expect(context).toMatchObject({sellerName: "Jordan Ellis",propertyAddress: "Fictional lane",yearBuilt: "1978",occupancy: "owner_occupied",repName: "Alex Rep",authenticatedRepName: "Alex Rep",repPhoneE164: input.repPhoneE164,sellerPhoneE164: phone,leadId: null,motivation: "moving closer to an adult daughter and unable to fund repairs"});
    expect(context).not.toHaveProperty("accept_floor"); expect(context).not.toHaveProperty("offerAmount");
    expect(db.eq.mock.calls).toEqual([["is_training",true],["homeowner.phone_1",phone]]);
  });
  it("denies disabled training before querying profile", async () => {
    const db = database();vi.stubEnv("HOMEOWNER_TRAINING_ENABLED", "false");
    await expect(loadCoachCallContext(input)).rejects.toThrow("unavailable");
    expect(db.from).not.toHaveBeenCalled();
  });
  it("does not invent Jordan profile facts when no protected row exists", async () => {
    database([]);
    expect(await loadCoachCallContext(input)).toMatchObject({sellerName: null,propertyAddress: null,yearBuilt: null,motivation: null,leadId: null,repName: "Alex Rep"});
  });
});
