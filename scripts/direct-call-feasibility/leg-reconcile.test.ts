/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { makeLegReconciler } from "./leg-reconcile";
import { ProbeGate } from "./probe-gate";
import { TelnyxClient } from "./telnyx-client";
import { EventLog } from "./event-log";
import { Budget } from "./budget";
import { cfg, inventory, jsonRes } from "./test-helpers";

function setup(handler: (m: string, p: string) => any) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: any, init: any) => {
    const path = String(url).replace("https://api.telnyx.com/v2", "");
    calls.push(`${init.method} ${path}`);
    return jsonRes(handler(init.method, path) ?? { data: [] });
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
