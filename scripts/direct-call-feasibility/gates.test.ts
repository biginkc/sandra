/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { ProbeGate } from "./probe-gate";
import { Budget } from "./budget";
import { EventLog } from "./event-log";
import { assertReady, verifyAndMarkReady, READY_ROLE } from "./setup";
import { attachStreamServer, parseFrames, streamTokenOk, OversizeError } from "./stream-server";
import { verifyTelnyxSignature } from "./webhook-verify";
import { cfg, inventory } from "./test-helpers";
import { EventEmitter } from "node:events";

function gate(limits?: Partial<{ maxAttempts: number }>) {
  const config = cfg(limits ? { DIRECT_CALL_MAX_ATTEMPTS: String(limits.maxAttempts) } : {});
  const budget = new Budget(config.limits);
  const log = new EventLog();
  const g = new ProbeGate({ budget, log, targets: () => [{ label: "owned phone (PSTN)", target: "+15555550101" }] });
  return { g, budget, log };
}

describe("probe gate", () => {
  it("refuses probes until armed for this run, and records the refusal", () => {
    const { g, budget, log } = gate();
    expect(() => g.start("owned phone (PSTN)")).toThrow(/containment/);
    expect(budget.attempts).toBe(0);
    expect(log.all().some((e) => e.type === "escape.probe.refused")).toBe(true);
  });

  it("reserves attempt + spend, allows one outstanding probe, and logs each", () => {
    const { g, budget, log } = gate();
    g.arm();
    const p = g.start("owned phone (PSTN)");
    expect(p.target).toBe("+15555550101");
    expect(budget.attempts).toBe(1);
    expect(budget.estSpendUsd).toBeGreaterThan(0);
    expect(g.status()).toEqual({ ready: true, busy: true });
    expect(() => g.start("transfer")).toThrow(/outstanding/);
    expect(budget.attempts).toBe(1);
    expect(g.finish(p.probeId)).toBe(true);
    g.start("transfer");
    expect(log.all().filter((e) => e.type === "escape.probe.start")).toHaveLength(2);
  });

  it("refuses when the budget is exhausted", () => {
    const { g, budget } = gate({ maxAttempts: 1 });
    g.arm();
    budget.reserveAttempt();
    expect(() => g.start("owned phone (PSTN)")).toThrow(/budget/);
  });

  it("refuses again after disarm", () => {
    const { g } = gate();
    g.arm(); g.disarm();
    expect(() => g.start("owned phone (PSTN)")).toThrow();
  });
});

// Fake provider whose read-back state can be changed.
function provider(over: Record<string, any> = {}) {
  const state: any = {
    dis: { enabled: false },
    cap: { enabled: true, daily_spend_limit: "5", daily_spend_limit_enabled: true, concurrent_call_limit: 1 },
    conn: { outbound: { outbound_voice_profile_id: "dis1" }, sip_uri_calling_preference: "internal" },
    app: { outbound: { outbound_voice_profile_id: "cap1" } },
    ...over,
  };
  const client: any = {
    request: vi.fn(async (_m: string, p: string) => {
      if (p.includes("outbound_voice_profiles/dis1")) return { data: state.dis };
      if (p.includes("outbound_voice_profiles/cap1")) return { data: state.cap };
      if (p.includes("credential_connections")) return { data: state.conn };
      return { data: state.app };
    }),
  };
  return { state, client };
}
function readyInv(config = cfg()) {
  const inv = inventory();
  inv.setRole("disabledProfileId", "dis1");
  inv.setRole("cappedProfileId", "cap1");
  config.limits.profileDailyCapUsd = 5;
  config.limits.profileConcurrentLimit = 1;
  return { inv, config };
}

