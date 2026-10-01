/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { makeLegReconciler, listActiveCalls } from "./leg-reconcile";
import { ProbeGate } from "./probe-gate";
import { TelnyxClient } from "./telnyx-client";
import { EventLog } from "./event-log";
import { Budget } from "./budget";
import { cfg, inventory, jsonRes } from "./test-helpers";

function setup(handler: (m: string, p: string) => any, status: (m: string, p: string) => number = () => 200) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: any, init: any) => {
    const path = String(url).replace("https://api.telnyx.com/v2", "");
    calls.push(`${init.method} ${path}`);
    return jsonRes(handler(init.method, path) ?? { data: [] }, status(init.method, path));
  });
  const inv = inventory();
  const config = cfg();
  const client = new TelnyxClient({ config, inventory: inv, dryRun: false, fetchImpl: fetchImpl as any, log: () => {} });
  return { calls, inv, client, config };
}

describe("leg reconciler", () => {
  it("inventories a discovered in-scope leg (owner from listing) then hangs it up", async () => {
    const t = setup((m, p) => (p.startsWith("/connections/conn1/active_calls") ? { data: [{ call_control_id: "esc1", connection_id: "conn1" }] } : { data: [] }));
    const r = makeLegReconciler(t.client, t.inv);
    expect(await r.listAliveLegs()).toEqual(["esc1"]);
    await r.hangupLeg("esc1");
    expect(t.inv.has("esc1", ["call_leg"])).toBe(true);
    expect(t.calls).toContain("POST /calls/esc1/actions/hangup");
  });

  it("re-checks owner via GET when the listing lacks it", async () => {
    const t = setup((m, p) => {
      if (p.startsWith("/connections/app1/active_calls")) return { data: [{ call_control_id: "esc2" }] };
      if (p === "/calls/esc2") return { data: { connection_id: "app1" } };
      return { data: [] };
    });
    const r = makeLegReconciler(t.client, t.inv);
    await r.listAliveLegs();
    await r.hangupLeg("esc2");
    expect(t.calls).toContain("GET /calls/esc2");
    expect(t.calls).toContain("POST /calls/esc2/actions/hangup");
  });

  it("refuses out-of-scope or unprovable legs: not inventoried, no hangup", async () => {
    const t = setup((m, p) => {
      if (p.startsWith("/connections/conn1/active_calls")) return { data: [{ call_control_id: "foreign", connection_id: "other" }, { call_control_id: "unknown" }] };
      if (p === "/calls/unknown") return { data: {} };
      return { data: [] };
    });
    const r = makeLegReconciler(t.client, t.inv);
    await r.listAliveLegs();
    await expect(r.hangupLeg("foreign")).rejects.toThrow(/cannot be proven/);
    await expect(r.hangupLeg("unknown")).rejects.toThrow(/cannot be proven/);
    expect(t.inv.has("foreign")).toBe(false);
    expect(t.inv.has("unknown")).toBe(false);
    expect(t.calls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  it("follows cursor pagination with page[limit] until exhausted", async () => {
    const t = setup((m, p) => {
      if (!p.startsWith("/connections/conn1/active_calls")) return { data: [] };
      if (p.includes("page[after]=c1")) return { data: [{ call_control_id: "b", connection_id: "conn1" }], meta: { cursors: { after: "c2" } } };
      if (p.includes("page[after]=c2")) return { data: [{ call_control_id: "c", connection_id: "conn1" }], meta: { cursors: { after: null } } };
      return { data: [{ call_control_id: "a", connection_id: "conn1" }], meta: { cursors: { after: "c1" } } };
    });
    expect(await listActiveCalls(t.client, "conn1")).toHaveLength(3);
    expect(t.calls.every((c) => c.includes("page[limit]=250") && !c.includes("page[size]"))).toBe(true);
    expect(await makeLegReconciler(t.client, t.inv).listAliveLegs()).toEqual(["a", "b", "c"]);
  });

  it("an incomplete listing (repeating cursor) is an error, never an empty listing", async () => {
    const t = setup(() => ({ data: [], meta: { cursors: { after: "same" } } }));
    await expect(listActiveCalls(t.client, "conn1")).rejects.toThrow(/incomplete/);
  });

  it("hangup 422 code 90018 counts as ended; other 422 and 404 do not", async () => {
    const mk = (status: number, code: string) => {
      const t = setup((m, p) => (m === "POST" ? { errors: [{ code }] } : p === "/calls/leg1" ? { errors: [{ code: "x" }] } : { data: [] }), (m) => (m === "POST" ? status : 404));
      return makeLegReconciler(t.client, t.inv);
    };
    const a = mk(422, "90018");
    await a.hangupLeg("leg1");
    expect(await a.confirmLegEnded("leg1")).toBe(true);
    const b = mk(422, "10007");
    await expect(b.hangupLeg("leg1")).rejects.toThrow();
    expect(await b.confirmLegEnded("leg1")).toBe(false);
    const c = mk(404, "");
    await expect(c.hangupLeg("leg1")).rejects.toThrow();
    expect(await c.confirmLegEnded("leg1")).toBe(false);
  });

  it("gate stays locked when the only live leg is out of scope", async () => {
    const t = setup((m, p) => (p.startsWith("/connections/conn1/active_calls") ? { data: [{ call_control_id: "foreign", connection_id: "other" }] } : { data: [] }));
    const r = makeLegReconciler(t.client, t.inv);
    const log = new EventLog();
    const g = new ProbeGate({ budget: new Budget(t.config.limits), log, targets: () => [{ label: "owned phone (PSTN)", target: "+15555550101" }], ...r, sleep: async () => {}, confirmWaitMs: 4000, pollMs: 2000 });
    g.arm();
    const { probeId } = g.start("owned phone (PSTN)");
    expect((await g.finish(probeId)).released).toBe(false);
    expect(g.status().locked).toBe(true);
  });
});
