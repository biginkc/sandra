"use client";

/**
 * Client timing for My Leads reads. Server actions run one at a time per client, so "invoked → fetch started" is the
 * queue wait and "fetch started → response end" is network plus server. The fetch start comes from Resource Timing
 * (the browser's own dispatch time), not from when our code called the action. A sampled share is beaconed to a route
 * that writes one structured log line (client_action.timing.v1), alongside the server_action.timing.v1 lines.
 */
export type ActionTiming = {
  action: string;
  route: string;
  queueMs: number | null;
  networkMs: number | null;
  totalMs: number;
  ok: boolean;
};

const ENDPOINT = "/api/telemetry/action-timing";
const BUFFER = 100;
const fetches: PerformanceResourceTiming[] = [];
let observing = false;

function observe() {
  if (observing || typeof PerformanceObserver === "undefined") return;
  observing = true;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
        if (entry.initiatorType !== "fetch" || entry.name.includes(ENDPOINT)) continue;
        fetches.push(entry);
        if (fetches.length > BUFFER) fetches.shift();
      }
    }).observe({ type: "resource", buffered: false });
  } catch {
    observing = false;
  }
}

/** The fetch that answered this call: same path, started after the call, ended last before it resolved. */
function matchFetch(path: string, invokedAt: number, resolvedAt: number): PerformanceResourceTiming | null {
  let best: PerformanceResourceTiming | null = null;
  for (const entry of fetches) {
    let entryPath: string;
    try { entryPath = new URL(entry.name).pathname; } catch { continue; }
    if (entryPath !== path || entry.startTime < invokedAt || entry.responseEnd > resolvedAt + 1) continue;
    if (!best || entry.responseEnd > best.responseEnd) best = entry;
  }
  return best;
}

function sampleRate(): number {
  const raw = Number(process.env.NEXT_PUBLIC_ACTION_TIMING_SAMPLE ?? "0.1");
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
}

export function reportActionTiming(timing: ActionTiming, random: () => number = Math.random) {
  try {
    if (random() >= sampleRate() || typeof navigator === "undefined" || !navigator.sendBeacon) return;
    navigator.sendBeacon(ENDPOINT, new Blob([JSON.stringify(timing)], { type: "application/json" }));
  } catch {
    // Telemetry never affects the read it measures.
  }
}

/** Wrap a client-side call (server action or fetch) so its queue wait and network time are reported. */
export function timeClientCall<A extends unknown[], R>(
  action: string,
  run: (...args: A) => Promise<R>,
  requestPath: () => string = () => window.location.pathname,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    if (typeof window === "undefined" || typeof performance === "undefined") return run(...args);
    observe();
    const path = requestPath();
    const invokedAt = performance.now();
    let ok = false;
    try {
      const result = await run(...args);
      ok = !(typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === false);
      return result;
    } finally {
      const resolvedAt = performance.now();
      // Resource entries are delivered asynchronously; read them on the next task.
      setTimeout(() => {
        const entry = matchFetch(path, invokedAt, resolvedAt);
        reportActionTiming({
          action,
          route: window.location.pathname,
          queueMs: entry ? Math.round(entry.startTime - invokedAt) : null,
          networkMs: entry ? Math.round(entry.responseEnd - entry.startTime) : null,
          totalMs: Math.round(resolvedAt - invokedAt),
          ok,
        });
      }, 0);
    }
  };
}
