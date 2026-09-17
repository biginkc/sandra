import http from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.SEQUENCE_READINESS_LEDGER_PORT ?? "3558");
const token = process.env.SEQUENCE_READINESS_LEDGER_TOKEN;
if (!token || token.length < 16) {
  throw new Error("SEQUENCE_READINESS_LEDGER_TOKEN is required");
}

const events = [];
const maxBodyBytes = 16 * 1024;

function authorized(request) {
  return request.headers.authorization === `Bearer ${token}`;
}

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBodyBytes) {
        reject(new Error("ledger event too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.method === "GET" && url.pathname === "/health") {
    return json(response, 200, { ok: true });
  }
  if (!authorized(request)) return json(response, 404, { error: "not found" });

  if (request.method === "GET" && url.pathname === "/ledger") {
    return json(response, 200, { events });
  }
  if (request.method === "DELETE" && url.pathname === "/ledger") {
    events.length = 0;
    return json(response, 200, { ok: true });
  }
  if (request.method === "POST" && url.pathname === "/ledger/events") {
    try {
      const parsed = JSON.parse(await readBody(request));
      const event = {
        kind: typeof parsed.kind === "string" ? parsed.kind : "unknown",
        process:
          typeof parsed.process === "string"
            ? parsed.process.slice(0, 80)
            : "unknown",
        method:
          typeof parsed.method === "string" ? parsed.method.slice(0, 16) : "",
        origin:
          typeof parsed.origin === "string" ? parsed.origin.slice(0, 200) : "",
        pathname:
          typeof parsed.pathname === "string"
            ? parsed.pathname.slice(0, 200)
            : "",
        provider:
          typeof parsed.provider === "string" ? parsed.provider.slice(0, 32) : "",
        externalId:
          typeof parsed.externalId === "string"
            ? parsed.externalId.slice(0, 200)
            : "",
        to: typeof parsed.to === "string" ? parsed.to.slice(0, 32) : "",
        bodyHash:
          typeof parsed.bodyHash === "string" ? parsed.bodyHash.slice(0, 64) : "",
        bodyLength:
          Number.isInteger(parsed.bodyLength) && parsed.bodyLength >= 0
            ? parsed.bodyLength
            : null,
        failReason:
          typeof parsed.failReason === "string"
            ? parsed.failReason.slice(0, 32)
            : null,
        beforeNetwork: parsed.beforeNetwork === true,
        at: new Date().toISOString(),
      };
      events.push(event);
      if (events.length > 500) events.splice(0, events.length - 500);
      return json(response, 201, { ok: true });
    } catch {
      return json(response, 400, { error: "invalid event" });
    }
  }
  return json(response, 404, { error: "not found" });
});

server.listen(port, host);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
