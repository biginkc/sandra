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

  it("a GET 404 never confirms a leg ended: nothing deleted, teardown.incomplete logged", async () => {
    const t = setup((m, p) => {
      if (p.startsWith("/connections/conn1/active_calls")) return { data: [{ call_control_id: "leg1" }] };
      if (p === "/calls/leg1" && m === "GET") return jsonRes({ errors: [{ code: "10005" }] }, 404);
    });
    await expect(runTeardown({ client: t.client, inv: t.inv, cfg: t.config, log: t.log, say: () => {}, sleep: async () => {}, confirmAttempts: 3 })).rejects.toThrow(/NOT deleted/);
    expect(t.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    const ev = t.log.all().find((e) => e.type === "teardown.incomplete");
    expect((ev?.data as any).unconfirmedLegs).toEqual(["leg1"]);
  });

  it("hangup 422 with code 90018 confirms the leg ended without any GET", async () => {
    const t = setup((m, p) => {
      if (p.startsWith("/connections/conn1/active_calls")) return { data: [{ call_control_id: "leg1" }] };
      if (m === "POST" && p === "/calls/leg1/actions/hangup") return jsonRes({ errors: [{ code: "90018" }] }, 422);
      if (p === "/calls/leg1" && m === "GET") return jsonRes({}, 404);
    });
    await runTeardown({ client: t.client, inv: t.inv, cfg: t.config, log: t.log, say: () => {}, sleep: async () => {}, confirmAttempts: 1 });
    expect(t.calls).toContain("DELETE /call_control_applications/app1");
  });

  it("a different 422 on hangup does not confirm", async () => {
    const t = setup((m, p) => {
      if (p.startsWith("/connections/conn1/active_calls")) return { data: [{ call_control_id: "leg1" }] };
      if (m === "POST") return jsonRes({ errors: [{ code: "90041" }] }, 422);
      if (p === "/calls/leg1" && m === "GET") return jsonRes({}, 404);
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

describe("unresolved Dial inventory", () => {
  const CS = Buffer.from("cs-1").toString("base64");
  const addUnresolved = (t: ReturnType<typeof setup>, at: number, over: Record<string, any> = {}) =>
    t.inv.addUnresolvedDial({ opId: "op1", clientState: CS, role: "seller", at, ringTimeoutSecs: 30, timeLimitSecs: 180, ...over });
  const empty = (m: string, p: string) => {
    if (p.includes("/active_calls")) return { data: [] };
    if (p === "/calls/leg1") return { data: { is_alive: false } };
  };
  const run = (t: ReturnType<typeof setup>, now: number) =>
    runTeardown({ client: t.client, inv: t.inv, cfg: t.config, log: t.log, say: () => {}, sleep: async () => {}, confirmAttempts: 1, now: () => now });

  it("Dial writes the unresolved record BEFORE the request; a lost response keeps it; a response replaces it", async () => {
    const seen: number[] = [];
    const lost = setup(() => ({}));
    const inv = lost.inv;
    const fetchLost = vi.fn(async () => { seen.push(inv.unresolvedDials().length); throw new Error("socket hang up"); });
    const c1 = new TelnyxClient({ config: lost.config, inventory: lost.inv, dryRun: false, fetchImpl: fetchLost as any, log: () => {} });
    await expect(c1.dial({ to: lost.config.testPhones[0], role: "seller", clientState: "cs-1" })).rejects.toThrow();
    expect(seen).toEqual([1]); // record existed when the request was sent
    expect(lost.inv.unresolvedDials()).toMatchObject([{ role: "seller", clientState: CS }]);

    const ok = setup(() => ({ data: { call_control_id: "newleg" } }));
    await ok.client.dial({ to: ok.config.testPhones[0] });
    expect(ok.inv.unresolvedDials()).toHaveLength(0);
  });

  it("a definite 4xx rejection resolves the record; a 5xx does not", async () => {
    for (const [status, left] of [[400, 0], [503, 1]] as const) {
      const t = setup(() => jsonRes({ errors: [] }, status));
      await expect(t.client.dial({ to: t.config.testPhones[0] })).rejects.toThrow();
      expect(t.inv.unresolvedDials()).toHaveLength(left);
    }
  });

  it("teardown deletes nothing while an unresolved Dial is inside its ring window, even with empty listings", async () => {
    const t = setup(empty);
    const now = 1_000_000;
    addUnresolved(t, now - 20_000); // < ring timeout + 15s
    await expect(run(t, now)).rejects.toThrow(/unresolved Dial/);
    expect(t.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    expect((t.log.all().find((e) => e.type === "teardown.incomplete")!.data as any).unresolvedDials).toEqual(["seller:op1"]);
  });

  it("two consecutive empty listings after ring timeout + 15s resolve it; exactly two listing rounds per scope", async () => {
    const t = setup(empty);
    const now = 1_000_000;
    addUnresolved(t, now - 46_000);
    await run(t, now);
    expect(t.inv.unresolvedDials()).toHaveLength(0);
    expect(t.calls.filter((c) => c.startsWith("GET /connections/conn1/active_calls"))).toHaveLength(2);
    expect(t.calls).toContain("DELETE /credential_connections/conn1");
  });

  it("a listing that reveals the leg by client_state adopts it, hangs it up and confirms it before any delete", async () => {
    const t = setup((m, p) => {
      if (p.startsWith("/connections/app1/active_calls")) return { data: [{ call_control_id: "ghost", client_state: CS }] };
      if (p.includes("/active_calls")) return { data: [] };
      if ((p === "/calls/ghost" || p === "/calls/leg1") && m === "GET") return { data: { is_alive: false } };
    });
    addUnresolved(t, 1_000_000 - 5_000);
    await run(t, 1_000_000);
    expect(t.calls).toContain("POST /calls/ghost/actions/hangup");
    expect(t.calls.indexOf("POST /calls/ghost/actions/hangup")).toBeLessThan(t.calls.findIndex((c) => c.startsWith("DELETE")));
    expect(t.inv.unresolvedDials()).toHaveLength(0);
  });

  it("a webhook carrying the client_state reveals the leg", async () => {
    const t = setup((m, p) => {
      if (p.includes("/active_calls")) return { data: [] };
      if ((p === "/calls/hook" || p === "/calls/leg1") && m === "GET") return { data: { is_alive: false } };
    });
    addUnresolved(t, 1_000_000 - 5_000);
    t.log.append({ source: "webhook", id: "e1", type: "call.initiated", callControlId: "hook", data: { payload: { client_state: CS } } });
    await run(t, 1_000_000);
    expect(t.calls).toContain("POST /calls/hook/actions/hangup");
    expect(t.inv.unresolvedDials()).toHaveLength(0);
  });

  it("an incomplete (repeating-cursor) listing never counts as empty", async () => {
    const t = setup((m, p) => (p.includes("/active_calls") ? { data: [], meta: { cursors: { after: "same" } } } : undefined));
    addUnresolved(t, 1_000_000 - 100_000);
    await expect(run(t, 1_000_000)).rejects.toThrow(/incomplete/);
    expect(t.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  it("time_limit_secs + 60s backstop resolves it when listings cannot match", async () => {
    const t = setup(empty);
    addUnresolved(t, 1_000_000 - 241_000);
    await run(t, 1_000_000);
    expect(t.inv.unresolvedDials()).toHaveLength(0);
    expect(t.log.all().some((e) => (e.data as any)?.by === "empty_listings" || (e.data as any)?.by === "resolved_by_time_limit")).toBe(true);
  });
});
