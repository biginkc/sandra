import { afterEach, describe, expect, it } from "vitest";

import { StubServer } from "./stubs";

let stub: StubServer | null = null;
afterEach(async () => { await stub?.stop(); stub = null; });

async function dial(s: StubServer, phone: string, customData: string, signal?: AbortSignal) {
  return fetch(`${s.url}/dialpad/api/v2/users/1/initiate_call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone_number: phone, custom_data: customData }), signal });
}

describe("StubServer", () => {
  it("records dials with destination and key, and answers a probe", async () => {
    stub = new StubServer();
    await stub.start();
    expect((await fetch(`${stub.url}/__probe/dialpad`)).status).toBe(200);
    expect((await dial(stub, "+15551230001", "tok-1")).status).toBe(200);
    expect(stub.dials()).toHaveLength(1);
    expect(stub.dials()[0]).toMatchObject({ phone: "+15551230001", key: "tok-1" });
    expect(stub.records.filter((r) => r.probe)).toHaveLength(1);
  });
  it("lost response: the provider accepted but the caller aborted before response_sent", async () => {
    stub = new StubServer();
    await stub.start();
    const gate = stub.gates.arm("provider_accepted", { source: "dialpad" });
    const ac = new AbortController();
    const call = dial(stub, "+15551230002", "tok-2", ac.signal).catch((e) => e);
    await stub.gates.waitReached(gate, 2000);
    expect(stub.dials()).toHaveLength(1); // provider has it
    ac.abort();
    await call;
    stub.gates.release(gate);
    await new Promise((r) => setTimeout(r, 30));
    expect(stub.dials().length + stub.records.filter((r) => r.outcome === "client_aborted").length).toBeGreaterThanOrEqual(1);
    expect(stub.records.filter((r) => r.outcome === "accepted" && r.key === "tok-2")).toHaveLength(1);
  });
  it("kill switch refuses new provider requests", async () => {
    stub = new StubServer();
    await stub.start();
    stub.gates.closeAll();
    expect((await dial(stub, "+15551230003", "tok-3")).status).toBe(503);
    expect(stub.dials()).toHaveLength(0);
    expect(stub.records.some((r) => r.outcome === "refused")).toBe(true);
  });
});
