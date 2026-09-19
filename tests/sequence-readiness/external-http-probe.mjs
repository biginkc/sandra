import http from "node:http";

const port = Number(process.env.SEQUENCE_READINESS_PROBE_PORT ?? "3559");
let complete = false;
let failed = null;

try {
  await fetch("https://example.com/sequence-readiness-egress-probe");
  failed = "external fetch unexpectedly succeeded";
} catch (error) {
  if (!String(error).includes("External HTTP blocked before network")) {
    failed = "external fetch failed for an unexpected reason";
  }
}
complete = true;

const server = http.createServer((request, response) => {
  if (request.url === "/health" && complete && !failed) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(failed ? 500 : 503, { "content-type": "text/plain" });
  response.end(failed || "probe pending");
});
server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(failed ? 1 : 0)));
}