describe("setup readiness", () => {
  it("is not ready until a read-back succeeds; failed read-back leaves it not ready", async () => {
    const { inv, config } = readyInv();
    const { client, state } = provider();
    await expect(assertReady(client, inv, config)).rejects.toThrow(/not ready/);
    state.cap.enabled = false;
    await expect(verifyAndMarkReady(client, inv, config)).rejects.toThrow(/read-back mismatch/);
    expect(inv.getRole(READY_ROLE)).toBeFalsy();
    await expect(assertReady(client, inv, config)).rejects.toThrow();
  });

  it("passes when verified and unchanged, refuses when settings change afterwards", async () => {
    const { inv, config } = readyInv();
    const { client, state } = provider();
    await verifyAndMarkReady(client, inv, config);
    expect(inv.getRole(READY_ROLE)).toBeTruthy();
    await expect(assertReady(client, inv, config)).resolves.toBeUndefined();
    state.conn.outbound.outbound_voice_profile_id = "jitter-profile";
    await expect(assertReady(client, inv, config)).rejects.toThrow(/read-back mismatch/);
    expect(inv.getRole(READY_ROLE)).toBeFalsy();
  });

  it("only issues GETs when re-verifying", async () => {
    const { inv, config } = readyInv();
    const { client } = provider();
    await verifyAndMarkReady(client, inv, config);
    await assertReady(client, inv, config);
    expect(client.request.mock.calls.every((c: any[]) => c[0] === "GET")).toBe(true);
  });
});

describe("stream server hardening", () => {
  it("accepts only the exact run token in the path (or query)", () => {
    expect(streamTokenOk("/stream/abc123", "abc123")).toBe(true);
    expect(streamTokenOk("/stream?token=abc123", "abc123")).toBe(true);
    expect(streamTokenOk("/stream", "abc123")).toBe(false);
    expect(streamTokenOk("/stream/abc124", "abc123")).toBe(false);
    expect(streamTokenOk("/stream/abc123/x", "abc123")).toBe(false);
    expect(streamTokenOk("/streamer/abc123", "abc123")).toBe(false);
    expect(streamTokenOk("/stream/abc123", "")).toBe(false);
  });

  function upgrade(url: string, token = "tok") {
    const server: any = new EventEmitter();
    attachStreamServer(server, new EventLog(), { startFrames: [], bytesByTrack: {} }, { token, maxFrame: 100 });
    const socket: any = new EventEmitter();
    socket.writes = [] as any[]; socket.destroyed = false;
    socket.write = (x: any) => socket.writes.push(x);
    socket.destroy = () => { socket.destroyed = true; };
    socket.end = () => {};
    server.emit("upgrade", { url, headers: { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } }, socket);
    return socket;
  }

  it("destroys sockets with a missing or wrong token and never completes the handshake", () => {
    for (const u of ["/stream", "/stream/wrong"]) {
      const s = upgrade(u);
      expect(s.destroyed).toBe(true);
      expect(s.writes).toHaveLength(0);
    }
    const ok = upgrade("/stream/tok");
    expect(ok.destroyed).toBe(false);
    expect(ok.writes).toHaveLength(1);
  });

  it("rejects an oversize frame and drops the connection", () => {
    const big = Buffer.from([0x81, 0x80 | 126, 0x04, 0x00, 1, 2, 3, 4]); // declares 1024 bytes
    expect(() => parseFrames(big, 100)).toThrow(OversizeError);
    const s = upgrade("/stream/tok");
    s.emit("data", big);
    expect(s.destroyed).toBe(true);
  });
});

describe("webhook timestamp reasons", () => {
  const base = { publicKeyBase64: "x", signatureBase64: "sig", rawBody: "{}", nowMs: 1_000_000_000_000 };
  it("distinguishes non-numeric from expired", () => {
    expect(verifyTelnyxSignature({ ...base, timestamp: "abc" })).toEqual({ ok: false, reason: "bad-timestamp" });
    expect(verifyTelnyxSignature({ ...base, timestamp: "1e9" })).toEqual({ ok: false, reason: "bad-timestamp" });
    expect(verifyTelnyxSignature({ ...base, timestamp: "1" })).toEqual({ ok: false, reason: "expired" });
  });
});
