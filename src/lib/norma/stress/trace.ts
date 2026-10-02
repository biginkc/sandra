/**
 * In-process execution trace. One global monotonic tick orders everything the
 * test code observes (operation start/end, fake-Bland sends, injected writes),
 * so invariants can reason about "before" and "after" without wall clocks.
 */
export type TraceEvent = { tick: number; actor: string; phase: "start" | "end" | "mark"; what: string; detail?: Record<string, unknown> };

export class Trace {
  private counter = 0;
  readonly events: TraceEvent[] = [];
  tick() {
    return ++this.counter;
  }
  add(actor: string, phase: TraceEvent["phase"], what: string, detail?: Record<string, unknown>) {
    const event: TraceEvent = { tick: this.tick(), actor, phase, what, detail };
    this.events.push(event);
    return event.tick;
  }
  /** Last N events, for failure messages. */
  tail(n = 60) {
    return this.events.slice(-n).map((e) => `${e.tick} ${e.actor} ${e.phase} ${e.what}${e.detail ? " " + JSON.stringify(e.detail) : ""}`);
  }
}

/** Deterministic PRNG (mulberry32). Seeds reproduce inputs, not DB scheduling. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p: number) => next() < p,
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    shuffle: <T,>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}
export type Rng = ReturnType<typeof rng>;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const jitter = (r: Rng, maxMs: number) => sleep(r.int(0, maxMs));

/** A latch several parties can wait on; used for explicit barriers. */
export class Latch {
  private release!: () => void;
  readonly promise = new Promise<void>((resolve) => (this.release = resolve));
  open() {
    this.release();
  }
}

/** All `parties` must arrive before any continues. */
export class Barrier {
  private arrived = 0;
  private readonly latch = new Latch();
  constructor(private readonly parties: number) {}
  async wait() {
    this.arrived += 1;
    if (this.arrived >= this.parties) this.latch.open();
    await this.latch.promise;
  }
}
