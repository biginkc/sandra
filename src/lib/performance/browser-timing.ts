export type BrowserFlow = "messages.selection" | "messages.page" | "leads.page" | "leads.detail";
type Outcome = "completed" | "failed" | "cancelled";
const samples: Array<{ flow: BrowserFlow; stage: string; outcome: Outcome; durationMs: number; at: number; traceId?: string }> = [];
export function performanceSamples() { return samples.map((sample) => ({ ...sample })); }

/** Bounded, content-free local samples for the browser acceptance collector. */
export function beginBrowserTiming(flow: BrowserFlow) {
  const start = performance.now();
  let complete = false;
  return {
    finish(outcome: Outcome, traceId?: string) {
      if (complete) return;
      complete = true;
      const sample = { flow, stage: "usable_dom", outcome, durationMs: performance.now() - start, at: Date.now(),
        ...(/^[a-f0-9]{32}$/.test(traceId ?? "") ? { traceId } : {}),
      };
      samples.push(sample);
      if (samples.length > 500) samples.shift();
      // Custom event exposes only the validated sample, never target IDs/URLs.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("sandra:performance", { detail: sample }));
        if (process.env.NEXT_PUBLIC_SANDRA_PERFORMANCE_TELEMETRY === "1") {
          try { navigator.sendBeacon?.("/api/performance", new Blob([JSON.stringify(sample)], { type: "application/json" })); } catch { /* timing must never affect interaction */ }
        }
      }
    },
  };
}

let navigation: { url: string; timing: ReturnType<typeof beginBrowserTiming> } | null = null;
export function startNavigationTiming(url: string) {
  navigation?.timing.finish("cancelled");
  navigation = null;
  try {
    const target = new URL(url, window.location.href);
    const flow: BrowserFlow | null = target.pathname === "/messages" ? "messages.page" : target.pathname === "/leads" ? "leads.page" : /^\/leads\/[^/]+$/.test(target.pathname) ? "leads.detail" : null;
    if (flow) navigation = { url: target.pathname + target.search, timing: beginBrowserTiming(flow) };
  } catch { /* malformed navigation is not a successful timing sample */ }
}
export function finishNavigationTiming() {
  if (navigation?.url !== window.location.pathname + window.location.search) return;
  navigation.timing.finish("completed");
  navigation = null;
}
