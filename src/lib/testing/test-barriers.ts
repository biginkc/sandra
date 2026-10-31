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
  | "tick:after_send_check";

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
}
