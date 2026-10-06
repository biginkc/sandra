import { describe, expect, it, vi } from "vitest";
import { loadProviderData } from "./provider-data-server";

function client(data: unknown) {
  const eq = vi.fn();
  const query = {select:vi.fn(() => query),eq: eq.mockImplementation(() => query),maybeSingle:vi.fn(async () => ({data,error:null}))};
  return {from:vi.fn(() => query),eq};
}
describe("source data authorization", () => {
  it("does not read privileged raw data unless the member can read the comp", async () => {
    const member = client(null), admin = vi.fn();
    expect(await loadProviderData(member,"org","comp",admin)).toBeNull();
    expect(admin).not.toHaveBeenCalled();
  });
  it("scopes the privileged read to the authorized org, property, and exact comp", async () => {
    const member = client({id:"comp",property_id:"property"}), privileged=client({raw:{apikey:"SECRET",avm:{property:[{address:{oneLine:"Sample address"}}]}}});
    const data = await loadProviderData(member,"org","comp",() => privileged as never);
    expect(privileged.eq.mock.calls).toEqual([["org_id","org"],["property_id","property"],["id","comp"]]);
    expect(data?.facts).toEqual([{label:"ATTOM address",value:"Sample address"}]);
    expect(JSON.stringify(data)).not.toContain("SECRET");
  });
});
