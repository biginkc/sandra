import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { loadHomeownerTrainingProfile } from "./homeowner-training-profile";
const phone = "+12025550196";
afterEach(() => vi.unstubAllEnvs());
function database(data: unknown, error: unknown = null) {
  const eq = vi.fn(() => chain);
  const chain = { select: vi.fn(() => chain), eq, limit: vi.fn(async () => ({ data, error })) };
  const from = vi.fn(() => chain);
  return { client: { from } as unknown as SupabaseClient<Database>, from, eq, chain };
}
describe("protected homeowner profile lookup", () => {
  it("queries only the marked record and exact reserved contact phone", async () => {
    vi.stubEnv("HOMEOWNER_TRAINING_NUMBER", phone);
    const row = { id: "jordan", address: "Fictional address", homeowner: { first_name: "Jordan", phone_1: phone } };
    const db = database([row]);
    expect(await loadHomeownerTrainingProfile(db.client, phone)).toEqual(row);
    expect(db.from).toHaveBeenCalledWith("properties");
    expect(db.eq.mock.calls).toEqual([["is_training", true], ["homeowner.phone_1", phone]]);
    expect(db.chain.limit).toHaveBeenCalledWith(2);
    expect(db.chain.select).toHaveBeenCalledWith(expect.stringContaining("!inner"));
  });
  it("never queries a non-reserved number", async () => {
    vi.stubEnv("HOMEOWNER_TRAINING_NUMBER", phone);
    const db = database([]);
    expect(await loadHomeownerTrainingProfile(db.client, "+12025550197")).toBeNull();
    expect(db.from).not.toHaveBeenCalled();
  });
  it("distinguishes missing profile, ambiguous rows, and failed lookup", async () => {
    vi.stubEnv("HOMEOWNER_TRAINING_NUMBER", phone);
    expect(await loadHomeownerTrainingProfile(database([]).client, phone)).toBeNull();
    await expect(loadHomeownerTrainingProfile(database([{}, {}]).client, phone)).rejects.toThrow("ambiguous");
    await expect(loadHomeownerTrainingProfile(database(null, { message: "error" }).client, phone)).rejects.toThrow("Could not load");
  });
});
