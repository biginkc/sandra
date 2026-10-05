import { appendFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

import { GateController, type GateMatch, type Stage } from "./gates";

/**
 * Local provider stubs, one loopback HTTP server:
 *   /dialpad/...       Dialpad REST (initiate_call). Records every request the way Dialpad would see it.
 *   /dropbox-sign/...  Dropbox Sign (seam S3, DROPBOX_SIGN_API_BASE_URL). Records signature-request sends.
 *   /__probe/<name>    T0 proof that a stub is reachable and logs (each stub gets one probe).
 *   /__ctl/...         control API so a browser-side process can arm/wait/release gates and read logs.
 *
 * Gates (see gates.ts) sit inside each provider route: `received` -> record -> `provider_accepted` ->
 * `response_sent`. When the kill switch closes the controller, provider routes answer 503 and log
 * `refused`, so no new provider request can be accepted.
 */

export type StubMode = "ok" | "reject" | "slow";
export type StubProvider = "dialpad" | "dropbox_sign";

export type StubRecord = {
  reqId: string;
  at: string;
  provider: StubProvider | "probe" | "ctl";
  path: string;
  /** Idempotency-relevant key: Dialpad custom_data, or the signature request's client key. */
  key: string | null;
  /** Destination number for dials (E.164). */
  phone: string | null;
  body: unknown;
  outcome: "accepted" | "rejected" | "refused" | "client_aborted" | "probe";
  probe: boolean;
};

export class StubServer {
  readonly records: StubRecord[] = [];
  readonly gates: GateController;
  private server: http.Server | null = null;
  private modes: Record<StubProvider, StubMode> = { dialpad: "ok", dropbox_sign: "ok" };
  port = 0;

  constructor(opts: { logFile?: string; orderingFile?: string; gates?: GateController } = {}) {
    this.logFile = opts.logFile;
    this.gates = opts.gates ?? new GateController(opts.orderingFile);
  }
  private readonly logFile?: string;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(port = 0): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res).catch((e) => { try { res.statusCode = 500; res.end(String(e)); } catch { /* ignore */ } }));
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }
  async stop(): Promise<void> {
    this.gates.closeAll();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
  setMode(provider: StubProvider, mode: StubMode): void {
    this.modes[provider] = mode;
  }

  dials(): StubRecord[] {
    return this.records.filter((r) => r.provider === "dialpad" && !r.probe && r.outcome === "accepted");
  }
  sends(): StubRecord[] {
    return this.records.filter((r) => r.provider === "dropbox_sign" && !r.probe && r.outcome === "accepted");
  }

  private push(rec: StubRecord): void {
    this.records.push(rec);
    if (this.logFile) appendFileSync(this.logFile, JSON.stringify(rec) + "\n");
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const reqId = randomUUID();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = raw;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* keep raw */ }
    const json = (status: number, payload: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };

    if (url.pathname.startsWith("/__probe/")) {
      const name = url.pathname.slice("/__probe/".length);
      this.push({ reqId, at: new Date().toISOString(), provider: "probe", path: url.pathname, key: name, phone: null, body: null, outcome: "probe", probe: true });
      return json(200, { ok: true, probe: name });
    }
    if (url.pathname.startsWith("/__ctl/")) return this.control(url, body, json);

    const provider: StubProvider | null = url.pathname.startsWith("/dialpad/") ? "dialpad" : url.pathname.startsWith("/dropbox-sign/") ? "dropbox_sign" : null;
    if (!provider) return json(404, { error: "unknown stub route" });
    const b = (body ?? {}) as Record<string, unknown>;
    const key = provider === "dialpad" ? (typeof b.custom_data === "string" ? b.custom_data : null) : (typeof b.key === "string" ? b.key : typeof b.client_key === "string" ? b.client_key : null);
    const phone = provider === "dialpad" && typeof b.phone_number === "string" ? b.phone_number : null;
    const meta = { source: provider, path: url.pathname, key: key ?? undefined };
    let aborted = false;
    res.on("close", () => {
      if (!res.writableFinished) {
        aborted = true;
        // The provider may already have accepted; the CALLER lost the response. Recorded as its own row.
        const rec = this.records.find((r) => r.reqId === reqId);
        this.push({ ...(rec ?? ({ reqId, at: new Date().toISOString(), provider, path: url.pathname, key, phone, body, probe: false } as StubRecord)), outcome: "client_aborted" });
      }
    });

    await this.gates.reach(reqId, "received", meta);
    if (this.gates.isClosed()) {
      this.push({ reqId, at: new Date().toISOString(), provider, path: url.pathname, key, phone, body, outcome: "refused", probe: false });
      return json(503, { error: "closed by kill switch" });
    }
    const mode = this.modes[provider];
    if (mode === "reject") {
      this.push({ reqId, at: new Date().toISOString(), provider, path: url.pathname, key, phone, body, outcome: "rejected", probe: false });
      await this.gates.reach(reqId, "response_sent", meta);
      return json(429, { error: "rate limited (stub)" });
    }
    if (mode === "slow") await new Promise((r) => setTimeout(r, 1500));
    // The external action is now durably "done": record it BEFORE answering.
    this.push({ reqId, at: new Date().toISOString(), provider, path: url.pathname, key, phone, body, outcome: "accepted", probe: false });
    await this.gates.reach(reqId, "provider_accepted", meta);
    await this.gates.reach(reqId, "response_sent", meta);
    if (aborted) return;
    if (provider === "dialpad") return json(200, { call_id: String(Date.now()) + String(Math.floor(Math.random() * 1000)) });
    return json(200, { signature_request: { signature_request_id: `sr_stub_${reqId.slice(0, 8)}`, test_mode: true } });
  }

  private control(url: URL, body: unknown, json: (s: number, p: unknown) => void): void | Promise<void> {
    const op = url.pathname.slice("/__ctl/".length);
    const b = (body ?? {}) as { stage?: Stage; match?: GateMatch; gate?: string; provider?: StubProvider; mode?: StubMode; timeoutMs?: number };
    if (op === "arm") return json(200, { gate: this.gates.arm(b.stage ?? "provider_accepted", b.match ?? {}) });
    if (op === "release") return json(200, { released: this.gates.release(String(b.gate)) });
    if (op === "mode") { this.setMode(b.provider ?? "dialpad", b.mode ?? "ok"); return json(200, { ok: true }); }
    if (op === "wait") return this.gates.waitReached(String(b.gate), b.timeoutMs ?? 30_000).then((reqId) => json(200, { reqId }), (e) => json(408, { error: String(e) }));
    if (op === "log") return json(200, { records: this.records, ordering: this.gates.ordering });
    return json(404, { error: "unknown ctl op" });
  }
}

/** Thin client for the control API (browser-side processes). */
export class StubControl {
  constructor(private readonly base: string) {}
  private async call<T>(op: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.base}/__ctl/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    if (!r.ok) throw new Error(`ctl ${op}: ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  }
  arm(stage: Stage, match: GateMatch = {}) { return this.call<{ gate: string }>("arm", { stage, match }).then((x) => x.gate); }
  wait(gate: string, timeoutMs = 30_000) { return this.call<{ reqId: string }>("wait", { gate, timeoutMs }).then((x) => x.reqId); }
  release(gate: string) { return this.call<{ released: number }>("release", { gate }); }
  setMode(provider: StubProvider, mode: StubMode) { return this.call("mode", { provider, mode }); }
  log() { return this.call<{ records: StubRecord[]; ordering: unknown[] }>("log"); }
}
