import { appendFileSync } from "node:fs";

/**
 * Request gates instead of sleeps. Every request that crosses a harness-controlled boundary (a
 * provider stub, or the gate proxy in front of the app) passes three named stages:
 *
 *   received          the boundary accepted the request
 *   provider_accepted the external action is durably recorded (stub log has it) but nothing has been answered yet
 *   response_sent     the response is about to be written back to the caller
 *
 * A scenario arms a gate ("hold request matching M at stage S"); the request parks at that stage until
 * released (or until the kill switch closes everything). The ACTUAL order of every stage is appended to
 * ordering.jsonl so a race reproduces from the same seed plus the recorded schedule.
 */

export type Stage = "received" | "provider_accepted" | "response_sent";
export const STAGES: readonly Stage[] = ["received", "provider_accepted", "response_sent"];

export type GateMatch = { source?: string; pathIncludes?: string; keyIncludes?: string };
export type GateMeta = { source: string; path: string; key?: string };

type Armed = { id: string; stage: Stage; match: GateMatch; held: Array<{ reqId: string; release: () => void }>; reached: Array<(reqId: string) => void>; once: boolean; hits: number };

export class GateController {
  private armed = new Map<string, Armed>();
  private seq = 0;
  private closed = false;
  readonly ordering: Array<{ n: number; t: number; reqId: string; stage: Stage; source: string; path: string; key?: string; note?: string }> = [];

  constructor(private readonly orderingFile?: string) {}

  /** Kill switch step 1: nothing is held any more and nothing new may be held; `isClosed()` callers refuse new provider traffic. */
  closeAll(): void {
    this.closed = true;
    for (const g of this.armed.values()) {
      for (const h of g.held.splice(0)) h.release();
    }
  }
  isClosed(): boolean {
    return this.closed;
  }

  arm(stage: Stage, match: GateMatch = {}, opts: { once?: boolean } = {}): string {
    const id = `g${(this.seq += 1)}`;
    this.armed.set(id, { id, stage, match, held: [], reached: [], once: opts.once ?? true, hits: 0 });
    return id;
  }

  /** Resolves with the request id once a request is parked at the gate (or immediately if one already is). */
  waitReached(gateId: string, timeoutMs: number): Promise<string> {
    const g = this.armed.get(gateId);
    if (!g) return Promise.reject(new Error(`unknown gate ${gateId}`));
    if (g.held[0]) return Promise.resolve(g.held[0].reqId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`gate ${gateId} (${g.stage}) not reached within ${timeoutMs}ms`)), timeoutMs);
      g.reached.push((reqId) => {
        clearTimeout(timer);
        resolve(reqId);
      });
    });
  }

  release(gateId: string): number {
    const g = this.armed.get(gateId);
    if (!g) return 0;
    const parked = g.held.splice(0);
    for (const h of parked) h.release();
    if (g.once) this.armed.delete(gateId);
    return parked.length;
  }

  /** Called by a boundary at each stage. Logs the ordering, then parks if an armed gate matches. */
  async reach(reqId: string, stage: Stage, meta: GateMeta, note?: string): Promise<void> {
    const entry = { n: this.ordering.length + 1, t: Date.now(), reqId, stage, source: meta.source, path: meta.path, key: meta.key, note };
    this.ordering.push(entry);
    if (this.orderingFile) appendFileSync(this.orderingFile, JSON.stringify(entry) + "\n");
    if (this.closed) return;
    for (const g of this.armed.values()) {
      if (g.stage !== stage || !matches(g.match, meta) || (g.once && g.hits > 0)) continue;
      g.hits += 1;
      await new Promise<void>((resolve) => {
        g.held.push({ reqId, release: resolve });
        for (const r of g.reached.splice(0)) r(reqId);
      });
      return;
    }
  }
}

function matches(m: GateMatch, meta: GateMeta): boolean {
  if (m.source && m.source !== meta.source) return false;
  if (m.pathIncludes && !meta.path.includes(m.pathIncludes)) return false;
  if (m.keyIncludes && !(meta.key ?? "").includes(m.keyIncludes)) return false;
  return true;
}

/** True when stage `a` was logged before stage `b` for the same request (used by tests and the report). */
export function orderedBefore(log: GateController["ordering"], reqId: string, a: Stage, b: Stage): boolean {
  const ia = log.findIndex((e) => e.reqId === reqId && e.stage === a);
  const ib = log.findIndex((e) => e.reqId === reqId && e.stage === b);
  return ia >= 0 && ib >= 0 && ia < ib;
}
