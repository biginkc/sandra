import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

import type { GateController } from "./gates";

/**
 * Thin test-only reverse proxy in front of the app under test. The browser (and the replay engine's
 * HTTP calls) go through it so a scenario can hold a response at `response_sent` ("reload after the
 * provider accepted, before the response is delivered") and so the ordering log has real request
 * boundaries. It adds nothing to the app and is never deployed: it only ever listens on loopback and
 * only ever forwards to the loopback app URL it was constructed with.
 */
export class GateProxy {
  private server: http.Server | null = null;
  port = 0;
  constructor(private readonly upstream: URL, private readonly gates: GateController) {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname)) throw new Error("GateProxy upstream must be loopback");
  }
  /** `localhost`, not 127.0.0.1: Next dev only serves its client assets (and so hydrates) for allowed dev origins, and `localhost` is the default one. The proxy itself listens on loopback only. */
  get url(): string {
    return `http://localhost:${this.port}`;
  }
  async start(port = 0): Promise<void> {
    this.server = http.createServer((req, res) => void this.forward(req, res));
    this.server.on("upgrade", (req, socket, head) => {
      const up = net.connect(Number(this.upstream.port || 80), this.upstream.hostname.replace(/^\[|\]$/g, ""), () => {
        up.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
        if (head.length) up.write(head);
        socket.pipe(up).pipe(socket);
      });
      up.on("error", () => socket.destroy());
      socket.on("error", () => up.destroy());
    });
    await new Promise<void>((r) => this.server!.listen(port, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
  }
  async stop(): Promise<void> {
    this.gates.closeAll();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private async forward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reqId = randomUUID();
    const path = req.url ?? "/";
    const key = (req.headers["next-action"] as string | undefined) ?? (req.headers["x-idempotency-key"] as string | undefined);
    const meta = { source: "app", path, key };
    await this.gates.reach(reqId, "received", meta);
    const up = http.request(
      { host: this.upstream.hostname.replace(/^\[|\]$/g, ""), port: Number(this.upstream.port || 80), method: req.method, path, headers: { ...req.headers } }, // keep the caller's Host so redirects and the server-action origin check stay on the proxy origin
      (upRes) => {
        void (async () => {
          // The upstream has answered (any external action it triggered is done); hold before delivering.
          await this.gates.reach(reqId, "response_sent", meta, `status ${upRes.statusCode}`);
          if (res.destroyed) return upRes.destroy();
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        })();
      },
    );
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on("close", () => up.destroy());
    req.pipe(up);
  }
}
