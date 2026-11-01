import { randomUUID } from "node:crypto";

/** No app imports here: loaded from vi.mock factories. */
export type WorkflowCall = { fn: (p: unknown) => Promise<unknown>; params: { inboundMessageId: string; propertyId: string } & Record<string, unknown> };
export const workflowSink: { onStart: ((c: WorkflowCall) => void) | null; realSleepMaxMs: number } = { onStart: null, realSleepMaxMs: 0 };
/** Workflow sleep duration -> ms ("30s", "2m", "500ms", number = ms). */
function durMs(d: unknown): number {
  if (typeof d === "number") return d;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(String(d ?? "").trim());
  if (!m) return 0;
  const n = Number(m[1]); const u = m[2] ?? "ms";
  return u === "h" ? n * 3_600_000 : u === "m" ? n * 60_000 : u === "s" ? n * 1000 : n;
}

export const workflowMocks = {
  api: async (importOriginal: () => Promise<Record<string, unknown>>) => ({
    ...(await importOriginal()),
    start: async (fn: WorkflowCall["fn"], args: [WorkflowCall["params"]]) => {
      workflowSink.onStart?.({ fn, params: args[0] });
      return { runId: `stress-${randomUUID()}` };
    },
  }),
  core: async (importOriginal: () => Promise<Record<string, unknown>>) => ({
    ...(await importOriginal()),
    // No-op by default; a lane that needs a real wait (e.g. the 30 s phone-action settle window) sets realSleepMaxMs.
    sleep: async (d: unknown) => { const ms = Math.min(durMs(d), workflowSink.realSleepMaxMs); if (ms > 0) await new Promise((r) => setTimeout(r, ms)); },
  }),
};

