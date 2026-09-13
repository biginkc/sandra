import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(`${root}.runtime`, { recursive: true });
await build({
  entryPoints: [`${root}browser/app.tsx`],
  outfile: `${root}.runtime/app.js`,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  define: { "process.env.NODE_ENV": '"production"' },
});
const origin = "http://127.0.0.1:58790";
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", origin);
    if (req.headers.origin && req.headers.origin !== origin) {
      res.writeHead(403).end("Fixture origin mismatch");
      return;
    }
    const upstreamOrigin = url.pathname.startsWith("/sync/")
      ? "http://127.0.0.1:58784"
      : url.pathname.startsWith("/bulk/")
        ? "http://127.0.0.1:58789"
        : null;
    if (upstreamOrigin) {
      const path = url.pathname.replace(/^\/(sync|bulk)/, "");
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 65536) {
          res.writeHead(413).end("Fixture request too large");
          return;
        }
        chunks.push(chunk);
      }
      const headers: Record<string, string> = {};
      for (const name of ["authorization", "content-type", "x-fixture-user"]) {
        const value = req.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      const response = await fetch(`${upstreamOrigin}${path}${url.search}`, {
        method: req.method,
        headers,
        signal: controller.signal,
        body: length ? Buffer.concat(chunks) : undefined,
      });
      const responseHeaders: Record<string, string> = {
        "cache-control": "private, no-store",
      };
      for (const [name, value] of response.headers) {
        if (name === "content-type" || name.startsWith("electric-"))
          responseHeaders[name] = value;
      }
      res.writeHead(response.status, responseHeaders);
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const files: Record<string, string> = {
      "/": "browser/index.html",
      "/app.js": ".runtime/app.js",
      "/style.css": "browser/style.css",
    };
    if (req.method !== "GET" || !(url.pathname in files)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": url.pathname.endsWith(".js")
        ? "text/javascript"
        : url.pathname.endsWith(".css")
          ? "text/css"
          : "text/html",
      "cache-control": "no-store",
    });
    res.end(await readFile(`${root}${files[url.pathname]}`));
  } catch {
    if (!res.headersSent)
      res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Fixture dependency unavailable" }));
  }
});
server.listen(58790, "127.0.0.1", () =>
  console.log(`Synthetic Inbox runtime lab: ${origin}`),
);
process.on("SIGTERM", () => server.close());
