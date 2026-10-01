/* eslint-disable @typescript-eslint/no-explicit-any */
// Runs browser/app.js against a tiny fake DOM + fake Telnyx SDK (no network, no real browser).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SRC = fs.readFileSync(path.join(__dirname, "browser", "app.js"), "utf8");

function el(tag: string): any {
  const attrs: Record<string, string> = {};
  return { tag, disabled: false, textContent: "", children: [] as any[], appendChild(c: any) { this.children.push(c); }, setAttribute(k: string, v: string) { attrs[k] = v; }, attrs };
}

async function boot(opts: { status: { ready: boolean; busy: boolean }; startOk?: boolean }) {
  const byId: Record<string, any> = {};
  for (const id of ["out", "answer", "hangup", "hold", "unhold", "dtmf", "sendDtmf", "escapes", "stats"]) byId[id] = el("x");
  const body = el("body");
  const requests: { url: string; body?: any }[] = [];
  const clients: any[] = [];
  const newCalls: any[] = [];
  class FakeRTC {
    handlers: Record<string, any> = {};
    remoteElement: any;
    constructor() { clients.push(this); }
    on(e: string, f: any) { this.handlers[e] = f; }
    connect() {}
    newCall(o: any) { newCalls.push(o); return { hangup() {} }; }
  }
  const fetchImpl = async (url: string, init?: any) => {
    const b = init?.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, body: b });
    const j = (x: any, ok = true) => ({ ok, status: ok ? 200 : 409, json: async () => x });
    if (url === "/token") return j({ token: "t", sipUsername: "u" });
    if (url === "/escape-targets") return j(["owned phone (PSTN)", "transfer"]);
    if (url === "/probe/status") return j(opts.status);
    if (url === "/probe/start") return opts.startOk === false ? j({ error: "containment not confirmed for this run" }, false) : j({ probeId: "p1", target: "+15555550101", targetLabel: "owned phone (PSTN)" });
    return j({});
  };
  const ctx: any = {
    document: { getElementById: (id: string) => byId[id] ?? (byId[id] = el("x")), createElement: el, body },
    fetch: fetchImpl,
    TelnyxWebRTC: { TelnyxRTC: FakeRTC },
    addEventListener() {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    JSON, Date, Promise, console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); // let the async IIFE settle
  return { ctx, byId, body, requests, clients, newCalls };
}

describe("browser page: remote audio", () => {
  it("creates an autoplay <audio> element and sets it as the SDK remoteElement before any call", async () => {
    const t = await boot({ status: { ready: false, busy: false } });
    const audio = t.body.children.find((c: any) => c.tag === "audio");
    expect(audio).toBeTruthy();
    expect(audio.autoplay).toBe(true);
    expect(t.clients[0].remoteElement).toBe(audio);
  });

  it("exposes WebRTC inbound-audio bytes and audioLevel on the page", async () => {
    const t = await boot({ status: { ready: false, busy: false } });
    const reports = [
      { type: "inbound-rtp", kind: "audio", bytesReceived: 4800, packetsReceived: 30, audioLevel: 0.12 },
      { type: "outbound-rtp", kind: "audio", bytesSent: 3200 },
    ];
    const pc = { getStats: async () => ({ forEach: (f: any) => reports.forEach(f) }) };
    t.clients[0].handlers["telnyx.notification"]({ type: "callUpdate", call: { state: "active", peer: { instance: pc }, hangup() {} } });
    const s = await t.ctx.window.collectAudioStats();
    expect(s.inboundBytes).toBe(4800);
    expect(s.audioLevel).toBeCloseTo(0.12);
    expect(s.outboundBytes).toBe(3200);
    expect(t.ctx.window.audioStats.inboundBytes).toBe(4800);
  });
});

describe("browser page: F2 escape probes", () => {
  it("keeps probe buttons disabled while the server has not confirmed containment", async () => {
    const t = await boot({ status: { ready: false, busy: false } });
    const btns = t.byId.escapes.children;
    expect(btns.length).toBe(2);
    expect(btns.every((b: any) => b.disabled)).toBe(true);
  });

  it("enables buttons only when ready and not busy", async () => {
    const t = await boot({ status: { ready: true, busy: false } });
    expect(t.byId.escapes.children.every((b: any) => !b.disabled)).toBe(true);
    const t2 = await boot({ status: { ready: true, busy: true } });
    expect(t2.byId.escapes.children.every((b: any) => b.disabled)).toBe(true);
  });

  it("goes through /probe/start before dialing and never dials if the server refuses", async () => {
    const t = await boot({ status: { ready: true, busy: false }, startOk: false });
    t.byId.escapes.children[0].onclick();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(t.requests.some((r) => r.url === "/probe/start")).toBe(true);
    expect(t.newCalls).toHaveLength(0);
  });

  it("dials only with the target granted by the server", async () => {
    const t = await boot({ status: { ready: true, busy: false } });
    t.byId.escapes.children[0].onclick();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(t.newCalls).toHaveLength(1);
    expect(t.newCalls[0].destinationNumber).toBe("+15555550101");
  });

  it("records the transfer probe as NOT EXECUTED (not 'unavailable') when there is no active source call", async () => {
    const t = await boot({ status: { ready: true, busy: false } });
    t.byId.escapes.children[1].onclick(); // transfer
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(t.requests.some((r) => r.url === "/browser-log" && r.body.type === "escape.transfer.not_executed")).toBe(true);
    expect(t.requests.some((r) => r.url === "/browser-log" && r.body.type === "escape.transfer")).toBe(false);
  });

  it("logs which target an executed transfer went to", async () => {
    const t = await boot({ status: { ready: true, busy: false } });
    const transferred: string[] = [];
    t.clients[0].handlers["telnyx.notification"]({ type: "callUpdate", call: { state: "active", transfer: (x: string) => transferred.push(x), hangup() {} } });
    t.byId.escapes.children[1].onclick();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(transferred).toEqual(["+15555550101"]);
    const ev = t.requests.find((r) => r.url === "/browser-log" && r.body.type === "escape.transfer");
    expect(ev!.body.data.targetLabel).toBe("owned phone (PSTN)");
  });
});
