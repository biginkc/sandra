import "server-only";
import { randomUUID } from "node:crypto";

const STAGES = ["auth", "canonicalization", "list", "detail", "unknown", "queue", "queue_stats", "assignee", "mark_read"] as const;
type Stage = (typeof STAGES)[number];
type Span = { stage: Stage; durationMs: number | null; status: "pending" | "resolved" | "rejected" };
export type InboxTimingSummary = {
  event: "inbox.page.server_timing.v1";
  requestId: string;
  surface: "inbox" | "outbox" | "undetermined";
  totalMs: number | null;
  outcome: "returned" | "interrupted";
  spans: Span[];
};

type Options = {
  enabled?: boolean;
  now?: () => number;
  id?: () => string;
  emit?: (summary: InboxTimingSummary) => void;
};

/** Server completion only: excludes client rendering, paint and provider latency.
 * Rejected branches may leave siblings pending when Promise.all returns early.
 * Resolved means the promise resolved, not that a domain-level {ok:false} succeeded.
 */
export function createInboxServerTiming(options: Options = {}) {
  const noop = {
    measure: <T>(_stage: Stage, operation: () => Promise<T>): Promise<T> => operation(),
    setSurface: (surface: "inbox" | "outbox") => { void surface; },
    finish: (outcome: InboxTimingSummary["outcome"]) => { void outcome; },
  };
  if (!(options.enabled ?? process.env.INBOX_TIMING_ENABLED === "1")) return noop;
  const clock = options.now ?? (() => performance.now());
  const now = (): number | null => {
    try { const value = clock(); return Number.isFinite(value) ? value : null; }
    catch { return null; }
  };
  const elapsed = (start: number | null): number | null => {
    const end = now();
    return start === null || end === null ? null : Math.round(Math.max(0, end - start) * 100) / 100;
  };
  let requestId: string;
  try { requestId = (options.id ?? randomUUID)(); } catch { return noop; }
  const start = now();
  const spans = new Map<Stage, Span>();
  let finished = false;
  let surface: InboxTimingSummary["surface"] = "undetermined";
  return {
    setSurface(value: "inbox" | "outbox") { surface = value; },
    measure<T>(stage: Stage, operation: () => Promise<T>): Promise<T> {
      if (finished || spans.has(stage) || !STAGES.includes(stage)) return operation();
      const began = now();
      const span: Span = { stage, durationMs: null, status: "pending" };
      spans.set(stage, span);
      const settle = (status: "resolved" | "rejected") => {
        span.durationMs = elapsed(began);
        span.status = status;
      };
      try {
        return operation().then((result) => { settle("resolved"); return result; }, (error: unknown) => { settle("rejected"); throw error; });
      } catch (error) { settle("rejected"); throw error; }
    },
    finish(outcome: InboxTimingSummary["outcome"]) {
      if (finished) return;
      finished = true;
      try {
        const summary: InboxTimingSummary = {
          event: "inbox.page.server_timing.v1", requestId, surface, totalMs: elapsed(start), outcome,
          spans: [...spans.values()].map((span) => ({ ...span })),
        };
        (options.emit ?? ((value) => console.info(JSON.stringify(value))))(summary);
      } catch { /* Instrumentation must never affect page results or redirect errors. */ }
    },
  };
}
