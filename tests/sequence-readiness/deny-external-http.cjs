// This file is loaded with NODE_OPTIONS --require and must remain CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- preload module uses Node's CJS request hooks
const http = require("node:http");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- preload module uses Node's CJS request hooks
const https = require("node:https");
const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;
const originalHttpGet = http.get;
const originalHttpsGet = https.get;

const ledgerUrl = process.env.SEQUENCE_READINESS_LEDGER_URL;
const ledgerToken = process.env.SEQUENCE_READINESS_LEDGER_TOKEN;
const processLabel = process.env.SEQUENCE_READINESS_PROCESS_LABEL || "unknown";

function normalizeUrl(input, options) {
  try {
    if (typeof input === "string" || input instanceof URL) return new URL(input);
    if (input && typeof input === "object" && input.href) return new URL(input.href);
    if (input && typeof input === "object" && input.url) return new URL(input.url);
    const requestOptions = input && typeof input === "object" ? input : options;
    if (requestOptions && typeof requestOptions === "object") {
      const protocol = requestOptions.protocol || "http:";
      const hostname = requestOptions.hostname || requestOptions.host || "";
      const port = requestOptions.port ? `:${requestOptions.port}` : "";
      const path = requestOptions.path || "/";
      return new URL(`${protocol}//${hostname}${port}${path}`);
    }
  } catch {
    return null;
  }
  return null;
}

function isLoopback(url) {
  return url && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1");
}

function recordEvent(event) {
  if (!ledgerUrl) return;
  try {
    const destination = new URL(ledgerUrl);
    const body = JSON.stringify({ process: processLabel, ...event });
    const request = originalHttpRequest(
      {
        protocol: destination.protocol,
        hostname: destination.hostname,
        port: destination.port,
        path: `${destination.pathname.replace(/\/$/, "")}/events`,
        method: "POST",
        headers: {
          authorization: `Bearer ${ledgerToken}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => response.resume(),
    );
    request.on("error", () => undefined);
    request.end(body);
  } catch {
    // A missing ledger must never turn the guard into a network escape hatch.
  }
}

function recordDenied(method, url) {
  if (!url) return;
  recordEvent({
    kind: "external-http-denied",
    method: method || "GET",
    origin: url.origin,
    pathname: url.pathname,
    beforeNetwork: true,
  });
}

function deny(method, url) {
  recordDenied(method, url);
  return new Error(`External HTTP blocked before network: ${url.origin}`);
}

const originalFetch = globalThis.fetch;
if (typeof originalFetch === "function") {
  globalThis.fetch = function guardedFetch(input, init) {
    const url = normalizeUrl(input);
    if (url && !isLoopback(url)) {
      return Promise.reject(deny(init?.method || "GET", url));
    }
    return originalFetch.call(this, input, init);
  };
}

function guardedRequest(original) {
  return function request(input, options) {
    const url = normalizeUrl(input, options);
    if (url && !isLoopback(url)) {
      throw deny(input?.method || options?.method || "GET", url);
    }
    return original.apply(this, arguments);
  };
}

http.request = guardedRequest(originalHttpRequest);
https.request = guardedRequest(originalHttpsRequest);

function guardedGet(original) {
  return function get(input, options) {
    const url = normalizeUrl(input, options);
    if (url && !isLoopback(url)) {
      throw deny(input?.method || options?.method || "GET", url);
    }
    return original.apply(this, arguments);
  };
}

http.get = guardedGet(originalHttpGet);
https.get = guardedGet(originalHttpsGet);

// This is intentionally an HTTP ledger event rather than process-local state:
// the browser test can prove that the actual app server loaded this guard.
setTimeout(() => recordEvent({ kind: "guard-ready" }), 0).unref?.();
