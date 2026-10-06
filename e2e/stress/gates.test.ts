import { describe, expect, it } from "vitest";

import { GateController, orderedBefore } from "./gates";

describe("GateController", () => {
  it("parks a matching request at the armed stage until released and logs the real order", async () => {
    const g = new GateController();
    const id = g.arm("provider_accepted", { pathIncludes: "initiate_call" });
    const order: string[] = [];
    const req = (async () => {
      await g.reach("r1", "received", { source: "dialpad-stub", path: "/users/1/initiate_call" });
      order.push("accepted-logged");
      await g.reach("r1", "provider_accepted", { source: "dialpad-stub", path: "/users/1/initiate_call" });
      order.push("after-hold");
      await g.reach("r1", "response_sent", { source: "dialpad-stub", path: "/users/1/initiate_call" });
    })();
    expect(await g.waitReached(id, 1000)).toBe("r1");
    expect(order).toEqual(["accepted-logged"]);
    expect(g.release(id)).toBe(1);
    await req;
    expect(order).toEqual(["accepted-logged", "after-hold"]);
    expect(orderedBefore(g.ordering, "r1", "provider_accepted", "response_sent")).toBe(true);
  });
  it("does not park a request that does not match, and times out waiting on an unreached gate", async () => {
    const g = new GateController();
    const id = g.arm("received", { pathIncludes: "nope" });
    await g.reach("r2", "received", { source: "x", path: "/other" });
    await expect(g.waitReached(id, 30)).rejects.toThrow(/not reached/);
  });
  it("closeAll releases every parked request and disarms parking (kill switch)", async () => {
    const g = new GateController();
    g.arm("response_sent");
    let done = false;
    const p = g.reach("r3", "response_sent", { source: "x", path: "/p" }).then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    g.closeAll();
    await p;
    expect(done).toBe(true);
    expect(g.isClosed()).toBe(true);
    await g.reach("r4", "response_sent", { source: "x", path: "/p" }); // does not park
  });
});
