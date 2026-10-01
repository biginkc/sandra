/* eslint-disable @typescript-eslint/no-explicit-any */
// Local HTTP server: signed Telnyx webhooks, the stream upgrade, and (localhost only)
// the browser test page, config and short-lived credential token.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { verifyTelnyxSignature } from "./webhook-verify";
import { attachStreamServer, type StreamStats } from "./stream-server";
import type { EventLog } from "./event-log";
import type { ProbeGate } from "./probe-gate";

export interface ServerDeps {
  publicKeyBase64: string;
  log: EventLog;
  stats: StreamStats;
  /** Returns the short-lived per-test credential token (never the API key). */
  getBrowserToken: () => Promise<{ token: string; sipUsername: string }>;
  /** F2 escape probes are gated: armed per run, budget-reserved, one at a time. */
  probeGate: ProbeGate;
  /** Run-scoped random token required in the media stream URL path. */
  streamToken: string;
  nowMs?: () => number;
}

const FORWARD_HEADERS = ["x-forwarded-for", "x-forwarded-host", "cf-connecting-ip", "x-real-ip", "forwarded"];

/** True only for direct localhost requests; tunnelled requests carry forwarded headers or a non-local Host. */
export function isLocalRequest(req: Pick<http.IncomingMessage, "headers">): boolean {
  if (FORWARD_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function readBody(req: http.IncomingMessage, max = 1_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > max) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function handleWebhookBody(deps: Pick<ServerDeps, "publicKeyBase64" | "log" | "nowMs">, headers: http.IncomingHttpHeaders, raw: Buffer): { status: number; reason?: string } {
  const v = verifyTelnyxSignature({
    publicKeyBase64: deps.publicKeyBase64,
    signatureBase64: headers["telnyx-signature-ed25519"] as string | undefined,
    timestamp: headers["telnyx-timestamp"] as string | undefined,
    rawBody: raw,
    nowMs: deps.nowMs?.(),
  });
  if (!v.ok) return { status: 400, reason: v.reason };
  let j: any;
  try { j = JSON.parse(raw.toString("utf8")); } catch { return { status: 400, reason: "bad-json" }; }
  const fresh = deps.log.append({
    source: "webhook",
    id: j?.data?.id,
    type: j?.data?.event_type ?? "unknown",
    callControlId: j?.data?.payload?.call_control_id,
    data: j?.data,
  });
  return { status: 200, reason: fresh ? undefined : "duplicate" };
}

export function startServer(deps: ServerDeps, port: number): http.Server {
  const browserDir = path.join(__dirname, "browser");
  const server = http.createServer(async (req, res) => {
    try {
      const url = req.url ?? "/";
      if (req.method === "POST" && url === "/webhook") {
        const raw = await readBody(req);
        const r = handleWebhookBody(deps, req.headers, raw);
        res.writeHead(r.status).end(r.reason ?? "ok");
        return;
      }
      if (!isLocalRequest(req)) return void res.writeHead(404).end();
      if (req.method === "GET" && (url === "/" || url === "/index.html")) {
        return void res.writeHead(200, { "Content-Type": "text/html" }).end(fs.readFileSync(path.join(browserDir, "index.html")));
      }
      if (req.method === "GET" && url === "/app.js") {
        return void res.writeHead(200, { "Content-Type": "text/javascript" }).end(fs.readFileSync(path.join(browserDir, "app.js")));
      }
      if (req.method === "GET" && url === "/token") {
        const t = await deps.getBrowserToken();
        return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(t));
      }
      if (req.method === "GET" && url === "/escape-targets") {
        return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(deps.probeGate.labels()));
      }
      if (req.method === "GET" && url === "/probe/status") {
        return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(deps.probeGate.status()));
      }
      if (req.method === "POST" && url === "/probe/start") {
        const body = JSON.parse((await readBody(req, 10_000)).toString("utf8"));
        try {
          const r = deps.probeGate.start(String(body.label ?? ""));
          return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(r));
        } catch (e) {
          return void res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
        }
      }
      if (req.method === "POST" && url === "/probe/finish") {
        const body = JSON.parse((await readBody(req, 10_000)).toString("utf8"));
        deps.probeGate.finish(String(body.probeId ?? ""), typeof body.outcome === "string" ? body.outcome.slice(0, 200) : undefined);
        return void res.writeHead(204).end();
      }
      if (req.method === "POST" && url === "/browser-log") {
        const body = JSON.parse((await readBody(req, 100_000)).toString("utf8"));
        deps.log.append({ source: "browser", type: String(body.type ?? "browser"), callControlId: body.callControlId, data: body.data });
        return void res.writeHead(204).end();
      }
      res.writeHead(404).end();
    } catch {
      res.writeHead(500).end();
    }
  });
  attachStreamServer(server, deps.log, deps.stats, { token: deps.streamToken });
  // Bind loopback only; the tunnel is started separately and points here.
  server.listen(port, "127.0.0.1");
  return server;
}
