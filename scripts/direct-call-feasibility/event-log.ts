 
// Run log of webhook/browser/stream events, with dedupe on event id.
import fs from "node:fs";
import path from "node:path";

export interface LoggedEvent {
  receivedAt: string;
  source: "webhook" | "browser" | "stream" | "harness";
  id?: string;
  type: string;
  callControlId?: string;
  data?: unknown;
}

export class EventLog {
  private events: LoggedEvent[] = [];
  private seen = new Set<string>();
  private waiters: { pred: (e: LoggedEvent) => boolean; resolve: (e: LoggedEvent) => void }[] = [];
  private file?: string;

  constructor(dir?: string) {
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      this.file = path.join(dir, "events.jsonl");
    }
  }

  /** Returns false if this event id was already seen. */
  append(e: Omit<LoggedEvent, "receivedAt">): boolean {
    if (e.id) {
      if (this.seen.has(e.id)) return false;
      this.seen.add(e.id);
    }
    const full: LoggedEvent = { receivedAt: new Date().toISOString(), ...e };
    this.events.push(full);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(full) + "\n");
    this.waiters = this.waiters.filter((w) => {
      if (w.pred(full)) {
        w.resolve(full);
        return false;
      }
      return true;
    });
    return true;
  }

  all(): LoggedEvent[] {
    return [...this.events];
  }
  find(pred: (e: LoggedEvent) => boolean): LoggedEvent | undefined {
    return this.events.find(pred);
  }

  waitFor(pred: (e: LoggedEvent) => boolean, timeoutMs: number): Promise<LoggedEvent | undefined> {
    const hit = this.events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const w = { pred, resolve: (e: LoggedEvent) => { clearTimeout(t); resolve(e); } };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        resolve(undefined);
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  hasHangup(callControlId: string): boolean {
    return !!this.find((e) => e.source === "webhook" && e.type === "call.hangup" && e.callControlId === callControlId);
  }
}
