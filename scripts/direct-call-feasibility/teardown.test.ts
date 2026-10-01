/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { runTeardown } from "./teardown";
import { TelnyxClient } from "./telnyx-client";
import { EventLog } from "./event-log";
import { Budget } from "./budget";
import { cfg, inventory, jsonRes } from "./test-helpers";

function setup(handler: (method: string, url: string) => any) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: any, init: any) => {
    const path = String(url).replace("https://api.telnyx.com/v2", "");
    calls.push(`${init.method} ${path}`);
    const r = handler(init.method, path);
    return r instanceof Response ? r : jsonRes(r ?? { data: [], meta: { total_pages: 1 } });
  });
  const inv = inventory();
  inv.add("outbound_voice_profile", "prof1");
  const config = cfg();
  const client = new TelnyxClient({ config, inventory: inv, dryRun: false, fetchImpl: fetchImpl as any, log: () => {} });
  const budget = new Budget(config.limits);
  return { calls, inv, client, config, budget, log: new EventLog() };
}

describe("teardown", () => {
  it("orders: stop attempts, list legs, hang up, confirm, then delete credentials, connection, app, profiles", async () => {
    const t = setup((m, p) => {
      if (p.startsWith("/connections/conn1/active_calls")) return { data: [{ call_control_id: "leg1" }] };
      if (p.startsWith("/connections/app1/active_calls")) return { data: [] };
      if (p === "/calls/leg1" && m === "GET") return { data: { is_alive: false } };
    });
    await runTeardown({ client: t.client, inv: t.inv, cfg: t.config, log: t.log, budget: t.budget, say: () => {}, sleep: async () => {} });
    expect(() => t.budget.reserveAttempt()).toThrow(/stopped/);
    const idx = (s: string) => t.calls.findIndex((c) => c.startsWith(s));
    const order = ["GET /connections/conn1/active_calls", "POST /calls/leg1/actions/hangup", "GET /calls/leg1", "DELETE /telephony_credentials/cred1", "DELETE /credential_connections/conn1", "DELETE /call_control_applications/app1", "DELETE /outbound_voice_profiles/prof1"];
    const positions = order.map(idx);
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(t.calls.some((c) => c.startsWith("DELETE /phone_numbers"))).toBe(false);
  });

  it("refuses to control a leg whose connection/app ID is not inventoried", async () => {
    const t = setup((m, p) => {
      if (p.startsWith("/connections/conn1/active_calls")) return { data: [{ call_control_id: "foreign" }] };
      if (p === "/calls/foreign") return { data: { connection_id: "jitter-conn", is_alive: true } };
      if (p === "/calls/leg1") return { data: { is_alive: false } };
    });
    const rep = await runTeardown({ client: t.client, inv: t.inv, cfg: t.config, log: t.log, say: () => {}, sleep: async () => {}, confirmAttempts: 1 });
    expect(rep.skippedForeignLegs).toEqual(["foreign"]);
    expect(t.calls.some((c) => c.includes("/calls/foreign/actions"))).toBe(false);
  });

  it("does not delete anything if a leg cannot be confirmed ended", async () => {
    const t = setup((m, p) => {
      if (p.startsWith("/connections/conn1/active_calls")) return { data: [{ call_control_id: "leg1" }] };
      if (p === "/calls/leg1" && m === "GET") return { data: { is_alive: true } };
    });
    await expect(runTeardown({ client: t.client, inv: t.inv, cfg: t.config, log: t.log, say: () => {}, sleep: async () => {}, confirmAttempts: 2 })).rejects.toThrow(/NOT deleted/);
    expect(t.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  describe("recording deletion", () => {
    const base = (recs: any[]) => (m: string, p: string) => {
      if (p.includes("/active_calls")) return { data: [] };
      if (p === "/calls/leg1") return { data: { is_alive: false } };
      if (p.startsWith("/recordings?")) return { data: recs, meta: { total_pages: 1 } };
    };
    it("deletes only recordings whose call identifiers match an inventoried test call", async () => {
      const t = setup(base([
        { id: "recOK", call_session_id: "sess1" },
        { id: "recLeg", call_leg_id: "legid1" },
        { id: "recOther", call_session_id: "someone-elses" },
        { id: "recNoIds" },
      ]));
      t.inv.addCallRef("sess1");
      t.inv.addCallRef("legid1");
      const rep = await runTeardown({ client: t.client, inv: t.inv, cfg: t.config, log: t.log, say: () => {}, sleep: async () => {}, confirmAttempts: 1 });
      expect(t.calls).toContain("DELETE /recordings/recOK");
      expect(t.calls).toContain("DELETE /recordings/recLeg");
      expect(t.calls.some((c) => c.includes("recOther"))).toBe(false);
      expect(t.calls.some((c) => c.includes("recNoIds"))).toBe(false);
      expect(rep.skippedRecordings.sort()).toEqual(["recNoIds", "recOther"]);
      expect(t.log.all().filter((e) => e.type === "teardown.recording.skipped")).toHaveLength(2);
    });
    it("does not delete an already-inventoried recording whose ownership cannot be proven", async () => {
      const t = setup((m, p) => {
        if (p.includes("/active_calls")) return { data: [] };
        if (p === "/calls/leg1") return { data: { is_alive: false } };
        if (p === "/recordings/recX") return { data: { id: "recX" } };
      });
      t.inv.add("recording", "recX");
      await runTeardown({ client: t.client, inv: t.inv, cfg: t.config, log: t.log, say: () => {}, sleep: async () => {}, confirmAttempts: 1 });
      expect(t.calls.some((c) => c === "DELETE /recordings/recX")).toBe(false);
    });
  });
});
