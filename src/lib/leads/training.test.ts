import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { assertNotTrainingTarget } from "./training";
function database(property: unknown, linked: unknown[] = [], error: unknown = null) {
  const eq = vi.fn(() => query);
  const query = {select: () => query, eq, maybeSingle: async () => ({data: property,error}), limit: async () => ({data: linked,error})};
  return {client: {from: () => query} as unknown as SupabaseClient<Database>,eq};
}
describe("durable training customer-action boundary", () => {
  it("rejects a marked property", async () => {
    const db=database({is_training: true});
    await expect(assertNotTrainingTarget(db.client,{propertyId: "training-property"})).rejects.toThrow("Customer actions are unavailable");
  });
  it("rejects a contact-only request linked to a training property", async () => {
    const db=database(null,[{id: "training-property"}]);
    await expect(assertNotTrainingTarget(db.client,{contactId: "training-contact"})).rejects.toThrow("Customer actions are unavailable");
    expect(db.eq.mock.calls).toEqual([["homeowner_contact_id","training-contact"],["is_training",true]]);
  });
  it("allows an ordinary property and contact", async () => {
    const db=database({is_training: false});
    await expect(assertNotTrainingTarget(db.client,{propertyId: "ordinary",contactId: "ordinary-contact"})).resolves.toBeUndefined();
  });
  it.each([{propertyId:"property"},{contactId:"contact"}])("fails closed on lookup error %j", async target => {
    const db=database(null,[],{message: "unavailable"});
    await expect(assertNotTrainingTarget(db.client,target)).rejects.toThrow("Could not verify");
  });
});
