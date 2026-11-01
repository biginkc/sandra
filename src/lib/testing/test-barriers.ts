/**
 * Named test barriers (A-2 race analysis F6). In production every call is a no-op: it returns at
 * once unless NODE_ENV is "test" AND a test registered a handler for that point. Tests use them to
 * force one exact interleaving of concurrent requests (hold a request at a named point until
 * another one has done its part), so ordering is never left to sleeps or timing.
 */
export type TestBarrierName =
  | "webhook:inserted"
  | "webhook:before_stamp"
  | "dispatch:after_early_gate"
  | "dispatch:before_transition"
  | "outbox:presend_after_evidence"
  | "outbox:before_hold"
  | "outbox:before_fence"
  | "dispatch:after_decision"
  | "tick:after_send_check"
  | "claim:reclaim_after_read";

export type TestBarrierContext = { propertyId?: string | null; inboundMessageId?: string | null; enrollmentId?: string | null };
type Handler = (ctx: TestBarrierContext) => Promise<void> | void;

const handlers = new Map<TestBarrierName, Handler>();

export async function testBarrier(name: TestBarrierName, ctx: TestBarrierContext = {}): Promise<void> {
  if (process.env.NODE_ENV !== "test" || handlers.size === 0) return;
  const handler = handlers.get(name);
  if (handler) await handler(ctx);
}

/** Tests only. */
export function setTestBarrier(name: TestBarrierName, handler: Handler): void {
  if (process.env.NODE_ENV !== "test") throw new Error("test barriers are for tests only");
  handlers.set(name, handler);
}

export function clearTestBarriers(): void {
  handlers.clear();
  faults.clear();
}

/** Named one-shot test faults: a read that should fail once, at a named point (tests only). */
export type TestFaultName = "dispatch:v2_live_read";
const faults = new Map<TestFaultName, (ctx: TestBarrierContext) => boolean>();

/** True once when a test armed this fault and its predicate matches; always false outside tests. */
export function testFault(name: TestFaultName, ctx: TestBarrierContext = {}): boolean {
  if (process.env.NODE_ENV !== "test" || faults.size === 0) return false;
  const f = faults.get(name);
  if (!f || !f(ctx)) return false;
  faults.delete(name);
  return true;
}

/** Tests only. */
export function setTestFault(name: TestFaultName, match: (ctx: TestBarrierContext) => boolean = () => true): void {
  if (process.env.NODE_ENV !== "test") throw new Error("test faults are for tests only");
  faults.set(name, match);
}
