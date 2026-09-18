import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const FAULT_PATH = "/__inbox-fault/arm-o10";
const QUEUE_PAGE_SIZE_PLUS_ONE = "101";

function upstreamUrl(value) {
  const target = new URL(value);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("The acceptance Supabase target must use http or https.");
  }
  if (target.username || target.password) {
    throw new Error("The acceptance Supabase target must not contain credentials.");
  }
  return target;
}

function forwardedHeaders(headers, host) {
  const next = { ...headers, host };
  delete next.connection;
  delete next["proxy-connection"];
  return next;
}

function isQueueRead(requestUrl) {
  if (requestUrl.pathname !== "/rest/v1/messages") return false;
  const status = requestUrl.searchParams.get("status");
  const limit = requestUrl.searchParams.get("limit");
  const select = requestUrl.searchParams.get("select") ?? "";
  return (
    status === "eq.queued" &&
    limit === QUEUE_PAGE_SIZE_PLUS_ONE &&
    select.includes("property:properties") &&
    select.includes("contact:contacts")
  );
}

function relayUpgrade(request, socket, head, target) {
  const destination = new URL(request.url ?? "/", target);
  const secure = destination.protocol === "https:";
  const port = Number(destination.port) || (secure ? 443 : 80);
  const connectOptions = secure
    ? { host: destination.hostname, port, servername: destination.hostname }
    : { host: destination.hostname, port };
  const upstream = secure
    ? tls.connect(connectOptions)
    : net.connect(connectOptions);
  const path = `${destination.pathname}${destination.search}`;
  const lines = [`${request.method ?? "GET"} ${path} HTTP/1.1`];
  for (const [name, value] of Object.entries(request.headers)) {
    if (name.toLowerCase() === "host") {
      lines.push(`Host: ${destination.host}`);
    } else if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`);
    } else if (value !== undefined) {
      lines.push(`${name}: ${value}`);
    }
  }
  lines.push("", "");
  upstream.once("connect", () => {
    upstream.write(lines.join("\r\n"));
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.once("error", () => socket.destroy());
  socket.once("error", () => upstream.destroy());
}

export async function startSupabaseFaultProxy({ targetUrl, port, token }) {
  const target = upstreamUrl(targetUrl);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The acceptance fault proxy port is invalid.");
  }
  if (!token || token.length < 24) {
    throw new Error("The acceptance fault proxy control token is missing.");
  }

  let armed = false;
  let failed = false;
  const server = http.createServer((request, response) => {
    const localUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (localUrl.pathname === FAULT_PATH) {
      if (request.method !== "POST" || request.headers["x-inbox-fault-token"] !== token) {
        response.writeHead(404).end();
        return;
      }
      armed = true;
      failed = false;
      response.writeHead(204).end();
      return;
    }

    const destination = new URL(request.url ?? "/", target);
    if (armed && !failed && request.method === "GET" && isQueueRead(destination)) {
      failed = true;
      response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ code: "O10_INJECTED_QUEUE_READ_FAILURE" }));
      return;
    }

    const transport = destination.protocol === "https:" ? https : http;
    const proxyRequest = transport.request(destination, {
      method: request.method,
      headers: forwardedHeaders(request.headers, destination.host),
    }, (proxyResponse) => {
      response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
      proxyResponse.pipe(response);
    });
    proxyRequest.once("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(proxyRequest);
  });
  server.on("upgrade", (request, socket, head) => relayUpgrade(request, socket, head, target));

  await new Promise((resolve, reject) => {
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

